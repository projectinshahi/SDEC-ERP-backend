import { Request, Response } from 'express';
import prisma from '../config/db.js';
import { isGlobalAdmin } from '../utils/roles.js';
import { activityService } from '../services/activity.service.js';
import { notificationService } from '../services/notification.service.js';

/**
 * Ticket Tracking controller — serves BOTH the Development and Sales modules from
 * one `tickets` table, differentiated by the `module` discriminator set per-route
 * (req.ticketModule). Reuses the shared notification + activity (audit) services.
 *
 * Visibility:
 *   • development — project-scoped (filtered by ?projectId), shared within a project.
 *   • sales       — a non-founder sees a ticket ONLY if they created it OR it is
 *                   assigned to them. Founders (Super Admin / Admin) see everything.
 *
 * The wire contract is snake_case (id, title, …, assigned_to, created_by,
 * project_id, …) to match the existing frontend `lib/api/tickets.ts`.
 */

type TicketModule = 'development' | 'sales';

const getModule = (req: Request): TicketModule =>
  ((req as any).ticketModule as TicketModule) || 'development';

const isFounder = (req: Request): boolean => isGlobalAdmin((req as any).userRole || '');

/** Relations included on list rows (light) and detail (adds attachments). */
const listInclude = {
  assignee: { select: { id: true, name: true, email: true } },
  creator: { select: { id: true, name: true, email: true } },
  lead: { select: { id: true, title: true } },
  deal: { select: { id: true, title: true } },
  customer: { select: { id: true, name: true } },
  team: { select: { id: true, name: true } },
} as const;

const detailInclude = {
  ...listInclude,
  attachments: {
    include: { uploader: { select: { id: true, name: true, email: true } } },
    orderBy: { uploaded_at: 'desc' as const },
  },
} as const;

/** Map a Prisma ticket (camelCase) to the snake_case wire shape. */
function serializeTicket(t: any) {
  return {
    id: t.id,
    title: t.title,
    description: t.description ?? null,
    status: t.status,
    priority: t.priority,
    module: t.module,
    category: t.category ?? null,
    source: t.source ?? null,
    project_id: t.projectId ?? null,
    lead_id: t.leadId ?? null,
    deal_id: t.dealId ?? null,
    customer_id: t.customerId ?? null,
    team_id: t.teamId ?? null,
    assigned_to: t.assignedTo ?? null,
    created_by: t.createdBy,
    due_date: t.dueDate ?? null,
    created_at: t.createdAt,
    updated_at: t.updatedAt,
    assignee: t.assignee ? { id: t.assignee.id, name: t.assignee.name, email: t.assignee.email } : null,
    creator: t.creator ? { id: t.creator.id, name: t.creator.name, email: t.creator.email } : null,
    lead: t.lead ? { id: t.lead.id, title: t.lead.title } : null,
    deal: t.deal ? { id: t.deal.id, title: t.deal.title } : null,
    customer: t.customer ? { id: t.customer.id, name: t.customer.name } : null,
    team: t.team ? { id: t.team.id, name: t.team.name } : null,
    attachments: Array.isArray(t.attachments)
      ? t.attachments.map((a: any) => ({
          id: a.id,
          ticket_id: a.ticket_id,
          file_name: a.file_name,
          file_url: a.file_url,
          file_size: a.file_size,
          description: a.description,
          uploaded_by: a.uploaded_by,
          uploaded_at: a.uploaded_at,
          uploader: a.uploader ? { id: a.uploader.id, name: a.uploader.name, email: a.uploader.email } : undefined,
        }))
      : undefined,
  };
}

/**
 * True if `userId` may view/act on a SALES ticket. Founders always pass;
 * everyone else only their own (created) or assigned tickets. Development
 * tickets are not gated here (project membership governs them upstream).
 */
export function canAccessSalesTicket(ticket: { module: string; createdBy: number; assignedTo: number | null }, userId: number, founder: boolean): boolean {
  if (ticket.module !== 'sales') return true;
  if (founder) return true;
  return ticket.createdBy === userId || ticket.assignedTo === userId;
}

const q = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

