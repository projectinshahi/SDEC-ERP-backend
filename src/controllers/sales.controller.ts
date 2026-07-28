import { Request, Response } from 'express';
import prisma from '../config/db.js';
import { activityService } from '../services/activity.service.js';
import { notificationService } from '../services/notification.service.js';
import { leadScoringService } from '../services/leadScoring.service.js';
import { leadReminderService } from '../services/leadReminder.service.js';
import { defaultProbabilityForStage } from '../services/dealEvent.service.js';
import { parseSpreadsheet } from '../utils/spreadsheet.js';
import { getSalesAuth, ownerScopeFilter, resolveReportScope } from '../utils/salesAuth.js';
import { getUsersForModule } from '../utils/userScope.js';
import {
  FALLBACK_LEAD_SOURCE,
  LEAD_SOURCES,
  normalizeLeadSource,
} from '../constants/leadSource.js';

// Lead statuses that count as a conversion / a loss for source reporting.
const WON_STATUSES = ['won', 'converted'];
const LOST_STATUSES = ['lost', 'closed-lost', 'closed_lost'];

const titleCase = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);

// ── Manual Lead Capture helpers ────────────────────────────────────────────

// Sources a manual capture may use (the New Lead modal). Must stay in sync with
// the frontend SELECTABLE_LEAD_SOURCES list. `import`/`manual` are system
// sources with their own workflows and are not hand-pickable here.
const MANUAL_LEAD_SOURCES = ['phone', 'email', 'website', 'whatsapp', 'meta_ads', 'referral', 'face_to_face', 'other'] as const;

/** Strip HTML tags and collapse whitespace to neutralise injected markup. */
const sanitize = (value: unknown): string => {
  if (typeof value !== 'string') return '';
  return value.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
};

/** Basic email-format check. */
const isValidEmail = (email: string): boolean =>
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

/** Lenient phone check: digits with optional +, spaces, dashes, parentheses. */
const isValidPhone = (phone: string): boolean => {
  if (!/^[+\d][\d\s().-]*$/.test(phone)) return false;
  const digits = phone.replace(/\D/g, '');
  return digits.length >= 7 && digits.length <= 15;
};

interface ManualLeadInput {
  name: string;
  email: string;
  phone: string;
  source: string;
  referralName?: string;
}

/**
 * Server-side validation shared by the validate + create endpoints. Returns the
 * list of human-readable errors (empty when the input is valid).
 */
const validateManualLead = (data: ManualLeadInput): string[] => {
  const errors: string[] = [];

  // Name validation: required, not numbers-only, must have at least one letter.
  if (!data.name) {
    errors.push('Lead Name is required.');
  } else {
    if (/^\d+$/.test(data.name)) errors.push('Lead Name cannot contain only numbers.');
    else if (!/[a-zA-Z]/.test(data.name)) errors.push('Lead Name must contain at least one letter.');
    if (data.name.length > 200) errors.push('Lead Name must be 200 characters or fewer.');
  }

  if (!data.email && !data.phone) errors.push('Email or Phone Number is required.');
  if (data.email && !isValidEmail(data.email)) errors.push('Please enter a valid email address.');
  if (data.phone && !isValidPhone(data.phone)) errors.push('Please enter a valid phone number.');
  if (!data.source) {
    errors.push('Lead Source is required.');
  } else if (data.source === 'referral') {
    if (!data.referralName || !data.referralName.trim()) {
      errors.push('Referral Name is required');
    } else if (data.referralName.length > 200) {
      errors.push('Referral Name must be 200 characters or fewer');
    }
  } else if (!(MANUAL_LEAD_SOURCES as readonly string[]).includes(data.source)) {
    errors.push(`Source must be one of: ${MANUAL_LEAD_SOURCES.join(', ')}.`);
  }
  return errors;
};

/**
 * Looks for an existing customer matching the given email/phone. Returns whether
 * a lead already exists for that contact (a true duplicate) plus a reusable
 * customer id when a matching customer exists but has no lead yet.
 */
const findContactMatch = async (
  email: string,
  phone: string,
): Promise<{ duplicate: boolean; reusableCustomerId: number | null }> => {
  const clauses: any[] = [];
  if (email) clauses.push({ email });
  if (phone) clauses.push({ phone });
  if (clauses.length === 0) return { duplicate: false, reusableCustomerId: null };

  const customers = await prisma.customer.findMany({
    where: { OR: clauses },
    select: { id: true, _count: { select: { leads: true } } },
    orderBy: { id: 'asc' },
  });

  const withLead = customers.find((c) => c._count.leads > 0);
  if (withLead) return { duplicate: true, reusableCustomerId: null };

  // A matching customer with no leads can be reused for the new lead.
  return { duplicate: false, reusableCustomerId: customers[0]?.id ?? null };
};

// Statuses that mean a lead has left the active pipeline.
const INACTIVE_LEAD_STATUSES = ['disqualified', 'converted', 'won', 'lost', 'closed'];
// Action-driven terminal statuses whose value is intentionally DECOUPLED from the
// pipeline stage (a converted lead keeps status "converted" while its stage stays
// where it was). Every other status is a lower-cased mirror of the stage — see the
// stage→status sync in moveLeadStage and updateLead.
const OFF_BOARD_STATUSES = ['converted', 'disqualified'];

/** Normalise a lead temperature to one of COLD / WARM / HOT (default COLD). */
const normalizeTemperature = (t: unknown): string => {
  const s = String(t ?? '').trim().toUpperCase();
  return s === 'HOT' || s === 'WARM' ? s : 'COLD';
};

