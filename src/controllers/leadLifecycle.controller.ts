import { Request, Response } from 'express';
import prisma from '../config/db.js';
import { activityService } from '../services/activity.service.js';
import { notificationService } from '../services/notification.service.js';
import { CLOSED_STATES } from '../services/leadScoring.service.js';

const MIN_CALL_ATTEMPTS = 3;
const titleCase = (v: string) => v.charAt(0).toUpperCase() + v.slice(1);

// Accepted disqualification reasons (free-text also allowed, but these are the
// suggested standard set surfaced in the UI).
export const DISQUALIFY_REASONS = [
  'Not Interested', 'Budget Constraints', 'Competitor Selected', 'Invalid Contact', 'Duplicate Lead',
];

// ── SE-008.1 — Follow-up History Timeline ────────────────────────────────────

/**
 * GET /sales/leads/:id/history
 * Unified, newest-first timeline merging interactions (Call/Email/Meeting),
 * notes, follow-up tasks and reminder completions.
 */
export const getLeadHistory = async (req: Request, res: Response) => {
  try {
    const leadId = Number(req.params.id);
    if (isNaN(leadId)) return res.status(400).json({ error: 'Invalid lead id' });

    const [interactions, notes, followUps] = await Promise.all([
      prisma.leadInteraction.findMany({
        where: { leadId },
        include: { author: { select: { id: true, name: true } } },
      }),
      prisma.leadNote.findMany({
        where: { leadId },
        include: { author: { select: { id: true, name: true } } },
      }),
      prisma.followUp.findMany({
        where: { leadId },
        include: { owner: { select: { id: true, name: true } } },
      }),
    ]);

    type Entry = {
      kind: string;
      type: string;
      author: string | null;
      timestamp: string;
      notes: string | null;
    };
    const entries: Entry[] = [];

    for (const it of interactions) {
      entries.push({
        kind: 'interaction',
        type: it.type, // Call | Email | Meeting
        author: it.author?.name ?? null,
        timestamp: it.interactionDate.toISOString(),
        notes: it.notes,
      });
    }
    for (const n of notes) {
      entries.push({
        kind: 'note',
        type: 'Note',
        author: n.author?.name ?? null,
        timestamp: n.createdAt.toISOString(),
        notes: n.content,
      });
    }
    for (const fu of followUps) {
      entries.push({
        kind: 'follow_up',
        type: 'Follow-up Task',
        author: fu.owner?.name ?? null,
        timestamp: fu.createdAt.toISOString(),
        notes: fu.title,
      });
      if (fu.status === 'completed' && fu.completedAt) {
        entries.push({
          kind: 'reminder_completed',
          type: 'Reminder Completed',
          author: fu.owner?.name ?? null,
          timestamp: fu.completedAt.toISOString(),
          notes: fu.title,
        });
      }
    }

    entries.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
    res.json(entries);
  } catch (error) {
    console.error('Error building lead history:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// ── SE-009 — Disqualify Lead (with 3-call gate) ──────────────────────────────

/**
 * PUT /sales/leads/:id/disqualify
 * Requires a reason and at least 3 Call interactions. Sets status to
 * "disqualified", cancels pending reminders, logs activity and notifies owner.
 */
export const disqualifyLead = async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid lead id' });

    const actorId = (req as any).userId;
    const reason = typeof req.body.reason === 'string' ? req.body.reason.trim() : '';
    if (!reason) return res.status(400).json({ error: 'A disqualification reason is required.' });

    const lead = await prisma.lead.findUnique({ where: { id }, select: { id: true, title: true, status: true, ownerId: true } });
    if (!lead) return res.status(404).json({ error: 'Lead not found' });
    if (lead.status === 'disqualified') return res.status(409).json({ error: 'Lead is already disqualified.' });
    if (lead.status === 'converted') return res.status(409).json({ error: 'A converted lead cannot be disqualified.' });

    // Minimum 3 call attempts gate — count ONLY Call interactions.
    const callCount = await prisma.leadInteraction.count({ where: { leadId: id, type: 'Call' } });
    if (callCount < MIN_CALL_ATTEMPTS) {
      return res.status(400).json({
        error: `Cannot disqualify lead. Minimum ${MIN_CALL_ATTEMPTS} call attempts required.`,
        currentAttempts: callCount,
        requiredAttempts: MIN_CALL_ATTEMPTS,
      });
    }

    const updated = await prisma.lead.update({
      where: { id },
      data: { status: 'disqualified', disqualifyReason: reason },
    });

    // Remove from follow-up generation: cancel any pending reminders.
    await prisma.followUp.updateMany({
      where: { leadId: id, status: 'pending' },
      data: { status: 'cancelled' },
    });

    const actor = await prisma.users.findUnique({ where: { id: actorId }, select: { name: true } });
    const actorName = actor?.name || 'Someone';
    await activityService.logActivity({
      actorUserId: actorId,
      leadId: id,
      type: 'lead_disqualified',
      description: `${actorName} disqualified lead "${lead.title}". Reason: ${reason}.`,
    });

    if (lead.ownerId && lead.ownerId !== actorId) {
      await notificationService.createNotification({
        userId: lead.ownerId,
        type: 'status_change',
        title: 'Lead disqualified',
        message: `${actorName} disqualified "${lead.title}" (${reason}).`,
        entityType: 'lead',
        entityId: id,
      });
    }

    res.json(updated);
  } catch (error) {
    console.error('Error disqualifying lead:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// ── SE-010 — Convert Lead to Deal (with carry-over) ──────────────────────────

/**
 * POST /sales/leads/:id/convert
 * Creates a Deal from the lead, carrying over name/company/contact/owner/source/
 * notes/score (where available), links lead↔deal, sets lead status "converted".
 * Prevents double conversion and conversion of disqualified leads.
 */
export const convertLeadToDeal = async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid lead id' });

    const actorId = (req as any).userId;

    const lead = await prisma.lead.findUnique({
      where: { id },
      include: { customer: true, convertedDeal: { select: { id: true } } },
    });
    if (!lead) return res.status(404).json({ error: 'Lead not found' });
    if (lead.status === 'converted' || lead.convertedDeal) {
      return res.status(409).json({ error: 'Lead has already been converted to a deal.' });
    }
    if (lead.status === 'disqualified') {
      return res.status(400).json({ error: 'A disqualified lead cannot be converted.' });
    }

    // Carry over the contact onto a Customer (Deal requires one). Reuse the
    // lead's linked customer, or create one from the lead's data.
    let customerId = lead.customerId;
    if (!customerId) {
      const created = await prisma.customer.create({
        data: { name: lead.title, ownerId: lead.ownerId },
      });
      customerId = created.id;
      await prisma.lead.update({ where: { id }, data: { customerId } });
    }

    const amount = Number(req.body.amount) || 0;

    // Create the deal + flip the lead in one interactive transaction (the
    // interactive form keeps TS inference light vs. the array/tuple form).
    const dealId = await prisma.$transaction(async (tx) => {
      const created = await tx.deal.create({
        data: {
          title: lead.title,
          amount,
          currency: 'INR',
          status: 'open',
          stage: 'Proposal Sent',
          // Proposal Sent → 20% baseline win probability (SE-019.1).
          probability: 20,
          source: lead.source,
          notes: lead.description,
          leadId: lead.id,
          customerId,
          ownerId: lead.ownerId,
        },
      });
      await tx.lead.update({ where: { id }, data: { status: 'converted' } });
      // Converted leads no longer generate follow-ups; cancel pending ones.
      await tx.followUp.updateMany({ where: { leadId: id, status: 'pending' }, data: { status: 'cancelled' } });
      return created.id;
    });

    const deal = await prisma.deal.findUniqueOrThrow({
      where: { id: dealId },
      include: { customer: true, owner: { select: { id: true, name: true, email: true } } },
    });

    const actor = await prisma.users.findUnique({ where: { id: actorId }, select: { name: true } });
    const actorName = actor?.name || 'Someone';
    await activityService.logActivity({
      actorUserId: actorId,
      leadId: id,
      type: 'lead_converted',
      description: `${actorName} converted lead "${lead.title}" to a deal (Lead → Deal).`,
    });

    if (lead.ownerId && lead.ownerId !== actorId) {
      await notificationService.createNotification({
        userId: lead.ownerId,
        type: 'status_change',
        title: 'Lead converted to deal',
        message: `${actorName} converted "${lead.title}" into a deal.`,
        entityType: 'deal',
        entityId: deal.id,
      });
    }

    res.status(201).json(deal);
  } catch (error) {
    console.error('Error converting lead:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// ── SE-013 — Lead Aging ──────────────────────────────────────────────────────

const dayDiff = (from: Date) => Math.floor((Date.now() - from.getTime()) / (1000 * 60 * 60 * 24));

/**
 * GET /sales/leads/aging?days=N
 * Active leads (excluding converted/disqualified/closed) with no interaction
 * AND no follow-up activity for >= N days. Returns days-since-last-activity and
 * a risk flag.
 */
export const getLeadAging = async (req: Request, res: Response) => {
  try {
    const days = Math.max(1, Number(req.query.days) || 14);

    const leads = await prisma.lead.findMany({
      where: { status: { notIn: CLOSED_STATES }, stage: { notIn: CLOSED_STATES } },
      include: {
        owner: { select: { id: true, name: true } },
        customer: { select: { company: true } },
        interactions: { orderBy: { interactionDate: 'desc' }, take: 1, select: { interactionDate: true } },
        followUps: { orderBy: { updatedAt: 'desc' }, take: 1, select: { updatedAt: true, scheduledDate: true } },
      },
    });

    const aging = leads
      .map((lead) => {
        // Last activity = latest of: last interaction, last follow-up touch, lead creation.
        const stamps: number[] = [new Date(lead.createdAt).getTime()];
        if (lead.interactions[0]) stamps.push(new Date(lead.interactions[0].interactionDate).getTime());
        if (lead.followUps[0]) {
          stamps.push(new Date(lead.followUps[0].updatedAt).getTime());
          stamps.push(new Date(lead.followUps[0].scheduledDate).getTime());
        }
        const lastActivity = new Date(Math.max(...stamps));
        const daysSinceLastActivity = dayDiff(lastActivity);
        return { lead, lastActivity, daysSinceLastActivity };
      })
      .filter((r) => r.daysSinceLastActivity >= days)
      .map(({ lead, lastActivity, daysSinceLastActivity }) => {
        let flag: 'Needs Attention' | 'At Risk' | 'No Activity';
        if (daysSinceLastActivity >= days * 2) flag = 'No Activity';
        else if (daysSinceLastActivity >= days * 1.5) flag = 'At Risk';
        else flag = 'Needs Attention';
        return {
          id: lead.id,
          title: lead.title,
          company: lead.customer?.company ?? null,
          owner: lead.owner?.name ?? 'Unassigned',
          ownerId: lead.ownerId,
          stage: lead.stage,
          lastActivityAt: lastActivity.toISOString(),
          daysSinceLastActivity,
          flag,
        };
      })
      .sort((a, b) => b.daysSinceLastActivity - a.daysSinceLastActivity);

    res.json({ thresholdDays: days, count: aging.length, leads: aging });
  } catch (error) {
    console.error('Error computing lead aging:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// Deal stages & pipeline moves now live in deal.controller.ts (centralised so
// board moves and inline edits share one stage-transition path).

export { titleCase };