/** GET /tickets  or  /sales/tickets */
export const getTickets = async (req: Request, res: Response) => {
  try {
    const module = getModule(req);
    const userId = Number((req as any).userId);
    const founder = isFounder(req);

    const where: any = { module };

    if (module === 'development') {
      const projectId = q(req.query.projectId);
      if (projectId) where.projectId = projectId;
    } else {
      // Sales: a non-founder only sees tickets they created or are assigned.
      if (!founder) {
        where.OR = [{ createdBy: userId }, { assignedTo: userId }];
      }
      const leadId = parseInt(q(req.query.leadId));
      if (!isNaN(leadId)) where.leadId = leadId;
      const dealId = parseInt(q(req.query.dealId));
      if (!isNaN(dealId)) where.dealId = dealId;
    }

    const status = q(req.query.status);
    if (status && status !== 'ALL') where.status = status;
    const priority = q(req.query.priority);
    if (priority && priority !== 'ALL') where.priority = priority;
    const search = q(req.query.search);
    if (search) {
      const text = [
        { title: { contains: search, mode: 'insensitive' } },
        { description: { contains: search, mode: 'insensitive' } },
      ];
      // Combine the search OR with any existing scoping OR via AND.
      if (where.OR) {
        where.AND = [{ OR: where.OR }, { OR: text }];
        delete where.OR;
      } else {
        where.OR = text;
      }
    }

    const tickets = await prisma.ticket.findMany({
      where,
      include: listInclude,
      orderBy: { createdAt: 'desc' },
    });

    return res.status(200).json({ success: true, data: tickets.map(serializeTicket) });
  } catch (error) {
    console.error('Error fetching tickets:', error);
    return res.status(500).json({ success: false, message: 'Server error fetching tickets' });
  }
};

/** GET /tickets/:id */
export const getTicketById = async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id as string);
    if (isNaN(id)) return res.status(400).json({ success: false, message: 'Invalid ticket ID' });

    const ticket = await prisma.ticket.findUnique({ where: { id }, include: detailInclude });
    if (!ticket) return res.status(404).json({ success: false, message: 'Ticket not found' });

    const userId = Number((req as any).userId);
    if (!canAccessSalesTicket(ticket, userId, isFounder(req))) {
      return res.status(403).json({ success: false, message: 'Forbidden: you do not have access to this ticket' });
    }

    return res.status(200).json({ success: true, data: serializeTicket(ticket) });
  } catch (error) {
    console.error('Error fetching ticket:', error);
    return res.status(500).json({ success: false, message: 'Server error fetching ticket' });
  }
};

const toInt = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return isNaN(n) ? null : n;
};

/** POST /tickets  or  /sales/tickets */
export const createTicket = async (req: Request, res: Response) => {
  try {
    const module = getModule(req);
    const userId = Number((req as any).userId);
    const b = req.body || {};

    if (!b.title || !String(b.title).trim()) {
      return res.status(400).json({ success: false, message: 'Ticket title is required' });
    }

    // Development may set an explicit "Reported By"; Sales always uses the actor.
    const createdBy = module === 'development' ? (toInt(b.created_by) ?? userId) : userId;

    const ticket = await prisma.ticket.create({
      data: {
        title: String(b.title).slice(0, 255),
        description: b.description ?? null,
        status: b.status || 'open',
        priority: b.priority || 'medium',
        module,
        category: b.category ?? null,
        source: b.source ?? null,
        projectId: b.project_id ? String(b.project_id) : null,
        leadId: toInt(b.lead_id),
        dealId: toInt(b.deal_id),
        customerId: toInt(b.customer_id),
        teamId: toInt(b.team_id),
        assignedTo: toInt(b.assigned_to),
        createdBy,
        dueDate: b.due_date ? new Date(b.due_date) : null,
      },
      include: detailInclude,
    });

    await activityService.logActivity({
      actorUserId: userId,
      ticketId: ticket.id,
      projectId: ticket.projectId || undefined,
      leadId: ticket.leadId || undefined,
      dealId: ticket.dealId || undefined,
      type: 'ticket_created',
      description: `Created ${module} ticket: ${ticket.title}`,
    });

    if (ticket.assignedTo && ticket.assignedTo !== userId) {
      await notificationService.createNotification({
        userId: ticket.assignedTo,
        type: 'assignment',
        title: 'New Ticket Assigned',
        message: `You have been assigned the ticket: "${ticket.title}"`,
        entityType: 'ticket',
        entityId: ticket.id,
      });
    }

    return res.status(201).json({ success: true, data: serializeTicket(ticket) });
  } catch (error) {
    console.error('Error creating ticket:', error);
    return res.status(500).json({ success: false, message: 'Server error creating ticket' });
  }
};