export const getLeads = async (req: Request, res: Response) => {
  try {
    const {
      source, status, stage, ownerId, flaggedForReview, search,
      location, scoreMin, scoreMax, active, fromDate, toDate, temperature, district
    } = req.query;

    const where: any = {};

    // Date range filter
    if (typeof fromDate === 'string' && fromDate.trim()) {
      where.createdAt = { ...where.createdAt, gte: new Date(fromDate) };
    }
    if (typeof toDate === 'string' && toDate.trim()) {
      const to = new Date(toDate);
      to.setUTCHours(23, 59, 59, 999);
      where.createdAt = { ...where.createdAt, lte: to };
    }

    // Source-based filtering (Website / Phone / Email / Imported leads, etc.)
    if (typeof source === 'string' && source.trim() && source !== 'all') {
      where.source = source.trim().toLowerCase();
    }
    if (typeof status === 'string' && status.trim() && status !== 'all') {
      where.status = status.trim().toLowerCase();
    }
    // Active-only view (pipeline board / dashboards) hides disqualified/converted/closed.
    if (active === 'true') {
      where.status = { notIn: INACTIVE_LEAD_STATUSES };
    }
    // Pipeline stage filter (board / list). Stored with original casing.
    if (typeof stage === 'string' && stage.trim() && stage !== 'all') {
      where.stage = stage.trim();
    }
    if (typeof ownerId === 'string' && ownerId.trim() && ownerId !== 'all') {
      const owner = Number(ownerId);
      if (!isNaN(owner)) where.ownerId = owner;
    }
    // Score range filter.
    const min = Number(scoreMin);
    const max = Number(scoreMax);
    if ((scoreMin !== undefined && !isNaN(min)) || (scoreMax !== undefined && !isNaN(max))) {
      where.score = {};
      if (!isNaN(min)) where.score.gte = min;
      if (!isNaN(max)) where.score.lte = max;
    }
    // Lead temperature filter (COLD / WARM / HOT).
    if (typeof temperature === 'string' && temperature.trim() && temperature !== 'all') {
      where.temperature = temperature.trim().toUpperCase();
    }
    // District filter. Accepts one district or a comma-separated list, so the UI can
    // filter by several without a second query shape.
    if (typeof district === 'string' && district.trim() && district !== 'all') {
      const picked = district.split(',').map((d) => d.trim()).filter(Boolean);
      if (picked.length) where.district = picked.length === 1 ? picked[0] : { in: picked };
    }
    // Location filter (matched against the linked customer's address).
    if (typeof location === 'string' && location.trim()) {
      where.customer = { is: { address: { contains: location.trim(), mode: 'insensitive' } } };
    }
    if (flaggedForReview === 'true') where.flaggedForReview = true;
    // Search across lead name, company, email and phone.
    if (typeof search === 'string' && search.trim()) {
      const term = search.trim();
      where.OR = [
        { title: { contains: term, mode: 'insensitive' } },
        { customer: { is: { company: { contains: term, mode: 'insensitive' } } } },
        { customer: { is: { email: { contains: term, mode: 'insensitive' } } } },
        { customer: { is: { phone: { contains: term, mode: 'insensitive' } } } },
        { customer: { is: { name: { contains: term, mode: 'insensitive' } } } },
      ];
    }

    // RBAC data scoping: BDE = own, manager/lead = team, admin/unteamed = all.
    // Honours an explicit ?ownerId only when within the caller's scope.
    const ctx = await getSalesAuth(req);
    const scope = await ownerScopeFilter(ctx, typeof where.ownerId === 'number' ? where.ownerId : undefined);
    if (scope === undefined) delete where.ownerId;
    else where.ownerId = scope;

    const leads = await prisma.lead.findMany({
      where,
      include: {
        customer: true,
        owner: { select: { id: true, name: true, email: true } },
      },
      // Stage column then card order for stable board rendering.
      orderBy: [{ stage: 'asc' }, { orderIndex: 'asc' }, { updatedAt: 'desc' }],
    });
    res.json(leads);
  } catch (error) {
    console.error('Error fetching leads:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

export const getLeadById = async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid lead id' });

    const lead = await prisma.lead.findUnique({
      where: { id },
      include: {
        customer: true,
        companyRef: { select: { id: true, name: true, industry: true, website: true } },
        owner: { select: { id: true, name: true, email: true } },
        notes: {
          include: { author: { select: { id: true, name: true, email: true } } },
          orderBy: { createdAt: 'desc' },
        },
        activityLogs: {
          include: { actor: { select: { id: true, name: true } } },
          orderBy: { created_at: 'desc' },
        },
      },
    });

    if (!lead) return res.status(404).json({ error: 'Lead not found' });

    // RBAC visibility: BDE = own, manager/lead = team, admin/unteamed = all. Mirrors the
    // list scoping (getLeads) so a direct /leads/:id URL can't expose another owner's
    // opportunity. 404 (not 403) so out-of-scope ids don't leak existence.
    const ctx = await getSalesAuth(req);
    const scope = await ownerScopeFilter(ctx);
    const inScope = scope === undefined || (typeof scope === 'object' ? scope.in.includes(lead.ownerId) : scope === lead.ownerId);
    if (!inScope) return res.status(404).json({ error: 'Lead not found' });

    res.json(lead);
  } catch (error) {
    console.error('Error fetching lead:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

export const createLead = async (req: Request, res: Response) => {
  try {
    const { title, description, source, status, priority, customerId, companyId, temperature } = req.body;
    const ownerId = (req as any).userId;

    if (!title || !ownerId) {
      return res.status(400).json({ error: 'Title and owner are required' });
    }

    // Resolve the source. A provided value must be one of the controlled values;
    // a missing value falls back to "manual" and flags the lead for review so we
    // never persist a null/empty source.
    let resolvedSource = normalizeLeadSource(source);
    let sourceFallbackUsed = false;
    if (source !== undefined && source !== null && String(source).trim() !== '' && !resolvedSource) {
      return res.status(400).json({ error: `Invalid lead source. Allowed values: ${LEAD_SOURCES.join(', ')}` });
    }
    if (!resolvedSource) {
      resolvedSource = FALLBACK_LEAD_SOURCE;
      sourceFallbackUsed = true;
    }

    const lead = await prisma.lead.create({
      data: {
        title,
        description,
        source: resolvedSource,
        // Duplicate phone/email is allowed — a contact may have many independent
        // leads — so leads are no longer flagged for review on that basis.
        flaggedForReview: sourceFallbackUsed,
        status: status || 'new',
        priority: priority || 'medium',
        temperature: normalizeTemperature(temperature),
        customerId: customerId ?? null,
        // Pipeline (Opportunity) → Company link; optional (backward-compatible).
        companyId: companyId != null && companyId !== '' ? Number(companyId) : null,
        ownerId,
      },
    });

    // Activity logging: Lead Created + Source Assigned (+ duplicate flag if any).
    const actor = await prisma.users.findUnique({ where: { id: ownerId }, select: { name: true } });
    const actorName = actor?.name || 'Someone';

    await activityService.logActivity({
      actorUserId: ownerId,
      leadId: lead.id,
      type: 'lead_created',
      description: `${actorName} created lead "${lead.title}" with source "${titleCase(resolvedSource)}".`,
    });
    await activityService.logActivity({
      actorUserId: ownerId,
      leadId: lead.id,
      type: 'source_assigned',
      description: `Source "${titleCase(resolvedSource)}" assigned to lead "${lead.title}".`,
    });
    // Initial score on creation.
    await leadScoringService.recomputeLeadScore(lead.id);

    res.status(201).json(lead);
  } catch (error) {
    console.error('Error creating lead:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

export const updateLead = async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid lead id' });

    const actorId = (req as any).userId;
    const existing = await prisma.lead.findUnique({
      where: { id },
      include: { customer: true, owner: { select: { id: true, name: true } } },
    });
    if (!existing) return res.status(404).json({ error: 'Lead not found' });

    const {
      title, description, source, status, priority, customerId, companyId,
      stage, tags, ownerId, referralName, leadValue, temperature, district,
      // Contact fields (persisted on the linked Customer record).
      name, company, email, phone, website, industry, address, designation, whatsapp,
    } = req.body;

    const data: any = {};

    // ── Required-field validation ──────────────────────────────────────────
    if (title !== undefined) {
      const cleanTitle = sanitize(title);
      if (!cleanTitle) return res.status(400).json({ error: 'Lead name is required.' });
      data.title = cleanTitle;
    }
    if (description !== undefined) data.description = description;
    if (status !== undefined) data.status = status;
    if (priority !== undefined) data.priority = priority;
    if (customerId !== undefined) data.customerId = customerId;
    // Pipeline (Opportunity) → Company link; optional (backward-compatible).
    if (companyId !== undefined) data.companyId = companyId != null && companyId !== '' ? Number(companyId) : null;
    if (tags !== undefined) data.tags = sanitize(tags) || null;
    // District (CR-01) — optional; empty clears it.
    if (district !== undefined) data.district = sanitize(district) || null;
    // Lead value — numeric monetary value. Null / empty clears the field.
    if (leadValue !== undefined) {
      if (leadValue === null || leadValue === '') {
        data.leadValue = null;
      } else {
        const num = Number(leadValue);
        if (isNaN(num) || num < 0) return res.status(400).json({ error: 'Lead Value must be a valid positive number.' });
        data.leadValue = num;
      }
    }
    // Lead temperature (COLD / WARM / HOT) — user-editable classification.
    if (temperature !== undefined) data.temperature = normalizeTemperature(temperature);
    // NOTE: `score` is engine-computed (recomputed below), never set from the
    // request body — the scoring engine is the single source of truth.

    // ── Field-format validation for contact details ────────────────────────
    const cleanEmail = email !== undefined ? sanitize(email).toLowerCase() : undefined;
    const cleanPhone = phone !== undefined ? sanitize(phone) : undefined;
    if (cleanEmail && !isValidEmail(cleanEmail)) {
      return res.status(400).json({ error: 'Please enter a valid email address.' });
    }
    if (cleanPhone && !isValidPhone(cleanPhone)) {
      return res.status(400).json({ error: 'Please enter a valid phone number.' });
    }

    // ── Stage change (pipeline progression) ────────────────────────────────
    let stageChanged = false;
    if (stage !== undefined && stage !== null && String(stage).trim() !== '') {
      const cleanStage = sanitize(stage);
      const validStage = await prisma.leadStage.findUnique({ where: { name: cleanStage } });
      if (!validStage) {
        return res.status(400).json({ error: `Invalid stage "${cleanStage}".` });
      }
      if (cleanStage !== existing.stage) {
        data.stage = cleanStage;
        stageChanged = true;
        // Pipeline stage is the SINGLE SOURCE OF TRUTH for status (mirrors
        // moveLeadStage): sync status here so the Kanban board (stage), the table
        // and the details page (status) stay consistent when the stage is changed
        // via the Edit modal. Runs AFTER the `data.status = status` line above, so
        // stage wins over any explicit status in the same request. Skipped for
        // action-terminal leads (converted/disqualified) whose status is
        // intentionally decoupled from the stage.
        if (!OFF_BOARD_STATUSES.includes((existing.status || '').toLowerCase())) {
          data.status = cleanStage.toLowerCase();
        }
      }
    }

    // ── Owner reassignment ─────────────────────────────────────────────────
    let ownerChanged = false;
    let newOwnerName = '';
    if (ownerId !== undefined && ownerId !== null) {
      const newOwnerId = Number(ownerId);
      if (isNaN(newOwnerId)) return res.status(400).json({ error: 'Invalid owner.' });
      if (newOwnerId !== existing.ownerId) {
        const newOwner = await prisma.users.findUnique({ where: { id: newOwnerId }, select: { id: true, name: true } });
        if (!newOwner) return res.status(400).json({ error: 'Selected owner does not exist.' });
        data.ownerId = newOwnerId;
        ownerChanged = true;
        newOwnerName = newOwner.name;
      }
    }

    // ── Source change ──────────────────────────────────────────────────────
    let sourceChanged = false;
    let newSource = existing.source;
    if (source !== undefined && source !== null && String(source).trim() !== '') {
      const normalized = normalizeLeadSource(source);
      if (!normalized) {
        return res.status(400).json({ error: `Invalid lead source. Allowed values: ${LEAD_SOURCES.join(', ')}` });
      }
      if (normalized !== existing.source) {
        data.source = normalized;
        newSource = normalized;
        sourceChanged = true;
        // A real source has now been assigned; clear the review flag if it was only set for that reason.
        if (existing.source === FALLBACK_LEAD_SOURCE) data.flaggedForReview = false;
      }
    }

    if (newSource === 'referral') {
      if (referralName !== undefined) {
         const refName = sanitize(referralName);
         if (!refName) {
           return res.status(400).json({ error: 'Referral Name is required.' });
         }
         if (refName.length > 200) {
           return res.status(400).json({ error: 'Referral Name must be 200 characters or fewer.' });
         }
         data.referralName = refName;
      } else if (existing.source !== 'referral') {
         return res.status(400).json({ error: 'Referral Name is required when changing source to Referral.' });
      }
    } else {
      data.referralName = null;
    }

    // ── Contact details → linked Customer (create one if none exists) ───────
    const customerData: any = {};
    if (name !== undefined) { const v = sanitize(name); if (v) customerData.name = v; }
    if (company !== undefined) customerData.company = sanitize(company) || null;
    if (cleanEmail !== undefined) customerData.email = cleanEmail || null;
    if (cleanPhone !== undefined) customerData.phone = cleanPhone || null;
    if (website !== undefined) customerData.website = sanitize(website) || null;
    if (industry !== undefined) customerData.industry = sanitize(industry) || null;
    if (address !== undefined) customerData.address = sanitize(address) || null;
    if (designation !== undefined) customerData.designation = sanitize(designation) || null;
    if (whatsapp !== undefined) customerData.whatsapp = sanitize(whatsapp) || null;
    // Keep the contact linked to the same CRM company as the opportunity.
    if (companyId !== undefined) customerData.companyId = companyId != null && companyId !== '' ? Number(companyId) : null;

    if (Object.keys(customerData).length > 0) {
      if (existing.customerId) {
        await prisma.customer.update({ where: { id: existing.customerId }, data: customerData });
      } else {
        // No linked customer yet — create one to hold the contact details.
        const created = await prisma.customer.create({
          data: {
            name: customerData.name || existing.title,
            email: customerData.email ?? null,
            phone: customerData.phone ?? null,
            company: customerData.company ?? null,
            industry: customerData.industry ?? null,
            website: customerData.website ?? null,
            address: customerData.address ?? null,
            designation: customerData.designation ?? null,
            whatsapp: customerData.whatsapp ?? null,
            companyId: customerData.companyId ?? null,
            ownerId: existing.ownerId,
          },
        });
        data.customerId = created.id;
      }
    }

    // Last-write-wins: we always apply this update over any concurrent change.
    const lead = await prisma.lead.update({ where: { id }, data });

    if (actorId) {
      const actor = await prisma.users.findUnique({ where: { id: actorId }, select: { name: true } });
      const actorName = actor?.name || 'Someone';

      if (sourceChanged) {
        await activityService.logActivity({
          actorUserId: actorId,
          leadId: lead.id,
          type: 'source_updated',
          description: `${actorName} updated source of lead "${lead.title}" from "${titleCase(existing.source)}" to "${titleCase(lead.source)}".`,
        });
        if (lead.ownerId && lead.ownerId !== actorId) {
          await notificationService.createNotification({
            userId: lead.ownerId,
            type: 'status_change',
            title: 'Lead source updated',
            message: `${actorName} updated the source of "${lead.title}" from ${titleCase(existing.source)} to ${titleCase(lead.source)}.`,
            entityType: 'lead',
            entityId: lead.id,
          });
        }
      }

      if (stageChanged) {
        await activityService.logActivity({
          actorUserId: actorId,
          leadId: lead.id,
          type: 'stage_changed',
          description: `${actorName} moved lead "${lead.title}" from ${existing.stage} to ${lead.stage}.`,
        });
        if (lead.ownerId && lead.ownerId !== actorId) {
          await notificationService.createNotification({
            userId: lead.ownerId,
            type: 'status_change',
            title: 'Lead stage changed',
            message: `${actorName} moved "${lead.title}" from ${existing.stage} to ${lead.stage}.`,
            entityType: 'lead',
            entityId: lead.id,
          });
        }
      }

      if (ownerChanged) {
        await activityService.logActivity({
          actorUserId: actorId,
          leadId: lead.id,
          type: 'owner_changed',
          description: `${actorName} changed owner of lead "${lead.title}" from ${existing.owner?.name || 'Unassigned'} to ${newOwnerName}.`,
        });
        // Notify the new owner that a lead was assigned to them.
        if (lead.ownerId !== actorId) {
          await notificationService.createNotification({
            userId: lead.ownerId,
            type: 'reassignment',
            title: 'Lead assigned to you',
            message: `${actorName} assigned the lead "${lead.title}" to you.`,
            entityType: 'lead',
            entityId: lead.id,
          });
        }
      }

      await activityService.logActivity({
        actorUserId: actorId,
        leadId: lead.id,
        type: 'lead_updated',
        description: `${actorName} updated lead "${lead.title}".`,
      });
    }

    // Owner reassignment via edit: ensure the initial follow-up exists and move
    // pending reminders to the new owner (mirrors the dedicated assign flow).
    if (ownerChanged) {
      await leadReminderService.reassignReminders(lead.id, lead.ownerId);
      await leadReminderService.ensureInitialFollowUp({
        leadId: lead.id,
        ownerId: lead.ownerId,
        actorUserId: actorId,
      });
    }

    // Stage update is a reminder trigger — schedule a stage-appropriate reminder.
    if (stageChanged) {
      const isProposalStage = ['interested', 'negotiating', 'proposal'].includes(String(lead.stage).toLowerCase());
      await leadReminderService.scheduleReminder({
        leadId: lead.id,
        ownerId: lead.ownerId,
        type: isProposalStage ? 'proposal_review' : 'follow_up',
        dueDate: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000),
        title: `${isProposalStage ? 'Review proposal for' : 'Follow up on'} "${lead.title}" (${lead.stage})`,
        actorUserId: actorId,
      });
    }

    // Recompute the score — source/stage/interest/assignment changes all affect it.
    await leadScoringService.recomputeLeadScore(lead.id);

    const updated = await prisma.lead.findUnique({
      where: { id: lead.id },
      include: {
        customer: true,
        owner: { select: { id: true, name: true, email: true } },
      },
    });
    res.json(updated);
  } catch (error) {
    console.error('Error updating lead:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// ── Lead Stages ─────────────────────────────────────────────────────────────

/** GET /sales/lead-stages — the ordered pipeline stages (board columns). */
export const getLeadStages = async (_req: Request, res: Response) => {
  try {
    const stages = await prisma.leadStage.findMany({ orderBy: { orderIndex: 'asc' } });
    res.json(stages);
  } catch (error) {
    console.error('Error fetching lead stages:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

/**
 * PUT /sales/leads/:id/stage — move a lead to a different pipeline stage
 * (drag-and-drop). Persists the stage + ordering, logs the move and notifies
 * the owner. Invalid stages are rejected so the client can revert the card.
 */
/**
 * Permanently delete a lead and every record that depends on it.
 *
 * Route-gated by `sales.leads.delete` (403 for anyone without it). This project
 * provisions tables via raw SQL (no Prisma migrations), so we do NOT rely on
 * DB-level ON DELETE behaviour: each dependent row is removed — or unlinked, for
 * the audit trail and any converted deal — explicitly inside one transaction.
 * That leaves no orphaned records and removes the lead from the pipeline,
 * analytics and dashboards immediately (all of which read live from these tables).
 */
export const deleteLead = async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid lead id' });

    const actorId = (req as any).userId;
    const existing = await prisma.lead.findUnique({ where: { id }, select: { id: true, title: true } });
    if (!existing) return res.status(404).json({ error: 'Lead not found' });

    await prisma.$transaction(async (tx) => {
      // Preserve the audit trail + any converted deal by UNLINKING (SetNull
      // relations — these records outlive the lead).
      await tx.activity_logs.updateMany({ where: { lead_id: id }, data: { lead_id: null } });
      await tx.deal.updateMany({ where: { leadId: id }, data: { leadId: null } });

      // Document approvals tied to the lead (+ their history rows).
      const approvals = await tx.documentApproval.findMany({ where: { leadId: id }, select: { id: true } });
      if (approvals.length) {
        const approvalIds = approvals.map((a) => a.id);
        await tx.documentApprovalHistory.deleteMany({ where: { approvalId: { in: approvalIds } } });
        await tx.documentApproval.deleteMany({ where: { leadId: id } });
      }

      // Remaining lead-scoped children (tasks before the recurrence rules they
      // may reference).
      await tx.salesTask.deleteMany({ where: { leadId: id } });
      await tx.recurrenceRule.deleteMany({ where: { leadId: id } });
      await tx.followUp.deleteMany({ where: { leadId: id } });
      await tx.leadInteraction.deleteMany({ where: { leadId: id } });
      await tx.leadNote.deleteMany({ where: { leadId: id } });

      await tx.lead.delete({ where: { id } });
    });

    // Audit against the actor (the lead no longer exists to attach to).
    const actor = await prisma.users.findUnique({ where: { id: actorId }, select: { name: true } });
    await activityService.logActivity({
      actorUserId: actorId,
      type: 'lead_deleted',
      description: `${actor?.name || 'Someone'} deleted lead "${existing.title}".`,
    });

    return res.json({ success: true });
  } catch (error) {
    console.error('Error deleting lead:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

export const moveLeadStage = async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid lead id' });

    const actorId = (req as any).userId;
    const { stage, orderIndex, checklist, description: transitionNote } = req.body;

    // Stage Transition Dialog payload (all OPTIONAL in this version — no validation).
    const cleanChecklist = Array.isArray(checklist)
      ? checklist.filter((c: unknown): c is string => typeof c === 'string' && c.trim().length > 0).map((c) => c.trim())
      : [];
    const cleanNote = typeof transitionNote === 'string' ? transitionNote.trim() : '';

    const cleanStage = sanitize(stage);
    if (!cleanStage) return res.status(400).json({ error: 'A target stage is required.' });

    const validStage = await prisma.leadStage.findUnique({ where: { name: cleanStage } });
    if (!validStage) return res.status(400).json({ error: `Invalid stage "${cleanStage}".` });

    const existing = await prisma.lead.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: 'Lead not found' });

    // Pipeline stage is the SINGLE SOURCE OF TRUTH for the lead's status: moving a
    // card to a column syncs status to that stage, lower-cased to match the status
    // convention ("New"→"new", "Won"→"won", custom "Demo Scheduled"→"demo
    // scheduled"). Dynamic and custom-stage safe (no hardcoded names), so Lead
    // Details, the list status filter, conversion rate and every status-keyed
    // analytic stay consistent with the board after a drag-and-drop.
    const data: any = { stage: cleanStage, status: cleanStage.toLowerCase() };
    if (orderIndex !== undefined && !isNaN(Number(orderIndex))) {
      data.orderIndex = Math.round(Number(orderIndex));
    }

    const lead = await prisma.lead.update({ where: { id }, data });

    // Only log/notify when the stage actually changed.
    if (existing.stage !== cleanStage && actorId) {
      const actor = await prisma.users.findUnique({ where: { id: actorId }, select: { name: true } });
      const actorName = actor?.name || 'Someone';

      await activityService.logActivity({
        actorUserId: actorId,
        leadId: lead.id,
        type: 'stage_changed',
        description: `${actorName} moved lead "${lead.title}" from ${existing.stage} to ${cleanStage}.`,
        // Structured Stage Transition history (previous/new stage, checklist, note); the
        // actor + timestamp are the activity row's actor_user_id + created_at.
        metadata: {
          fromStage: existing.stage,
          toStage: cleanStage,
          checklist: cleanChecklist,
          note: cleanNote,
        },
      });

      if (lead.ownerId && lead.ownerId !== actorId) {
        await notificationService.createNotification({
          userId: lead.ownerId,
          type: 'status_change',
          title: 'Lead stage changed',
          message: `${actorName} moved "${lead.title}" from ${existing.stage} to ${cleanStage}.`,
          entityType: 'lead',
          entityId: lead.id,
        });
      }

      // Stage update triggers a follow-up reminder + score recompute.
      const isProposalStage = ['interested', 'negotiating', 'proposal'].includes(cleanStage.toLowerCase());
      await leadReminderService.scheduleReminder({
        leadId: lead.id,
        ownerId: lead.ownerId,
        type: isProposalStage ? 'proposal_review' : 'follow_up',
        dueDate: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000),
        title: `${isProposalStage ? 'Review proposal for' : 'Follow up on'} "${lead.title}" (${cleanStage})`,
        actorUserId: actorId,
      });
    }

    await leadScoringService.recomputeLeadScore(lead.id);

    res.json(lead);
  } catch (error) {
    console.error('Error moving lead stage:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// ── Lead Stage Management (board columns: add / rename / delete / reorder) ────

/**
 * Validates and normalises a stage name. `sanitize` already trims and collapses
 * whitespace, so a spaces-only name collapses to '' and is rejected here.
 */
const validateStageName = (raw: unknown): { name: string } | { error: string } => {
  const name = sanitize(raw);
  if (!name) return { error: 'Stage name cannot be empty.' };
  if (name.length > 100) return { error: 'Stage name must be 100 characters or fewer.' };
  return { name };
};

/** POST /sales/lead-stages — create a custom pipeline stage (appended last). */
export const createLeadStage = async (req: Request, res: Response) => {
  try {
    const v = validateStageName(req.body?.name);
    if ('error' in v) return res.status(400).json({ error: v.error });

    // Reject duplicates case-insensitively ("Won" vs "won").
    const dup = await prisma.leadStage.findFirst({
      where: { name: { equals: v.name, mode: 'insensitive' } },
    });
    if (dup) return res.status(409).json({ error: `A stage named "${v.name}" already exists.` });

    const max = await prisma.leadStage.aggregate({ _max: { orderIndex: true } });
    const orderIndex = (max._max.orderIndex ?? 0) + 1;

    const stage = await prisma.leadStage.create({
      data: { name: v.name, orderIndex, isDefault: false },
    });
    res.status(201).json(stage);
  } catch (error) {
    console.error('Error creating lead stage:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

/**
 * PUT /sales/lead-stages/:id — rename a stage. Because `Lead.stage` stores the
 * stage NAME (not an FK), the rename cascades to every lead in that stage inside
 * one transaction so no lead is stranded on a vanished column.
 */
export const updateLeadStage = async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid stage id' });

    const v = validateStageName(req.body?.name);
    if ('error' in v) return res.status(400).json({ error: v.error });

    const existing = await prisma.leadStage.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: 'Stage not found' });

    // Same name (incl. unchanged case) — nothing to do.
    if (existing.name === v.name) return res.json(existing);

    const dup = await prisma.leadStage.findFirst({
      where: { name: { equals: v.name, mode: 'insensitive' }, id: { not: id } },
    });
    if (dup) return res.status(409).json({ error: `A stage named "${v.name}" already exists.` });

    const [stage] = await prisma.$transaction([
      prisma.leadStage.update({ where: { id }, data: { name: v.name } }),
      prisma.lead.updateMany({ where: { stage: existing.name }, data: { stage: v.name } }),
    ]);
    res.json(stage);
  } catch (error) {
    console.error('Error updating lead stage:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

/**
 * DELETE /sales/lead-stages/:id — remove a stage. Any leads sitting in it are
 * relocated (to an optional `reassignTo` stage, else the first remaining stage)
 * so the pipeline never loses leads. The last remaining stage cannot be deleted.
 */
export const deleteLeadStage = async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid stage id' });

    const stages = await prisma.leadStage.findMany({ orderBy: { orderIndex: 'asc' } });
    const target = stages.find((s) => s.id === id);
    if (!target) return res.status(404).json({ error: 'Stage not found' });
    if (stages.length <= 1) {
      return res.status(400).json({ error: 'At least one pipeline stage is required.' });
    }

    // Decide where to relocate this stage's leads.
    const remaining = stages.filter((s) => s.id !== id);
    let fallback = remaining[0];
    const requested = req.body?.reassignTo;
    if (requested) {
      const match = remaining.find((s) => s.name.toLowerCase() === String(requested).toLowerCase());
      if (match) fallback = match;
    }

    await prisma.$transaction([
      prisma.lead.updateMany({ where: { stage: target.name }, data: { stage: fallback.name } }),
      prisma.leadStage.delete({ where: { id } }),
    ]);
    res.json({ success: true, reassignedTo: fallback.name });
  } catch (error) {
    console.error('Error deleting lead stage:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

/**
 * PUT /sales/lead-stages/reorder — persist a new column order. The body must
 * list EVERY stage id exactly once; order_index is rewritten 1..N to match.
 */
export const reorderLeadStages = async (req: Request, res: Response) => {
  try {
    const { orderedIds } = req.body;
    if (!Array.isArray(orderedIds) || orderedIds.length === 0) {
      return res.status(400).json({ error: 'orderedIds must be a non-empty array.' });
    }
    const ids = orderedIds.map(Number).filter((n) => !isNaN(n));
    const stages = await prisma.leadStage.findMany();

    // The payload must reference exactly the existing stages, once each.
    const uniqueIds = new Set(ids);
    if (
      ids.length !== stages.length ||
      uniqueIds.size !== stages.length ||
      !stages.every((s) => uniqueIds.has(s.id))
    ) {
      return res.status(400).json({ error: 'orderedIds must include every stage exactly once.' });
    }

    await prisma.$transaction(
      ids.map((sid, index) =>
        prisma.leadStage.update({ where: { id: sid }, data: { orderIndex: index + 1 } }),
      ),
    );
    const updated = await prisma.leadStage.findMany({ orderBy: { orderIndex: 'asc' } });
    res.json(updated);
  } catch (error) {
    console.error('Error reordering lead stages:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// ── Lead Notes ──────────────────────────────────────────────────────────────

/** GET /sales/leads/:id/notes — notes timeline for a lead (newest first). */
export const getLeadNotes = async (req: Request, res: Response) => {
  try {
    const leadId = Number(req.params.id);
    if (isNaN(leadId)) return res.status(400).json({ error: 'Invalid lead id' });

    const notes = await prisma.leadNote.findMany({
      where: { leadId },
      include: { author: { select: { id: true, name: true, email: true } } },
      orderBy: { createdAt: 'desc' },
    });
    res.json(notes);
  } catch (error) {
    console.error('Error fetching lead notes:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

/** POST /sales/leads/:id/notes — add a free-text note. Rejects empty content. */
export const createLeadNote = async (req: Request, res: Response) => {
  try {
    const leadId = Number(req.params.id);
    if (isNaN(leadId)) return res.status(400).json({ error: 'Invalid lead id' });

    const authorId = (req as any).userId;
    if (!authorId) return res.status(401).json({ error: 'Unauthorized' });

    // Preserve line breaks/long content; only reject empty / whitespace-only notes.
    const content = typeof req.body.content === 'string' ? req.body.content.trim() : '';
    if (!content) return res.status(400).json({ error: 'Note content cannot be empty.' });

    const lead = await prisma.lead.findUnique({ where: { id: leadId }, select: { id: true, title: true, ownerId: true } });
    if (!lead) return res.status(404).json({ error: 'Lead not found' });

    const note = await prisma.leadNote.create({
      data: { leadId, authorId, content },
      include: { author: { select: { id: true, name: true, email: true } } },
    });

    const actorName = note.author?.name || 'Someone';
    await activityService.logActivity({
      actorUserId: authorId,
      leadId,
      type: 'note_added',
      description: `${actorName} added a note to lead "${lead.title}".`,
    });

    // Notify the owner when someone else logs a note on their lead.
    if (lead.ownerId && lead.ownerId !== authorId) {
      await notificationService.createNotification({
        userId: lead.ownerId,
        type: 'discussion',
        title: 'New note on lead',
        message: `${actorName} added a note to "${lead.title}".`,
        entityType: 'lead',
        entityId: leadId,
      });
    }

    res.status(201).json(note);
  } catch (error) {
    console.error('Error creating lead note:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

/** PUT /sales/leads/:leadId/notes/:noteId — edit a note (author or admin). */
export const updateLeadNote = async (req: Request, res: Response) => {
  try {
    const noteId = Number(req.params.noteId);
    if (isNaN(noteId)) return res.status(400).json({ error: 'Invalid note id' });

    const actorId = (req as any).userId;
    const role = String((req as any).userRole || '').toLowerCase();

    const content = typeof req.body.content === 'string' ? req.body.content.trim() : '';
    if (!content) return res.status(400).json({ error: 'Note content cannot be empty.' });

    const existing = await prisma.leadNote.findUnique({ where: { id: noteId }, include: { lead: { select: { title: true } } } });
    if (!existing) return res.status(404).json({ error: 'Note not found' });

    const isAdmin = role.includes('admin');
    if (existing.authorId !== actorId && !isAdmin) {
      return res.status(403).json({ error: 'You can only edit your own notes.' });
    }

    const note = await prisma.leadNote.update({
      where: { id: noteId },
      data: { content },
      include: { author: { select: { id: true, name: true, email: true } } },
    });

    const actor = await prisma.users.findUnique({ where: { id: actorId }, select: { name: true } });
    await activityService.logActivity({
      actorUserId: actorId,
      leadId: existing.leadId,
      type: 'note_updated',
      description: `${actor?.name || 'Someone'} updated a note on lead "${existing.lead?.title || ''}".`,
    });

    res.json(note);
  } catch (error) {
    console.error('Error updating lead note:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

/** DELETE /sales/leads/:leadId/notes/:noteId — delete a note (author or admin). */
export const deleteLeadNote = async (req: Request, res: Response) => {
  try {
    const noteId = Number(req.params.noteId);
    if (isNaN(noteId)) return res.status(400).json({ error: 'Invalid note id' });

    const actorId = (req as any).userId;
    const role = String((req as any).userRole || '').toLowerCase();

    const existing = await prisma.leadNote.findUnique({ where: { id: noteId }, include: { lead: { select: { title: true } } } });
    if (!existing) return res.status(404).json({ error: 'Note not found' });

    const isAdmin = role.includes('admin');
    if (existing.authorId !== actorId && !isAdmin) {
      return res.status(403).json({ error: 'You can only delete your own notes.' });
    }

    await prisma.leadNote.delete({ where: { id: noteId } });

    const actor = await prisma.users.findUnique({ where: { id: actorId }, select: { name: true } });
    await activityService.logActivity({
      actorUserId: actorId,
      leadId: existing.leadId,
      type: 'note_deleted',
      description: `${actor?.name || 'Someone'} deleted a note on lead "${existing.lead?.title || ''}".`,
    });

    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting lead note:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// ── Pipeline / stage analytics ───────────────────────────────────────────────

/**
 * GET /sales/leads/analytics/stage — distribution of leads across the pipeline.
 * Returns every stage (including empty ones) in fixed order.
 */
export const getLeadStageAnalytics = async (req: Request, res: Response) => {
  try {
    // Scope: BDE = own, manager = team, Admin/Director = org-wide.
    const ctx = await getSalesAuth(req);
    const owners = await resolveReportScope(ctx); // null = org-wide
    const leadWhere: any = {};
    if (owners !== null) leadWhere.ownerId = { in: owners.length ? owners : [ctx.userId] };

    const [stages, grouped] = await Promise.all([
      prisma.leadStage.findMany({ orderBy: { orderIndex: 'asc' } }),
      prisma.lead.groupBy({ by: ['stage'], where: leadWhere, _count: { _all: true } }),
    ]);

    const counts: Record<string, number> = {};
    for (const row of grouped) counts[row.stage] = row._count._all;

    const total = grouped.reduce((sum, r) => sum + r._count._all, 0);
    const distribution = stages.map((s) => ({
      stage: s.name,
      orderIndex: s.orderIndex,
      count: counts[s.name] || 0,
      percentage: total > 0 ? Math.round(((counts[s.name] || 0) / total) * 1000) / 10 : 0,
    }));

    res.json({ totalLeads: total, stages: distribution });
  } catch (error) {
    console.error('Error fetching lead stage analytics:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

/**
 * GET /sales/assignable-users — active users a lead can be assigned to.
 * Lightweight list (id/name/email) gated on sales view so the owner dropdown
 * works without requiring the broader user.read permission.
 */
export const getAssignableUsers = async (_req: Request, res: Response) => {
  try {
    // Module-aware: only users who belong to the Sales module (a role granting a
    // sales.* permission; global admins included). Developers / QA / HR / Finance
    // never appear in Sales assignment dropdowns. See utils/userScope.
    res.json(await getUsersForModule('sales'));
  } catch (error) {
    console.error('Error fetching assignable users:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

/**
 * POST /sales/leads/validate
 *
 * Stateless server-side validation for the Manual Lead Capture form. Lets the
 * client surface errors before attempting to create a lead. Creates nothing.
 */
export const validateManualLeadHandler = async (req: Request, res: Response) => {
  try {
    const name = sanitize(req.body.name);
    const email = sanitize(req.body.email).toLowerCase();
    const phone = sanitize(req.body.phone);
    const source = sanitize(req.body.source).toLowerCase();

    const errors = validateManualLead({ name, email, phone, source });
    res.json({ valid: errors.length === 0, errors });
  } catch (error) {
    console.error('Error validating lead:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

/**
 * POST /sales/leads/check-duplicate
 *
 * Reports whether a lead already exists for the given email / phone so the
 * capture form can warn the user before submitting. Creates nothing.
 */
export const checkDuplicateLead = async (req: Request, res: Response) => {
  try {
    const email = sanitize(req.body.email).toLowerCase();
    const phone = sanitize(req.body.phone);

    if (!email && !phone) {
      return res.status(400).json({ error: 'Email or Phone Number is required.' });
    }

    const { duplicate } = await findContactMatch(email, phone);
    res.json({
      duplicate,
      message: duplicate ? 'A lead already exists with this email or phone number.' : null,
    });
  } catch (error) {
    console.error('Error checking duplicate lead:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

/**
 * POST /sales/leads/manual
 *
 * Manual Lead Capture: an authenticated Sales/Admin user records a lead that
 * arrived by phone or email. Validates and de-duplicates server-side, creates a
 * Customer (or reuses a matching one) plus the Lead, logs activity, and notifies
 * the relevant users. Nothing is persisted unless validation fully passes.
 */
export const createManualLead = async (req: Request, res: Response) => {
  try {
    const ownerId = (req as any).userId;
    if (!ownerId) return res.status(401).json({ error: 'Unauthorized' });

    // 1. Sanitise all inputs.
    const name = sanitize(req.body.name);
    const company = sanitize(req.body.company);
    const email = sanitize(req.body.email).toLowerCase();
    const phone = sanitize(req.body.phone);
    const source = sanitize(req.body.source).toLowerCase();
    // Preserve line breaks for notes (the generic sanitize collapses whitespace,
    // which would flatten a multi-line textarea). Strip tags + trim only.
    const notes = typeof req.body.notes === 'string' ? req.body.notes.replace(/<[^>]*>/g, '').trim() : '';
    const industry = sanitize(req.body.industry);
    const website = sanitize(req.body.website);
    const jobTitle = sanitize(req.body.jobTitle);
    // Contact designation (falls back to the legacy jobTitle) + WhatsApp + explicit
    // Opportunity Name (the lead title; falls back to the derived name — company below).
    const designation = sanitize(req.body.designation) || jobTitle;
    const whatsapp = sanitize(req.body.whatsapp);
    const opportunityName = sanitize(req.body.title);
    const address = sanitize(req.body.address);
    // Optional link to an existing / just-created normalized Company (CRM account).
    const linkedCompanyId = req.body.companyId != null && req.body.companyId !== '' ? Number(req.body.companyId) : null;
    const tags = sanitize(req.body.tags);
    const leadValue = sanitize(req.body.leadValue);
    const priority = sanitize(req.body.priority).toLowerCase() || 'medium';
    const referralName = sanitize(req.body.referralName);

    // Optional explicit owner for the new lead (defaults to the creator).
    const requestedOwnerId = Number(req.body.ownerId);
    const leadOwnerId = Number.isInteger(requestedOwnerId) && requestedOwnerId > 0 ? requestedOwnerId : ownerId;

    // 2. Validate (partial-save prevention — reject before any write).
    const errors = validateManualLead({ name, email, phone, source, referralName });

    // Additional field-level max-length checks.
    if (company && company.length > 200) errors.push('Company must be 200 characters or fewer.');
    if (industry && industry.length > 100) errors.push('Industry must be 100 characters or fewer.');
    if (website && website.length > 500) errors.push('Website must be 500 characters or fewer.');
    if (address && address.length > 500) errors.push('Location must be 500 characters or fewer.');
    if (notes && notes.length > 5000) errors.push('Notes must be 5000 characters or fewer.');
    if (leadValue && isNaN(Number(leadValue))) errors.push('Lead Value must be a valid number.');

    if (errors.length > 0) {
      return res.status(400).json({ error: errors[0], errors });
    }

    // 3. Duplicate phone/email is ALLOWED — a contact can have multiple
    // independent leads. We only reuse a matching customer that has NO lead yet;
    // a true duplicate (its customer already has a lead) yields reusableCustomerId
    // = null and falls through to a fresh customer below, so every lead stays
    // fully independent (its own customer, notes, follow-ups, deals and history).
    const { reusableCustomerId } = await findContactMatch(email, phone);

    // 4. Create or reuse the Customer that holds the contact details.
    let customerId: number;
    if (reusableCustomerId) {
      customerId = reusableCustomerId;
      await prisma.customer.update({
        where: { id: reusableCustomerId },
        data: {
          email: email || undefined,
          phone: phone || undefined,
          company: company || undefined,
          industry: industry || undefined,
          website: website || undefined,
          address: address || undefined,
          designation: designation || undefined,
          whatsapp: whatsapp || undefined,
          companyId: linkedCompanyId ?? undefined,
        },
      });
    } else {
      const customer = await prisma.customer.create({
        data: {
          name,
          email: email || null,
          phone: phone || null,
          company: company || null,
          industry: industry || null,
          website: website || null,
          address: address || null,
          designation: designation || null,
          whatsapp: whatsapp || null,
          companyId: linkedCompanyId,
          ownerId: leadOwnerId,
        },
      });
      customerId = customer.id;
    }

    // 5. Assemble the lead. Lead Value is stored in its own column.
    // Notes are mapped to description so they appear in the Edit Lead modal,
    // and also stored as a LeadNote (step 6b) for the history timeline.
    const extras: string[] = [];
    if (jobTitle) extras.push(`Job Title: ${jobTitle}`);
    if (notes) extras.push(notes);
    const description = extras.length ? extras.join('\n') : null;

    const leadTitle = opportunityName || (company ? `${name} — ${company}` : name);

    const lead = await prisma.lead.create({
      data: {
        title: leadTitle,
        description,
        source,
        referralName: source === 'referral' ? referralName : null,
        leadValue: leadValue ? Number(leadValue) : null,
        tags: tags || null,
        district: sanitize(req.body.district) || null,
        status: 'new',
        priority,
        temperature: normalizeTemperature(req.body.temperature),
        flaggedForReview: false,
        customerId,
        // Optional link to an existing / just-created normalized Company (CRM account).
        companyId: linkedCompanyId,
        ownerId: leadOwnerId,
      },
    });

    // 6. Activity logging.
    const actor = await prisma.users.findUnique({ where: { id: ownerId }, select: { name: true } });
    const actorName = actor?.name || 'Someone';

    await activityService.logActivity({
      actorUserId: ownerId,
      leadId: lead.id,
      type: 'lead_created',
      description: `${actorName} created lead "${lead.title}" with source "${titleCase(source)}".`,
    });
    await activityService.logActivity({
      actorUserId: ownerId,
      leadId: lead.id,
      type: 'source_assigned',
      description: `Source "${titleCase(source)}" assigned to lead "${lead.title}".`,
    });

    // 6b. Persist the creation note as an editable Lead Note so it appears in the
    // Notes section of the lead details page (and the unified history), not only
    // in the description.
    if (notes) {
      await prisma.leadNote.create({ data: { leadId: lead.id, authorId: ownerId, content: notes } });
      await activityService.logActivity({
        actorUserId: ownerId,
        leadId: lead.id,
        type: 'note_added',
        description: `${actorName} added a note to lead "${lead.title}".`,
      });
    }

    // 6c. Optionally create the first "next action" (a follow-up task) together
    // with the lead, so the owner has an immediate next step on the details page.
    // Skipped unless a title and a valid due date are supplied.
    const nextAction = req.body.nextAction;
    if (nextAction && typeof nextAction === 'object') {
      const naTitle = sanitize(nextAction.title);
      const naDue = nextAction.dueDate ? new Date(nextAction.dueDate) : null;
      if (naTitle && naDue && !isNaN(naDue.getTime())) {
        const naType = sanitize(nextAction.type).toLowerCase().replace(/\s+/g, '_') || 'follow_up';
        const requestedAssignee = Number(nextAction.assignedTo);
        const naOwnerId = Number.isInteger(requestedAssignee) && requestedAssignee > 0 ? requestedAssignee : leadOwnerId;
        const naPriority = sanitize(nextAction.priority).toLowerCase();
        const naDescription = sanitize(nextAction.description);
        const naNotes = [naPriority ? `Priority: ${titleCase(naPriority)}` : '', naDescription]
          .filter(Boolean)
          .join('\n\n') || null;
        await prisma.followUp.create({
          data: {
            title: naTitle,
            notes: naNotes,
            scheduledDate: naDue,
            status: 'pending',
            type: naType,
            leadId: lead.id,
            ownerId: naOwnerId,
          },
        });
        await activityService.logActivity({
          actorUserId: ownerId,
          leadId: lead.id,
          type: 'reminder_created',
          description: `${actorName} scheduled a ${naType.replace(/_/g, ' ')} next action "${naTitle}" for "${lead.title}".`,
        });
      }
    }

    // 7. Notify other Sales/Admin users that a new lead has entered the pipeline.
    const recipients = await prisma.users.findMany({
      where: {
        status: 'active',
        id: { not: ownerId },
        OR: [
          { role: { contains: 'admin', mode: 'insensitive' } },
          { role: { contains: 'sales', mode: 'insensitive' } },
        ],
      },
      select: { id: true },
    });
    if (recipients.length > 0) {
      await notificationService.createNotifications(
        recipients.map((u) => u.id),
        {
          type: 'assignment',
          title: 'New Lead Created',
          message: `${actorName} created lead "${lead.title}". Source: ${titleCase(source)}.`,
          entityType: 'lead',
          entityId: lead.id,
        },
      );
    }

    // 8. Initial score on creation.
    await leadScoringService.recomputeLeadScore(lead.id);

    // 9. Return the created lead with its relations so the client can render it.
    const created = await prisma.lead.findUnique({
      where: { id: lead.id },
      include: {
        customer: true,
        owner: { select: { id: true, name: true, email: true } },
      },
    });

    res.status(201).json(created);
  } catch (error) {
    console.error('Error creating manual lead:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// ── Bulk Import (preview, field mapping, validation, insert) ─────────────────

type ImportRow = Record<string, string>;
type ImportMapping = Partial<Record<
  | 'title' | 'name' | 'company' | 'email' | 'phone' | 'website' | 'description' | 'source' | 'status' | 'priority'
  // CRM import template fields:
  | 'salesperson' | 'expectedRevenue' | 'stage' | 'referralName',
  string
>>;

interface ResolvedImportRecord {
  rowNumber: number;
  title: string;
  name: string;
  company: string;
  email: string;
  phone: string;
  website: string;
  description: string;
  source: string;
  status: string;
  priority: string;
  // CRM template additions:
  salesperson: string;     // resolved owner name (or the raw cell when unmatched), for display
  ownerId: number | null;  // resolved Lead owner id (null → falls back to the importing user)
  expectedRevenue: string; // normalised numeric string ('' when not provided)
  stage: string;           // canonical pipeline stage name ('' when not provided)
  flagForReview: boolean;
  validity: 'valid' | 'invalid' | 'duplicate';
  error?: string;
  referralName?: string;
}

/**
 * Parses an "Expected Revenue" cell. Returns ok=false for a non-numeric value;
 * an empty cell is valid (the field is optional). Currency symbols and thousands
 * separators are stripped (e.g. "₹2,50,000" → "250000").
 */
const parseImportRevenue = (raw: string): { ok: boolean; value: string } => {
  if (!raw) return { ok: true, value: '' };
  const cleaned = raw.replace(/[₹$€£,\s]/g, '');
  if (cleaned === '' || isNaN(Number(cleaned))) return { ok: false, value: raw };
  return { ok: true, value: String(Number(cleaned)) };
};

/** Reads the value for a target field, honouring a header mapping then fallbacks. */
const pickField = (row: ImportRow, mapping: ImportMapping, target: keyof ImportMapping, fallbacks: string[]): string => {
  const mapped = mapping[target];
  if (mapped && row[mapped.toLowerCase()] !== undefined) return String(row[mapped.toLowerCase()] ?? '').trim();
  for (const f of fallbacks) {
    if (row[f] !== undefined && String(row[f]).trim()) return String(row[f]).trim();
  }
  return '';
};

/**
 * Resolves + validates every parsed row against the (optional) field mapping.
 * Detects format errors, missing required fields, and duplicates (within the
 * file and against existing customers). Pure read — performs no writes.
 */
const resolveImportRecords = async (
  headers: string[],
  rows: ImportRow[],
  mapping: ImportMapping,
): Promise<ResolvedImportRecord[]> => {
  const hasSourceColumn = headers.includes('source') || !!mapping.source;

  // Resolve lookups ONCE (not per row): the valid pipeline stages and the user
  // directory, so "Stage" maps to a real pipeline stage and "Salesperson" maps
  // to a real Lead owner.
  const [stageRows, userRows] = await Promise.all([
    prisma.leadStage.findMany({ select: { name: true } }),
    prisma.users.findMany({ select: { id: true, name: true, email: true } }),
  ]);
  const stageByName = new Map(stageRows.map((s) => [s.name.toLowerCase(), s.name]));
  const userByKey = new Map<string, { id: number; name: string }>();
  for (const u of userRows) {
    if (u.name) userByKey.set(u.name.toLowerCase(), { id: u.id, name: u.name });
    if (u.email) userByKey.set(u.email.toLowerCase(), { id: u.id, name: u.name });
  }

  const records: ResolvedImportRecord[] = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    // CRM import template columns. Each pickField honours an explicit mapping
    // first, then auto-detects the new headers (Opportunity / Contact Name /
    // Salesperson / Expected Revenue / Stage) and finally the legacy headers, so
    // both the new and old template formats import without manual mapping.
    const title = pickField(row, mapping, 'title', ['opportunity', 'title', 'name', 'contact name', 'company']);
    const name = pickField(row, mapping, 'name', ['contact name', 'contactname', 'contact person', 'name', 'company']);
    const email = pickField(row, mapping, 'email', ['email']).toLowerCase();
    const phone = pickField(row, mapping, 'phone', ['phone']);
    const company = pickField(row, mapping, 'company', ['company']);
    const website = pickField(row, mapping, 'website', ['website']);
    const description = pickField(row, mapping, 'description', ['description', 'notes']);
    const statusRaw = pickField(row, mapping, 'status', ['status']);
    const priorityRaw = pickField(row, mapping, 'priority', ['priority']);
    const salespersonRaw = pickField(row, mapping, 'salesperson', ['salesperson', 'sales person', 'sales rep', 'owner', 'assigned to', 'assignee']);
    const revenueRaw = pickField(row, mapping, 'expectedRevenue', ['expected revenue', 'expectedrevenue', 'expected deal value', 'estimated revenue', 'revenue', 'deal value', 'lead value', 'value', 'amount']);
    const stageRaw = pickField(row, mapping, 'stage', ['stage', 'pipeline stage', 'lead stage']);
    const referralName = pickField(row, mapping, 'referralName', ['referral name', 'referral', 'referralname', 'referrer']);

    // Source resolution: valid cell wins; unrecognised → manual + flag;
    // missing → import.
    let source: string;
    let flagForReview = false;
    const rawSource = hasSourceColumn ? pickField(row, mapping, 'source', ['source']) : '';
    if (rawSource) {
      const normalized = normalizeLeadSource(rawSource);
      if (normalized) source = normalized;
      else { source = FALLBACK_LEAD_SOURCE; flagForReview = true; }
    } else {
      source = 'import';
    }

    // Salesperson → Lead owner (exact name/email match; unmatched → importer).
    const resolvedOwner = salespersonRaw ? userByKey.get(salespersonRaw.toLowerCase()) : undefined;
    // Stage → existing pipeline stage (case-insensitive, canonicalised).
    const canonicalStage = stageRaw ? stageByName.get(stageRaw.toLowerCase()) : undefined;
    // Expected Revenue → numeric.
    const revenue = parseImportRevenue(revenueRaw);

    const rec: ResolvedImportRecord = {
      rowNumber: i + 2,
      title, name, company, email, phone, website, description, source,
      status: (statusRaw || 'new').toLowerCase(),
      priority: (priorityRaw || 'medium').toLowerCase(),
      salesperson: resolvedOwner?.name || salespersonRaw,
      ownerId: resolvedOwner?.id ?? null,
      expectedRevenue: revenue.value,
      stage: canonicalStage || '',
      flagForReview,
      validity: 'valid',
    };

    // Validation — required fields + format only. Duplicate phone/email is
    // ALLOWED, so duplicates are no longer marked or skipped; every valid row is
    // imported as an independent lead. One bad row never stops the others.
    if (!title) {
      rec.validity = 'invalid';
      rec.error = 'Missing required Opportunity';
    } else if (!name) {
      rec.validity = 'invalid';
      rec.error = 'Missing required Contact Name';
    } else if (email && !isValidEmail(email)) {
      rec.validity = 'invalid';
      rec.error = 'Invalid email format';
    } else if (phone && !isValidPhone(phone)) {
      rec.validity = 'invalid';
      rec.error = 'Invalid phone format';
    } else if (revenueRaw && !revenue.ok) {
      rec.validity = 'invalid';
      rec.error = 'Expected Revenue must be a number';
    } else if (stageRaw && !canonicalStage) {
      rec.validity = 'invalid';
      rec.error = `Unknown stage "${stageRaw}"`;
    }

    records.push(rec);
  }

  return records;
};

const summarise = (records: ResolvedImportRecord[]) => ({
  total: records.length,
  valid: records.filter((r) => r.validity === 'valid').length,
  invalid: records.filter((r) => r.validity === 'invalid').length,
  duplicate: records.filter((r) => r.validity === 'duplicate').length,
});

const parseMapping = (raw: unknown): ImportMapping => {
  if (!raw) return {};
  try {
    return typeof raw === 'string' ? JSON.parse(raw) : (raw as ImportMapping);
  } catch {
    return {};
  }
};

/**
 * POST /sales/leads/import/preview
 * Parses an uploaded file and returns headers, totals and a per-row validity
 * preview (valid / invalid / duplicate) WITHOUT importing anything.
 */
export const previewLeadImport = async (req: Request, res: Response) => {
  try {
    const file = (req as any).file;
    if (!file) return res.status(400).json({ error: 'No file uploaded. Expected a CSV or XLSX file in field "file".' });

    let parsed;
    try {
      parsed = await parseSpreadsheet(file.buffer, file.originalname, file.mimetype);
    } catch {
      return res.status(400).json({ error: 'Could not read the uploaded file. Please upload a valid CSV or XLSX file.' });
    }
    const { headers, rows } = parsed;
    if (rows.length === 0) return res.status(400).json({ error: 'The uploaded file contains no data rows.' });

    const mapping = parseMapping(req.body?.mapping);
    const records = await resolveImportRecords(headers, rows, mapping);

    res.json({
      headers,
      ...summarise(records),
      // Cap the row sample returned to the client.
      rows: records.slice(0, 100).map((r) => ({
        rowNumber: r.rowNumber,
        title: r.title,
        name: r.name,
        email: r.email,
        phone: r.phone,
        company: r.company,
        source: r.source,
        salesperson: r.salesperson,
        expectedRevenue: r.expectedRevenue,
        stage: r.stage,
        validity: r.validity,
        error: r.error ?? null,
      })),
    });
  } catch (error) {
    console.error('Error previewing import:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

/**
 * POST /sales/leads/import
 * Bulk-imports leads from a CSV/XLSX file. Honours an optional column `mapping`,
 * validates email/phone/required fields, skips duplicates, and returns a
 * detailed report (imported / skipped / duplicates / errors).
 */
export const importLeads = async (req: Request, res: Response) => {
  try {
    const ownerId = (req as any).userId;
    const file = (req as any).file;
    if (!file) return res.status(400).json({ error: 'No file uploaded. Expected a CSV or XLSX file in field "file".' });

    let parsed;
    try {
      parsed = await parseSpreadsheet(file.buffer, file.originalname, file.mimetype);
    } catch (parseError) {
      console.error('Error parsing import file:', parseError);
      return res.status(400).json({ error: 'Could not read the uploaded file. Please upload a valid CSV or XLSX file.' });
    }
    const { headers, rows } = parsed;
    if (rows.length === 0) return res.status(400).json({ error: 'The uploaded file contains no data rows.' });

    const mapping = parseMapping(req.body?.mapping);
    const records = await resolveImportRecords(headers, rows, mapping);

    const actor = await prisma.users.findUnique({ where: { id: ownerId }, select: { name: true } });
    const actorName = actor?.name || 'Someone';

    let imported = 0;
    let flagged = 0;
    let duplicates = 0;
    let skipped = 0;
    const errors: { row: number; error: string }[] = [];

    for (const rec of records) {
      if (rec.validity === 'duplicate') {
        duplicates++;
        continue;
      }
      if (rec.validity === 'invalid') {
        skipped++;
        errors.push({ row: rec.rowNumber, error: rec.error || 'Invalid row' });
        continue;
      }

      try {
        // Salesperson → Lead owner (falls back to the importing user when the
        // cell is blank or doesn't match a known user).
        const leadOwnerId = rec.ownerId ?? ownerId;

        // Persist contact details on a Customer. Contact Name is required, so a
        // customer is created for the contact person even with no email/phone.
        let customerId: number | undefined;
        if (rec.name || rec.email || rec.phone || rec.company) {
          const customer = await prisma.customer.create({
            data: {
              name: rec.name || rec.company || rec.title,
              email: rec.email || null,
              phone: rec.phone || null,
              company: rec.company || null,
              website: rec.website || null,
              ownerId: leadOwnerId,
            },
          });
          customerId = customer.id;
        }

        // Expected Revenue is now stored in the dedicated leadValue column.
        const description = rec.description || null;

        const lead = await prisma.lead.create({
          data: {
            title: rec.title,
            description,
            source: rec.source,
            flaggedForReview: rec.flagForReview,
            status: rec.status,
            priority: rec.priority,
            leadValue: rec.expectedRevenue ? Number(rec.expectedRevenue) : null,
            // Only set stage when the row supplied a valid one; otherwise the
            // Lead's default stage applies.
            ...(rec.stage ? { stage: rec.stage } : {}),
            customerId: customerId ?? null,
            ownerId: leadOwnerId,
          },
        });
        imported++;
        if (rec.flagForReview) flagged++;

        await activityService.logActivity({
          actorUserId: ownerId,
          leadId: lead.id,
          type: 'lead_created',
          description: `${actorName} imported lead "${lead.title}" with source "${titleCase(rec.source)}".`,
        });
        await leadScoringService.recomputeLeadScore(lead.id);
      } catch (rowError) {
        console.error(`Error importing lead row ${rec.rowNumber}:`, rowError);
        skipped++;
        errors.push({ row: rec.rowNumber, error: 'Failed to save' });
      }
    }

    res.status(201).json({
      total: records.length,
      imported,
      // `created`/`failed` kept for backwards compatibility with the old client.
      created: imported,
      failed: errors.length,
      skipped,
      duplicates,
      flagged,
      errors,
    });
  } catch (error) {
    console.error('Error importing leads:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

/**
 * Source analytics: total leads by source plus conversion/won/lost reporting.
 */
export const getLeadSourceAnalytics = async (req: Request, res: Response) => {
  try {
    // Scope: BDE = own, manager = team, Admin/Director = org-wide.
    const ctx = await getSalesAuth(req);
    const owners = await resolveReportScope(ctx); // null = org-wide
    const leadWhere: any = {};
    if (owners !== null) leadWhere.ownerId = { in: owners.length ? owners : [ctx.userId] };

    const grouped = await prisma.lead.groupBy({
      by: ['source', 'status'],
      where: leadWhere,
      _count: { _all: true },
    });

    // Build a per-source roll-up keyed by source value.
    const bySource: Record<string, { source: string; total: number; won: number; lost: number; conversionRate: number }> = {};

    for (const row of grouped) {
      const key = row.source || FALLBACK_LEAD_SOURCE;
      if (!bySource[key]) bySource[key] = { source: key, total: 0, won: 0, lost: 0, conversionRate: 0 };
      const count = row._count._all;
      bySource[key].total += count;
      if (WON_STATUSES.includes(row.status)) bySource[key].won += count;
      if (LOST_STATUSES.includes(row.status)) bySource[key].lost += count;
    }

    const sources = Object.values(bySource).map((s) => ({
      ...s,
      conversionRate: s.total > 0 ? Math.round((s.won / s.total) * 1000) / 10 : 0,
    }));

    const totalLeads = sources.reduce((sum, s) => sum + s.total, 0);
    const totalWon = sources.reduce((sum, s) => sum + s.won, 0);

    res.json({
      totalLeads,
      totalWon,
      overallConversionRate: totalLeads > 0 ? Math.round((totalWon / totalLeads) * 1000) / 10 : 0,
      sources: sources.sort((a, b) => b.total - a.total),
    });
  } catch (error) {
    console.error('Error fetching lead source analytics:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

export const getDeals = async (req: Request, res: Response) => {
  try {
    const { stage, ownerId, search } = req.query;
    const where: any = {};
    if (typeof stage === 'string' && stage.trim() && stage !== 'all') where.stage = stage.trim();
    if (typeof ownerId === 'string' && ownerId.trim() && ownerId !== 'all') {
      const owner = Number(ownerId);
      if (!isNaN(owner)) where.ownerId = owner;
    }
    if (typeof search === 'string' && search.trim()) {
      const term = search.trim();
      where.OR = [
        { title: { contains: term, mode: 'insensitive' } },
        { customer: { is: { company: { contains: term, mode: 'insensitive' } } } },
      ];
    }

    // RBAC data scoping: BDE = own, manager/lead = team, admin/unteamed = all.
    const ctx = await getSalesAuth(req);
    const scope = await ownerScopeFilter(ctx, typeof where.ownerId === 'number' ? where.ownerId : undefined);
    if (scope === undefined) delete where.ownerId;
    else where.ownerId = scope;

    const deals = await prisma.deal.findMany({
      where,
      include: {
        customer: true,
        owner: { select: { id: true, name: true, email: true } },
        opportunity: true,
        lead: { select: { id: true, title: true } },
      },
      orderBy: [{ stage: 'asc' }, { orderIndex: 'asc' }, { updatedAt: 'desc' }],
    });

    // SE-052.1 — attach linked-project status (Deal.projectId is an id-only link,
    // so batch-fetch the referenced projects). Lets the pipeline show post-sale
    // project status on each card without an N+1.
    const projectIds = Array.from(new Set(deals.map((d) => d.projectId).filter((p): p is string => !!p)));
    const projectMap = new Map<string, { id: string; name: string; status: string }>();
    if (projectIds.length) {
      const projects = await prisma.projects.findMany({
        where: { id: { in: projectIds } },
        select: { id: true, name: true, status: true },
      });
      for (const p of projects) projectMap.set(p.id, p);
    }
    const withProjects = deals.map((d) => ({ ...d, linkedProject: d.projectId ? projectMap.get(d.projectId) ?? null : null }));

    res.json(withProjects);
  } catch (error) {
    console.error('Error fetching deals:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

export const createDeal = async (req: Request, res: Response) => {
  try {
    const {
      title, amount, status, stage, customerId, opportunityId, ownerId: bodyOwnerId,
      currency, probability, expectedCloseDate, source, notes, description, products, services, competitors,
    } = req.body;
    // Bug fix: the auth middleware attaches `userId`, not `user`.
    const creatorId = (req as any).userId;

    if (!title || !customerId || !creatorId) {
      return res.status(400).json({ error: 'Title, customer, and owner are required' });
    }

    // Title validation: reject whitespace-only, numbers-only, symbols-only.
    const cleanTitle = String(title).replace(/\s+/g, ' ').trim();
    if (!cleanTitle) {
      return res.status(400).json({ error: 'Deal Name is required.' });
    }
    if (/^\d+$/.test(cleanTitle)) {
      return res.status(400).json({ error: 'Deal Name cannot contain only numbers.' });
    }
    if (!/[a-zA-Z]/.test(cleanTitle)) {
      return res.status(400).json({ error: 'Deal Name must contain at least one letter.' });
    }
    if (cleanTitle.length > 200) {
      return res.status(400).json({ error: 'Deal Name must be 200 characters or fewer.' });
    }

    // Notes / Description max-length.
    if (notes && String(notes).length > 5000) {
      return res.status(400).json({ error: 'Notes must be 5000 characters or fewer.' });
    }
    if (description && String(description).length > 10000) {
      return res.status(400).json({ error: 'Description must be 10000 characters or fewer.' });
    }

    // Deal value must be positive (SE-015.1 validation).
    const value = Number(amount);
    if (isNaN(value) || value <= 0) {
      return res.status(400).json({ error: 'Deal value must be greater than 0.' });
    }

    // Validate the stage when provided; probability follows the stage by default.
    let resolvedStage = 'Proposal Sent';
    if (stage) {
      const valid = await prisma.dealStage.findUnique({ where: { name: String(stage).trim() } });
      if (!valid) return res.status(400).json({ error: `Invalid deal stage "${stage}".` });
      resolvedStage = valid.name;
    }

    let resolvedProbability = defaultProbabilityForStage(resolvedStage);
    if (probability !== undefined) {
      const p = Number(probability);
      if (isNaN(p) || p < 0 || p > 100) return res.status(400).json({ error: 'Probability must be between 0 and 100.' });
      resolvedProbability = Math.round(p);
    }

    let closeDate: Date | null = null;
    if (expectedCloseDate) {
      const d = new Date(expectedCloseDate);
      if (isNaN(d.getTime())) return res.status(400).json({ error: 'Invalid expected close date.' });
      closeDate = d;
    }

    // Owner defaults to the creator; a Manager/Admin may assign someone else.
    let ownerId = creatorId;
    if (bodyOwnerId !== undefined && bodyOwnerId !== null && Number(bodyOwnerId) !== creatorId) {
      const owner = await prisma.users.findUnique({ where: { id: Number(bodyOwnerId) }, select: { id: true } });
      if (!owner) return res.status(400).json({ error: 'Selected owner does not exist.' });
      ownerId = owner.id;
    }

    const deal = await prisma.deal.create({
      data: {
        title: cleanTitle,
        amount: value,
        currency: currency ? String(currency).trim().toUpperCase() : 'INR',
        status: status || 'open',
        stage: resolvedStage,
        probability: resolvedProbability,
        expectedCloseDate: closeDate,
        source: source ? String(source).trim() : null,
        notes: notes ? String(notes) : null,
        description: description ? String(description) : null,
        products: products ? String(products) : null,
        services: services ? String(services) : null,
        competitors: competitors ? String(competitors) : null,
        customerId: Number(customerId),
        opportunityId: opportunityId ? Number(opportunityId) : null,
        ownerId,
      },
    });

    const actor = await prisma.users.findUnique({ where: { id: creatorId }, select: { name: true } });
    await activityService.logActivity({
      actorUserId: creatorId,
      dealId: deal.id,
      type: 'deal_created',
      description: `${actor?.name || 'Someone'} created deal "${deal.title}".`,
    });

    // Notify the owner when a deal is assigned to someone else on creation.
    if (ownerId !== creatorId) {
      await notificationService.createNotification({
        userId: ownerId, type: 'assignment', title: 'Deal assigned to you',
        message: `${actor?.name || 'Someone'} assigned the deal "${deal.title}" to you.`,
        entityType: 'deal', entityId: deal.id,
      });
    }

    res.status(201).json(deal);
  } catch (error) {
    console.error('Error creating deal:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

export const getCustomers = async (req: Request, res: Response) => {
  try {
    // RBAC data scoping: BDE = own contacts, manager = team, admin/unteamed = all.
    const ctx = await getSalesAuth(req);
    const scope = await ownerScopeFilter(ctx);
    const where: any = {};
    if (scope !== undefined) where.ownerId = scope;
    // Optional server-side search across the fields a user looks a contact up by.
    const q = String(req.query.q ?? '').trim();
    if (q) {
      where.OR = [
        { name: { contains: q, mode: 'insensitive' } },
        { email: { contains: q, mode: 'insensitive' } },
        { phone: { contains: q, mode: 'insensitive' } },
        { company: { contains: q, mode: 'insensitive' } },
        { companyRef: { name: { contains: q, mode: 'insensitive' } } },
      ];
    }

    const customers = await prisma.customer.findMany({
      where,
      include: {
        owner: { select: { id: true, name: true, email: true } },
        companyRef: { select: { id: true, name: true } },
      },
      orderBy: { name: 'asc' },
    });
    res.json(customers);
  } catch (error) {
    console.error('Error fetching customers:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

/**
 * GET /sales/customers/:id — a single contact with its owner and the leads &
 * deals associated to it (live data for the Contact Details page).
 */
export const getCustomerById = async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid contact id' });

    const customer = await prisma.customer.findUnique({
      where: { id },
      include: {
        owner: { select: { id: true, name: true, email: true } },
        companyRef: { select: { id: true, name: true, industry: true, website: true, address: true, gst: true } },
        leads: {
          select: { id: true, title: true, status: true, stage: true, temperature: true, createdAt: true },
          orderBy: { createdAt: 'desc' },
        },
        deals: {
          select: { id: true, title: true, amount: true, stage: true, status: true, createdAt: true },
          orderBy: { createdAt: 'desc' },
        },
      },
    });
    if (!customer) return res.status(404).json({ error: 'Contact not found' });

    res.json(customer);
  } catch (error) {
    console.error('Error fetching customer:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

export const createCustomer = async (req: Request, res: Response) => {
  try {
    const { name, email, phone, company, industry, website, address, companyId, designation, whatsapp } = req.body;
    // FIX: every other handler reads (req as any).userId — `user?.id` was undefined here,
    // so createCustomer always 400'd. Use the authenticated userId set by the middleware.
    const ownerId = Number((req as any).userId);

    if (!name || !ownerId) {
      return res.status(400).json({ error: 'Name and owner are required' });
    }

    const customer = await prisma.customer.create({
      data: {
        name,
        email: email ?? null,
        phone: phone ?? null,
        company: company ?? null,
        industry: industry ?? null,
        website: website ?? null,
        address: address ?? null,
        companyId: companyId != null && companyId !== '' ? Number(companyId) : null,
        designation: designation ?? null,
        whatsapp: whatsapp ?? null,
        ownerId,
      },
    });

    res.status(201).json(customer);
  } catch (error) {
    console.error('Error creating customer:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

/** PUT /sales/customers/:id — edit a Contact (name/contact fields + Company link). */
export const updateCustomer = async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid contact id' });
    const existing = await prisma.customer.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: 'Contact not found' });

    const { name, email, phone, company, industry, website, address, companyId, designation, whatsapp, status } = req.body;
    const data: any = {};
    if (name !== undefined) {
      if (!String(name).trim()) return res.status(400).json({ error: 'Name cannot be empty' });
      data.name = String(name).trim();
    }
    if (email !== undefined) data.email = email ?? null;
    if (phone !== undefined) data.phone = phone ?? null;
    if (company !== undefined) data.company = company ?? null;
    if (industry !== undefined) data.industry = industry ?? null;
    if (website !== undefined) data.website = website ?? null;
    if (address !== undefined) data.address = address ?? null;
    if (companyId !== undefined) data.companyId = companyId != null && companyId !== '' ? Number(companyId) : null;
    if (designation !== undefined) data.designation = designation ?? null;
    if (whatsapp !== undefined) data.whatsapp = whatsapp ?? null;
    if (status !== undefined) data.status = status || 'active';

    const customer = await prisma.customer.update({ where: { id }, data });
    res.json(customer);
  } catch (error) {
    console.error('Error updating customer:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

/** DELETE /sales/customers/:id — remove a Contact. Blocks (409) when it still has
 *  linked Pipeline/Deal records so revenue data is never orphaned (reassign first). */
export const deleteCustomer = async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid contact id' });
    const existing = await prisma.customer.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: 'Contact not found' });

    const [leadCount, dealCount] = await Promise.all([
      prisma.lead.count({ where: { customerId: id } }),
      prisma.deal.count({ where: { customerId: id } }),
    ]);
    if (leadCount > 0 || dealCount > 0) {
      return res.status(409).json({
        error: `This contact has ${leadCount} linked pipeline record(s) and ${dealCount} deal(s). Reassign or remove them before deleting the contact.`,
      });
    }
    // Nullable references (meetings/tickets carry an optional customer) are unlinked
    // in a transaction so the delete never fails on an FK, then the contact is removed.
    await prisma.$transaction([
      prisma.meeting.updateMany({ where: { customerId: id }, data: { customerId: null } }),
      prisma.ticket.updateMany({ where: { customerId: id }, data: { customerId: null } }),
      prisma.customer.delete({ where: { id } }),
    ]);
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting customer:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};
