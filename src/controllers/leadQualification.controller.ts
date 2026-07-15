import { Request, Response } from 'express';
import prisma from '../config/db.js';
import { activityService } from '../services/activity.service.js';
import { notificationService } from '../services/notification.service.js';
import { leadScoringService } from '../services/leadScoring.service.js';
import { leadReminderService } from '../services/leadReminder.service.js';
import { getSalesAuth, resolveTeamOwnerIds } from '../utils/salesAuth.js';

const INTERACTION_TYPES = ['Call', 'Email', 'Meeting'] as const;
const WON_STATUSES = ['won', 'converted', 'closed-won', 'closed_won'];

// ── Scoring Criteria (Admin) ─────────────────────────────────────────────────

/** GET /sales/scoring-criteria — all configured factors. */
export const getScoringCriteria = async (_req: Request, res: Response) => {
  try {
    const criteria = await leadScoringService.getCriteria();
    res.json(criteria);
  } catch (error) {
    console.error('Error fetching scoring criteria:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

/** Validates a weight: positive integer within a reasonable limit. */
const validateWeight = (weight: unknown): string | null => {
  const n = Number(weight);
  if (weight === undefined || weight === null || weight === '' || isNaN(n)) return 'Weight is required and must be a number.';
  if (n < 0) return 'Weight cannot be negative.';
  if (n <= 0) return 'Weight must be positive.';
  if (n > 100) return 'Weight must not exceed 100.';
  return null;
};

/** POST /sales/scoring-criteria — create a scoring factor. */
export const createScoringCriterion = async (req: Request, res: Response) => {
  try {
    const factor = String(req.body.factor || '').trim().toLowerCase().replace(/\s+/g, '_');
    const label = String(req.body.label || '').trim();
    const isActive = req.body.isActive === undefined ? true : Boolean(req.body.isActive);

    if (!factor) return res.status(400).json({ error: 'Factor key is required.' });
    if (!label) return res.status(400).json({ error: 'Factor label is required.' });
    const weightError = validateWeight(req.body.weight);
    if (weightError) return res.status(400).json({ error: weightError });

    const existing = await prisma.leadScoringCriterion.findUnique({ where: { factor } });
    if (existing) return res.status(409).json({ error: 'A criterion with this factor key already exists.' });

    const criterion = await prisma.leadScoringCriterion.create({
      data: { factor, label, weight: Math.round(Number(req.body.weight)), isActive },
    });
    // Keep stored scores in sync with the new criteria (background, non-blocking).
    void leadScoringService.recomputeAllOpenLeads();
    res.status(201).json(criterion);
  } catch (error) {
    console.error('Error creating scoring criterion:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

/** PUT /sales/scoring-criteria/:id — update label/weight/active. */
export const updateScoringCriterion = async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid criterion id' });

    const existing = await prisma.leadScoringCriterion.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: 'Criterion not found' });

    const data: any = {};
    if (req.body.label !== undefined) {
      const label = String(req.body.label).trim();
      if (!label) return res.status(400).json({ error: 'Factor label is required.' });
      data.label = label;
    }
    if (req.body.weight !== undefined) {
      const weightError = validateWeight(req.body.weight);
      if (weightError) return res.status(400).json({ error: weightError });
      data.weight = Math.round(Number(req.body.weight));
    }
    if (req.body.isActive !== undefined) data.isActive = Boolean(req.body.isActive);

    const criterion = await prisma.leadScoringCriterion.update({ where: { id }, data });
    void leadScoringService.recomputeAllOpenLeads();
    res.json(criterion);
  } catch (error) {
    console.error('Error updating scoring criterion:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

/** DELETE /sales/scoring-criteria/:id — remove a scoring factor. */
export const deleteScoringCriterion = async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid criterion id' });

    const existing = await prisma.leadScoringCriterion.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: 'Criterion not found' });

    await prisma.leadScoringCriterion.delete({ where: { id } });
    void leadScoringService.recomputeAllOpenLeads();
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting scoring criterion:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// ── Score breakdown ──────────────────────────────────────────────────────────

/** GET /sales/leads/:id/score-breakdown — score + rating + per-factor detail. */
export const getLeadScoreBreakdown = async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid lead id' });

    const lead = await prisma.lead.findUnique({ where: { id }, select: { id: true } });
    if (!lead) return res.status(404).json({ error: 'Lead not found' });

    const result = await leadScoringService.computeForLead(id);
    res.json(result);
  } catch (error) {
    console.error('Error computing score breakdown:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// ── Interactions ─────────────────────────────────────────────────────────────

/** GET /sales/leads/:id/interactions — interaction timeline (newest first). */
export const getLeadInteractions = async (req: Request, res: Response) => {
  try {
    const leadId = Number(req.params.id);
    if (isNaN(leadId)) return res.status(400).json({ error: 'Invalid lead id' });

    const interactions = await prisma.leadInteraction.findMany({
      where: { leadId },
      include: { author: { select: { id: true, name: true, email: true } } },
      orderBy: { interactionDate: 'desc' },
    });
    res.json(interactions);
  } catch (error) {
    console.error('Error fetching interactions:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

/** POST /sales/leads/:id/interactions — log a Call/Email/Meeting. */
export const createLeadInteraction = async (req: Request, res: Response) => {
  try {
    const leadId = Number(req.params.id);
    if (isNaN(leadId)) return res.status(400).json({ error: 'Invalid lead id' });

    const authorId = (req as any).userId;
    if (!authorId) return res.status(401).json({ error: 'Unauthorized' });

    const type = String(req.body.type || '').trim();
    const notes = typeof req.body.notes === 'string' ? req.body.notes.trim() : '';

    if (!(INTERACTION_TYPES as readonly string[]).includes(type)) {
      return res.status(400).json({ error: `Interaction type must be one of: ${INTERACTION_TYPES.join(', ')}.` });
    }
    if (!notes) return res.status(400).json({ error: 'Interaction notes cannot be empty.' });

    // Date defaults to now; reject future dates.
    let interactionDate = new Date();
    if (req.body.date) {
      const parsed = new Date(req.body.date);
      if (isNaN(parsed.getTime())) return res.status(400).json({ error: 'Invalid interaction date.' });
      if (parsed.getTime() > Date.now()) return res.status(400).json({ error: 'Interaction date cannot be in the future.' });
      interactionDate = parsed;
    }

    const lead = await prisma.lead.findUnique({
      where: { id: leadId },
      select: { id: true, title: true, ownerId: true, status: true, stage: true },
    });
    if (!lead) return res.status(404).json({ error: 'Lead not found' });

    const interaction = await prisma.leadInteraction.create({
      data: { leadId, authorId, type, notes, interactionDate },
      include: { author: { select: { id: true, name: true, email: true } } },
    });

    const actorName = interaction.author?.name || 'Someone';
    await activityService.logActivity({
      actorUserId: authorId,
      leadId,
      type: 'interaction_added',
      description: `${actorName} logged a ${type.toLowerCase()} interaction on "${lead.title}".`,
    });

    // Recalculate the score (interactions feed responsiveness/interaction/meeting factors).
    await leadScoringService.recomputeLeadScore(leadId);

    // Schedule a follow-up reminder based on the interaction (deduped, skipped if closed).
    await leadReminderService.scheduleFromInteraction({
      leadId,
      ownerId: lead.ownerId,
      interactionType: type,
      actorUserId: authorId,
      leadTitle: lead.title,
    });

    // Notify the owner if someone else logged the interaction.
    if (lead.ownerId && lead.ownerId !== authorId) {
      await notificationService.createNotification({
        userId: lead.ownerId,
        type: 'discussion',
        title: 'New interaction logged',
        message: `${actorName} logged a ${type.toLowerCase()} on "${lead.title}".`,
        entityType: 'lead',
        entityId: leadId,
      });
    }

    res.status(201).json(interaction);
  } catch (error) {
    console.error('Error creating interaction:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// ── Assignment ───────────────────────────────────────────────────────────────

/**
 * PUT /sales/leads/:id/assign — assign / reassign a lead to a BDE.
 * The assigned BDE becomes the lead owner. Creates the initial follow-up task
 * (once), moves pending reminders to the new owner, logs activity, notifies the
 * new owner, and recomputes the score.
 */
export const assignLead = async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid lead id' });

    const actorId = (req as any).userId;
    const newOwnerId = Number(req.body.ownerId);
    if (isNaN(newOwnerId)) return res.status(400).json({ error: 'A valid BDE (ownerId) is required.' });

    const lead = await prisma.lead.findUnique({
      where: { id },
      include: { owner: { select: { id: true, name: true } }, customer: { select: { company: true } } },
    });
    if (!lead) return res.status(404).json({ error: 'Lead not found' });

    const newOwner = await prisma.users.findUnique({ where: { id: newOwnerId }, select: { id: true, name: true } });
    if (!newOwner) return res.status(400).json({ error: 'Selected BDE does not exist.' });

    const isReassignment = lead.ownerId !== newOwnerId;
    const actor = await prisma.users.findUnique({ where: { id: actorId }, select: { name: true } });
    const actorName = actor?.name || 'Someone';
    const label = lead.customer?.company || lead.title;

    if (isReassignment) {
      await prisma.lead.update({ where: { id }, data: { ownerId: newOwnerId } });

      await activityService.logActivity({
        actorUserId: actorId,
        leadId: id,
        type: lead.ownerId ? 'lead_reassigned' : 'lead_assigned',
        description: `${actorName} assigned lead "${label}" to ${newOwner.name}.`,
      });

      // Move pending reminders to the new owner (no duplicate initial task).
      await leadReminderService.reassignReminders(id, newOwnerId);

      if (newOwnerId !== actorId) {
        await notificationService.createNotification({
          userId: newOwnerId,
          type: 'reassignment',
          title: 'Lead assigned to you',
          message: `${actorName} assigned the lead "${label}" to you.`,
          entityType: 'lead',
          entityId: id,
        });
      }
    }

    // Create the single initial follow-up task (deduped; skipped if it exists).
    await leadReminderService.ensureInitialFollowUp({
      leadId: id,
      ownerId: newOwnerId,
      actorUserId: actorId,
      label,
    });

    // Refresh the stored score against the current criteria (no owner-derived
    // factor today, but keeps Lead.score consistent after assignment).
    await leadScoringService.recomputeLeadScore(id);

    const updated = await prisma.lead.findUnique({
      where: { id },
      include: { customer: true, owner: { select: { id: true, name: true, email: true } } },
    });
    res.json(updated);
  } catch (error) {
    console.error('Error assigning lead:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// ── Follow-ups / Reminders ───────────────────────────────────────────────────

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const endOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);

/**
 * GET /sales/follow-ups/my — the follow-ups the caller is AUTHORIZED to see,
 * bucketed into overdue / today / upcoming (+ recently completed). Scope follows
 * the standard Sales RBAC: Admin/Founder = all, a manager / team-lead = their
 * team, an individual BDE = their own.
 *
 * (Previously hard-coded to `ownerId = userId`, which blinded Managers/Directors/
 * Admin/Founder — who don't personally own leads — to every follow-up they were
 * authorised to see, leaving the Follow-up Center empty and hiding follow-ups
 * created on a team member's lead. resolveTeamOwnerIds restores the correct scope.)
 *
 * Also opportunistically scans for due/overdue reminders to emit notifications
 * for this user.
 */
export const getMyFollowUps = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    // Emit any pending due/overdue notifications for THIS user on load (personal).
    await leadReminderService.scanDueReminders(userId);

    // RBAC scope: null = all owners (Admin/Founder); otherwise the team set
    // (manager/lead) or [self] (BDE).
    const ctx = await getSalesAuth(req);
    const ownerIds = await resolveTeamOwnerIds(ctx);
    const ownerWhere = ownerIds === null
      ? {}
      : { ownerId: { in: ownerIds.length ? ownerIds : [userId] } };

    const followUpInclude = {
      lead: { select: { id: true, title: true, customer: { select: { company: true } } } },
      owner: { select: { id: true, name: true } },
    };

    const [followUps, completedList] = await Promise.all([
      prisma.followUp.findMany({
        where: { ...ownerWhere, status: 'pending' },
        include: followUpInclude,
        orderBy: { scheduledDate: 'asc' },
      }),
      prisma.followUp.findMany({
        where: { ...ownerWhere, status: 'completed' },
        include: followUpInclude,
        orderBy: { completedAt: 'desc' },
        take: 50,
      }),
    ]);

    const now = new Date();
    const todayStart = startOfDay(now);
    const todayEnd = endOfDay(now);

    const overdue: typeof followUps = [];
    const today: typeof followUps = [];
    const upcoming: typeof followUps = [];
    for (const fu of followUps) {
      const due = new Date(fu.scheduledDate);
      if (due < todayStart) overdue.push(fu);
      else if (due <= todayEnd) today.push(fu);
      else upcoming.push(fu);
    }

    res.json({
      counts: { overdue: overdue.length, today: today.length, upcoming: upcoming.length, completed: completedList.length },
      overdue,
      today,
      upcoming,
      completed: completedList,
    });
  } catch (error) {
    console.error('Error fetching follow-ups:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

/** PUT /sales/follow-ups/:id/complete — mark a reminder completed. */
export const completeFollowUp = async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid follow-up id' });

    const actorId = (req as any).userId;

    const existing = await prisma.followUp.findUnique({
      where: { id },
      include: { lead: { select: { title: true } } },
    });
    if (!existing) return res.status(404).json({ error: 'Follow-up not found' });

    // Authorization mirrors the READ scope (read == write): the owner — or a
    // caller whose RBAC scope covers the follow-up's owner (Admin/Founder = all,
    // manager/team-lead = their team) — may complete it. Uses getSalesAuth /
    // resolveTeamOwnerIds (the canonical isGlobalAdmin path) so EVERY admin
    // spelling works and managers can complete their team's follow-ups. The old
    // raw string match (['admin','super admin','sales manager']) wrongly blocked
    // a Founder whose role had no space ("SuperAdmin") and any other manager role.
    const ctx = await getSalesAuth(req);
    const ownerIds = await resolveTeamOwnerIds(ctx); // null = all owners
    const inScope = ownerIds === null || ownerIds.includes(existing.ownerId);
    if (existing.ownerId !== actorId && !inScope) {
      return res.status(403).json({ error: 'You can only complete your own follow-ups.' });
    }

    const prevStatus = existing.status;
    // Idempotent: completing an already-completed follow-up is a no-op (and is
    // not re-logged). Completed status always wins — it is never auto-reverted.
    if (prevStatus === 'completed') {
      return res.json(existing);
    }

    const followUp = await prisma.followUp.update({
      where: { id },
      data: { status: 'completed', completedAt: new Date() },
    });

    const actor = await prisma.users.findUnique({ where: { id: actorId }, select: { name: true } });
    // Audit trail: actor + timestamp (created_at) + follow-up id + prev→new status.
    await activityService.logActivity({
      actorUserId: actorId,
      leadId: existing.leadId ?? undefined,
      type: 'reminder_completed',
      description: `${actor?.name || 'Someone'} marked follow-up #${id} "${existing.title}" as Completed (${prevStatus} → completed)${existing.lead ? ` for "${existing.lead.title}"` : ''}.`,
    });

    res.json(followUp);
  } catch (error) {
    console.error('Error completing follow-up:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

/**
 * POST /sales/leads/:id/follow-ups — manually schedule a follow-up reminder for
 * a lead. Honours duplicate-prevention and the closed-lead rule.
 */
export const createManualFollowUp = async (req: Request, res: Response) => {
  try {
    const leadId = Number(req.params.id);
    if (isNaN(leadId)) return res.status(400).json({ error: 'Invalid lead id' });

    const actorId = (req as any).userId;
    const title = String(req.body.title || '').trim();
    const notes = typeof req.body.notes === 'string' ? req.body.notes.trim() : '';
    if (!title) return res.status(400).json({ error: 'A reminder title is required.' });
    if (!req.body.dueDate) return res.status(400).json({ error: 'A due date is required.' });

    const dueDate = new Date(req.body.dueDate);
    if (isNaN(dueDate.getTime())) return res.status(400).json({ error: 'Invalid due date.' });

    const lead = await prisma.lead.findUnique({ where: { id: leadId }, select: { id: true, ownerId: true, status: true, stage: true } });
    if (!lead) return res.status(404).json({ error: 'Lead not found' });

    const created = await leadReminderService.scheduleReminder({
      leadId,
      ownerId: lead.ownerId,
      type: 'manual',
      dueDate,
      title,
      notes,
      actorUserId: actorId,
    });

    if (!created) {
      return res.status(409).json({ error: 'A matching reminder already exists, or the lead is closed.' });
    }
    res.status(201).json(created);
  } catch (error) {
    console.error('Error creating manual follow-up:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// ── Analytics ────────────────────────────────────────────────────────────────

/**
 * GET /sales/leads/analytics/overview — qualification & follow-up analytics:
 * average score, leads per BDE, follow-up completion rate, interaction volume,
 * conversion rate.
 */
export const getLeadOverviewAnalytics = async (_req: Request, res: Response) => {
  try {
    const [scoreAgg, perOwner, statusGroup, followUps, interactionGroup, scores] = await Promise.all([
      prisma.lead.aggregate({ _avg: { score: true }, _count: { _all: true } }),
      prisma.lead.groupBy({ by: ['ownerId'], _count: { _all: true }, _avg: { score: true } }),
      prisma.lead.groupBy({ by: ['status'], _count: { _all: true } }),
      prisma.followUp.groupBy({ by: ['status'], _count: { _all: true } }),
      prisma.leadInteraction.groupBy({ by: ['type'], _count: { _all: true } }),
      prisma.lead.findMany({ select: { score: true, temperature: true } }),
    ]);

    // Score distribution by rating band (Hot ≥80, Warm ≥50, Cold ≥1, else Not Scored).
    const dist = { Hot: 0, Warm: 0, Cold: 0, 'Not Scored': 0 };
    for (const { score } of scores) {
      const s = Number(score) || 0;
      if (s >= 80) dist.Hot++;
      else if (s >= 50) dist.Warm++;
      else if (s >= 1) dist.Cold++;
      else dist['Not Scored']++;
    }
    const scoreDistribution = (['Hot', 'Warm', 'Cold', 'Not Scored'] as const).map((rating) => ({
      rating,
      count: dist[rating],
    }));

    // Lead Temperature distribution (COLD / WARM / HOT) — the classification that
    // replaces score in the Leads analytics.
    const tdist = { COLD: 0, WARM: 0, HOT: 0 };
    for (const { temperature } of scores) {
      const t = String(temperature || 'COLD').toUpperCase();
      if (t === 'HOT') tdist.HOT++;
      else if (t === 'WARM') tdist.WARM++;
      else tdist.COLD++;
    }
    const temperatureDistribution = (['HOT', 'WARM', 'COLD'] as const).map((temperature) => ({
      temperature,
      count: tdist[temperature],
    }));
    const hotLeads = tdist.HOT;

    // Leads per BDE (resolve names).
    const ownerIds = perOwner.map((o) => o.ownerId);
    const owners = ownerIds.length
      ? await prisma.users.findMany({ where: { id: { in: ownerIds } }, select: { id: true, name: true } })
      : [];
    const ownerName = (id: number) => owners.find((u) => u.id === id)?.name || `User #${id}`;
    const leadsPerBde = perOwner
      .map((o) => ({
        ownerId: o.ownerId,
        name: ownerName(o.ownerId),
        leads: o._count._all,
        avgScore: Math.round(o._avg.score || 0),
      }))
      .sort((a, b) => b.leads - a.leads);

    // Conversion rate.
    const totalLeads = scoreAgg._count._all || 0;
    const wonLeads = statusGroup
      .filter((s) => WON_STATUSES.includes(String(s.status).toLowerCase()))
      .reduce((sum, s) => sum + s._count._all, 0);
    const conversionRate = totalLeads > 0 ? Math.round((wonLeads / totalLeads) * 1000) / 10 : 0;

    // Follow-up completion rate.
    const followUpCounts = followUps.reduce<Record<string, number>>((acc, f) => {
      acc[f.status] = f._count._all;
      return acc;
    }, {});
    const totalFollowUps = Object.values(followUpCounts).reduce((a, b) => a + b, 0);
    const completedFollowUps = followUpCounts['completed'] || 0;
    const followUpCompletionRate = totalFollowUps > 0 ? Math.round((completedFollowUps / totalFollowUps) * 1000) / 10 : 0;

    // Interaction volume by type.
    const interactionVolume = interactionGroup.map((i) => ({ type: i.type, count: i._count._all }));
    const totalInteractions = interactionVolume.reduce((sum, i) => sum + i.count, 0);

    res.json({
      totalLeads,
      averageScore: Math.round(scoreAgg._avg.score || 0),
      conversionRate,
      wonLeads,
      followUp: {
        total: totalFollowUps,
        completed: completedFollowUps,
        pending: followUpCounts['pending'] || 0,
        completionRate: followUpCompletionRate,
      },
      interactions: { total: totalInteractions, byType: interactionVolume },
      leadsPerBde,
      scoreDistribution,
      temperatureDistribution,
      hotLeads,
    });
  } catch (error) {
    console.error('Error fetching overview analytics:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};