/** PUT /tickets/:id */
export const updateTicket = async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id as string);
    if (isNaN(id)) return res.status(400).json({ success: false, message: 'Invalid ticket ID' });

    const existing = await prisma.ticket.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ success: false, message: 'Ticket not found' });

    const userId = Number((req as any).userId);
    const founder = isFounder(req);
    if (!canAccessSalesTicket(existing, userId, founder)) {
      return res.status(403).json({ success: false, message: 'Forbidden: you do not have access to this ticket' });
    }

    const b = req.body || {};
    const data: any = {};
    if (b.title !== undefined) data.title = String(b.title).slice(0, 255);
    if (b.description !== undefined) data.description = b.description;
    if (b.status !== undefined) data.status = b.status;
    if (b.priority !== undefined) data.priority = b.priority;
    if (b.category !== undefined) data.category = b.category;
    if (b.source !== undefined) data.source = b.source;
    if (b.assigned_to !== undefined) data.assignedTo = toInt(b.assigned_to);
    if (b.lead_id !== undefined) data.leadId = toInt(b.lead_id);
    if (b.deal_id !== undefined) data.dealId = toInt(b.deal_id);
    if (b.customer_id !== undefined) data.customerId = toInt(b.customer_id);
    if (b.team_id !== undefined) data.teamId = toInt(b.team_id);
    if (b.project_id !== undefined) data.projectId = b.project_id ? String(b.project_id) : null;
    if (b.due_date !== undefined) data.dueDate = b.due_date ? new Date(b.due_date) : null;

    const ticket = await prisma.ticket.update({ where: { id }, data, include: detailInclude });

    await activityService.logActivity({
      actorUserId: userId,
      ticketId: ticket.id,
      projectId: ticket.projectId || undefined,
      leadId: ticket.leadId || undefined,
      dealId: ticket.dealId || undefined,
      type: 'ticket_updated',
      description: `Updated ticket: ${ticket.title}`,
    });

    // Notify the (possibly new) assignee on reassignment.
    const newAssignee = ticket.assignedTo;
    if (newAssignee && newAssignee !== existing.assignedTo && newAssignee !== userId) {
      await notificationService.createNotification({
        userId: newAssignee,
        type: 'reassignment',
        title: 'Ticket Assigned',
        message: `You have been assigned the ticket: "${ticket.title}"`,
        entityType: 'ticket',
        entityId: ticket.id,
      });
    }
    // Notify creator + assignee on a status change (excluding the actor).
    if (b.status !== undefined && b.status !== existing.status) {
      const recipients = new Set<number>();
      if (ticket.createdBy !== userId) recipients.add(ticket.createdBy);
      if (ticket.assignedTo && ticket.assignedTo !== userId) recipients.add(ticket.assignedTo);
      await notificationService.createNotifications(Array.from(recipients), {
        type: 'status_change',
        title: 'Ticket Status Updated',
        message: `Ticket "${ticket.title}" is now ${ticket.status}`,
        entityType: 'ticket',
        entityId: ticket.id,
      });
    }

    return res.status(200).json({ success: true, data: serializeTicket(ticket) });
  } catch (error) {
    console.error('Error updating ticket:', error);
    return res.status(500).json({ success: false, message: 'Server error updating ticket' });
  }
};

/** DELETE /tickets/:id */
export const deleteTicket = async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id as string);
    if (isNaN(id)) return res.status(400).json({ success: false, message: 'Invalid ticket ID' });

    const existing = await prisma.ticket.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ success: false, message: 'Ticket not found' });

    const userId = Number((req as any).userId);
    const founder = isFounder(req);
    if (!canAccessSalesTicket(existing, userId, founder)) {
      return res.status(403).json({ success: false, message: 'Forbidden: you do not have access to this ticket' });
    }

    // Explicit child cleanup in a transaction (no orphans, regardless of DB FKs).
    await prisma.$transaction([
      prisma.activity_logs.updateMany({ where: { ticket_id: id }, data: { ticket_id: null } }),
      prisma.ticket_discussion_reads.deleteMany({ where: { ticket_id: id } }),
      prisma.ticket_discussions.deleteMany({ where: { ticket_id: id } }),
      prisma.ticket_attachments.deleteMany({ where: { ticket_id: id } }),
      prisma.ticket.delete({ where: { id } }),
    ]);

    await activityService.logActivity({
      actorUserId: userId,
      projectId: existing.projectId || undefined,
      leadId: existing.leadId || undefined,
      dealId: existing.dealId || undefined,
      type: 'ticket_deleted',
      description: `Deleted ticket: ${existing.title}`,
    });

    return res.status(200).json({ success: true, message: 'Ticket deleted successfully' });
  } catch (error) {
    console.error('Error deleting ticket:', error);
    return res.status(500).json({ success: false, message: 'Server error deleting ticket' });
  }
};
