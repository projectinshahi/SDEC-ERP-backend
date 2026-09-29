import type { Request, Response } from 'express';
import prisma from '../config/db.js';
import { getSalesAuth } from '../utils/salesAuth.js';
import { activityService } from '../services/activity.service.js';
import {
  resolveProject, canWriteEvents, canManageProjects, projectIdParam,
  PROJECT_VIEW_KEY,
} from '../services/marketingProject.service.js';
import { can } from '../utils/salesAuth.js';
import {
  validateEvent, ymdToDate, EVENT_TYPES, EVENT_TYPE_LABELS,
  type NormalisedEvent,
} from '../services/marketingEvent.service.js';

/**
 * MK-001 — Marketing project workspace: projects, and the per-project calendar.
 *
 * Every handler that touches project data goes through `resolveProject`, so the
 * project id in the URL is validated and authorized server-side on each call.
 * The board/calendar the frontend happens to be showing is never an input to
 * that decision.
 */

const uid = (req: Request) => Number((req as any).userId);
/** date-only column → 'YYYY-MM-DD'. @db.Date is UTC midnight, so slicing is safe
 *  and — unlike toLocaleDateString — cannot shift the day. */
const ymd = (d: Date | null): string | null => (d ? d.toISOString().slice(0, 10) : null);
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

const BAD_REFERENCE_MSG = 'A selected reference no longer exists — reload the page and choose again.';
const isBadReference = (e: unknown): boolean => (e as { code?: string } | null)?.code === 'P2003';
const isDuplicate = (e: unknown): boolean => (e as { code?: string } | null)?.code === 'P2002';

async function userNameMap(ids: (number | null)[]): Promise<Record<number, string>> {
  const unique = [...new Set(ids.filter((i): i is number => i != null))];
  if (!unique.length) return {};
  const users = await prisma.users.findMany({ where: { id: { in: unique } }, select: { id: true, name: true } });
  return Object.fromEntries(users.map((u) => [u.id, u.name]));
}

const serializeEvent = (row: any, names: Record<number, string>) => ({
  id: row.id,
  projectId: row.project_id,
  title: row.title,
  date: ymd(row.event_date),
  startTime: row.start_time,
  endTime: row.end_time,
  eventType: row.event_type,
  eventTypeLabel: row.event_type ? EVENT_TYPE_LABELS[row.event_type] ?? row.event_type : null,
  assigneeId: row.assignee_id,
  assigneeName: row.assignee_id ? names[row.assignee_id] ?? null : null,
  notes: row.notes,
  createdBy: row.created_by,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /marketing/projects — clients with their projects, for the switcher
// ─────────────────────────────────────────────────────────────────────────────
export const getProjectWorkspace = async (req: Request, res: Response): Promise<any> => {
  try {
    const ctx = await getSalesAuth(req);
    if (!can(ctx, PROJECT_VIEW_KEY)) {
      return res.status(403).json({ error: 'You do not have permission to view Marketing projects.' });
    }

    // Archived projects are excluded unless explicitly asked for, mirroring the
    // Content board's treatment of archived cards.
    const includeArchived = str(req.query.includeArchived) === 'true';

    // ONE query for clients and ONE for projects — not a per-client project
    // fetch, which is the N+1 this switcher would otherwise invite.
    const [clients, projects] = await Promise.all([
      prisma.marketing_clients.findMany({
        where: { active: true },
        select: { id: true, name: true },
        orderBy: [{ sort_order: 'asc' }, { name: 'asc' }],
      }),
      prisma.marketing_projects.findMany({
        where: includeArchived ? {} : { status: 'active' },
        select: {
          id: true, client_id: true, name: true, status: true,
          description: true, start_date: true, end_date: true,
        },
        orderBy: [{ name: 'asc' }],
      }),
    ]);

    const byClient = new Map<number, typeof projects>();
    for (const p of projects) {
      const list = byClient.get(p.client_id) ?? [];
      list.push(p);
      byClient.set(p.client_id, list);
    }

    return res.json({
      success: true,
      canManageProjects: canManageProjects(ctx),
      canWriteEvents: canWriteEvents(ctx),
      clients: clients.map((c) => ({
        id: c.id,
        name: c.name,
        projects: (byClient.get(c.id) ?? []).map((p) => ({
          id: p.id, clientId: p.client_id, name: p.name, status: p.status,
          description: p.description, startDate: ymd(p.start_date), endDate: ymd(p.end_date),
        })),
      })),
    });
  } catch (error) {
    console.error('Error loading Marketing project workspace:', error);
    return res.status(500).json({ error: 'Failed to load Marketing projects' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /marketing/projects/:projectId — one project (used on direct URL entry)
// ─────────────────────────────────────────────────────────────────────────────
export const getProject = async (req: Request, res: Response): Promise<any> => {
  try {
    const ctx = await getSalesAuth(req);
    const { project, denial } = await resolveProject(req.params.projectId, ctx);
    if (denial) return res.status(denial.status).json({ error: denial.message });

    const client = await prisma.marketing_clients.findUnique({
      where: { id: project!.client_id }, select: { id: true, name: true },
    });

    return res.json({
      success: true,
      canManageProjects: canManageProjects(ctx),
      canWriteEvents: canWriteEvents(ctx),
      project: {
        id: project!.id, clientId: project!.client_id, name: project!.name,
        status: project!.status, description: project!.description,
        startDate: ymd(project!.start_date), endDate: ymd(project!.end_date),
        clientName: client?.name ?? null,
      },
    });
  } catch (error) {
    console.error('Error loading Marketing project:', error);
    return res.status(500).json({ error: 'Failed to load the project' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /marketing/projects
// ─────────────────────────────────────────────────────────────────────────────
export const createProject = async (req: Request, res: Response): Promise<any> => {
  try {
    const ctx = await getSalesAuth(req);
    if (!canManageProjects(ctx)) {
      return res.status(403).json({ error: 'You do not have permission to create Marketing projects.' });
    }

    const b = req.body ?? {};
    const errors: Record<string, string> = {};
    const name = str(b.name);
    const clientId = projectIdParam(b.clientId);

    if (!name) errors.name = 'Project name is required.';
    else if (name.length > 160) errors.name = 'Project name must be 160 characters or fewer.';
    if (!clientId) errors.clientId = 'Choose a client.';

    const startDate = str(b.startDate);
    const endDate = str(b.endDate);
    const ymdRe = /^\d{4}-\d{2}-\d{2}$/;
    if (startDate && !ymdRe.test(startDate)) errors.startDate = 'Enter a valid start date.';
    if (endDate && !ymdRe.test(endDate)) errors.endDate = 'Enter a valid end date.';
    if (!errors.startDate && !errors.endDate && startDate && endDate && endDate < startDate) {
      errors.endDate = 'End date cannot be before the start date.';
    }
    if (Object.keys(errors).length) return res.status(400).json({ error: 'Please fix the highlighted fields.', fieldErrors: errors });

    const row = await prisma.marketing_projects.create({
      data: {
        client_id: clientId!,
        name,
        description: str(b.description) || null,
        status: 'active',
        start_date: startDate ? ymdToDate(startDate) : null,
        end_date: endDate ? ymdToDate(endDate) : null,
        // Never from the body: the creator is the authenticated caller.
        created_by: uid(req),
      },
    });

    await activityService.logActivity({
      actorUserId: uid(req),
      type: 'marketing_project_created',
      description: `Created Marketing project "${row.name}"`,
      metadata: { projectId: row.id, clientId: row.client_id },
    });

    return res.status(201).json({
      success: true,
      project: {
        id: row.id, clientId: row.client_id, name: row.name, status: row.status,
        description: row.description, startDate: ymd(row.start_date), endDate: ymd(row.end_date),
      },
    });
  } catch (error) {
    if (isDuplicate(error)) {
      return res.status(409).json({
        error: 'That client already has a project with this name.',
        fieldErrors: { name: 'That client already has a project with this name.' },
      });
    }
    if (isBadReference(error)) return res.status(400).json({ error: BAD_REFERENCE_MSG });
    console.error('Error creating Marketing project:', error);
    return res.status(500).json({ error: 'Failed to create the project' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /marketing/projects/:projectId/events?from=&to=
// ─────────────────────────────────────────────────────────────────────────────
export const getProjectEvents = async (req: Request, res: Response): Promise<any> => {
  try {
    const ctx = await getSalesAuth(req);
    const { project, denial } = await resolveProject(req.params.projectId, ctx);
    if (denial) return res.status(denial.status).json({ error: denial.message });

    // Range is an optimisation only — the project filter below is what enforces
    // scope, so an absent or malformed range can never widen it past the project.
    const from = str(req.query.from);
    const to = str(req.query.to);
    const ymdRe = /^\d{4}-\d{2}-\d{2}$/;
    const range: Record<string, Date> = {};
    if (ymdRe.test(from)) range.gte = ymdToDate(from);
    if (ymdRe.test(to)) range.lte = ymdToDate(to);

    const rows = await prisma.marketing_events.findMany({
      where: { project_id: project!.id, ...(Object.keys(range).length ? { event_date: range } : {}) },
      orderBy: [{ event_date: 'asc' }, { start_time: 'asc' }, { id: 'asc' }],
    });
    const names = await userNameMap(rows.map((r) => r.assignee_id));

    return res.json({
      success: true,
      canWriteEvents: canWriteEvents(ctx),
      eventTypes: EVENT_TYPES.map((key) => ({ key, label: EVENT_TYPE_LABELS[key] })),
      events: rows.map((r) => serializeEvent(r, names)),
    });
  } catch (error) {
    console.error('Error loading project events:', error);
    return res.status(500).json({ error: 'Failed to load calendar events' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /marketing/projects/:projectId/events
// ─────────────────────────────────────────────────────────────────────────────
export const createProjectEvent = async (req: Request, res: Response): Promise<any> => {
  try {
    const ctx = await getSalesAuth(req);
    // write:true — an archived project is a closed workspace.
    const { project, denial } = await resolveProject(req.params.projectId, ctx, { write: true });
    if (denial) return res.status(denial.status).json({ error: denial.message });
    if (!canWriteEvents(ctx)) {
      return res.status(403).json({ error: 'You do not have permission to create calendar events.' });
    }

    const { value, errors } = validateEvent(req.body ?? {});
    if (errors) return res.status(400).json({ error: 'Please fix the highlighted fields.', fieldErrors: errors });

    const row = await prisma.marketing_events.create({
      data: {
        // The project comes from the RESOLVED row, never from the body — a
        // payload carrying another projectId cannot redirect the write.
        project_id: project!.id,
        title: value!.title,
        event_date: ymdToDate(value!.date),
        start_time: value!.startTime,
        end_time: value!.endTime,
        event_type: value!.eventType,
        assignee_id: value!.assigneeId,
        notes: value!.notes,
        created_by: uid(req),
      },
    });
    const names = await userNameMap([row.assignee_id]);

    await activityService.logActivity({
      actorUserId: uid(req),
      type: 'marketing_event_created',
      description: `Added calendar event "${row.title}" to ${project!.name}`,
      metadata: { projectId: project!.id, eventId: row.id },
    });

    return res.status(201).json({ success: true, event: serializeEvent(row, names) });
  } catch (error) {
    if (isBadReference(error)) return res.status(400).json({ error: BAD_REFERENCE_MSG });
    console.error('Error creating project event:', error);
    return res.status(500).json({ error: 'Failed to create the event' });
  }
};

/** Load an event and prove it belongs to the resolved project. */
async function resolveEvent(req: Request, ctx: Awaited<ReturnType<typeof getSalesAuth>>, write: boolean) {
  const { project, denial } = await resolveProject(req.params.projectId, ctx, { write });
  if (denial) return { denial };

  const eventId = projectIdParam(req.params.eventId);
  if (!eventId) return { denial: { status: 400, message: 'A valid event is required.' } };

  const event = await prisma.marketing_events.findUnique({ where: { id: eventId } });
  // The project match is the IDOR guard: an event id from another project is
  // indistinguishable from one that does not exist.
  if (!event || event.project_id !== project!.id) {
    return { denial: { status: 404, message: 'Event not found.' } };
  }
  return { project, event };
}

// ─────────────────────────────────────────────────────────────────────────────
// PUT /marketing/projects/:projectId/events/:eventId
// ─────────────────────────────────────────────────────────────────────────────
export const updateProjectEvent = async (req: Request, res: Response): Promise<any> => {
  try {
    const ctx = await getSalesAuth(req);
    const { project, event, denial } = await resolveEvent(req, ctx, true) as any;
    if (denial) return res.status(denial.status).json({ error: denial.message });
    if (!canWriteEvents(ctx)) {
      return res.status(403).json({ error: 'You do not have permission to edit calendar events.' });
    }

    // Merge over the STORED row, so a partial payload cannot blank fields the
    // form did not send.
    const current: NormalisedEvent = {
      title: event.title,
      date: ymd(event.event_date)!,
      startTime: event.start_time,
      endTime: event.end_time,
      eventType: event.event_type,
      assigneeId: event.assignee_id,
      notes: event.notes,
    };
    const { value, errors } = validateEvent(req.body ?? {}, current);
    if (errors) return res.status(400).json({ error: 'Please fix the highlighted fields.', fieldErrors: errors });

    const row = await prisma.marketing_events.update({
      where: { id: event.id },
      data: {
        title: value!.title,
        event_date: ymdToDate(value!.date),
        start_time: value!.startTime,
        end_time: value!.endTime,
        event_type: value!.eventType,
        assignee_id: value!.assigneeId,
        notes: value!.notes,
      },
    });
    const names = await userNameMap([row.assignee_id]);

    await activityService.logActivity({
      actorUserId: uid(req),
      type: 'marketing_event_updated',
      description: `Updated calendar event "${row.title}" in ${project.name}`,
      metadata: { projectId: project.id, eventId: row.id },
    });

    return res.json({ success: true, event: serializeEvent(row, names) });
  } catch (error) {
    if (isBadReference(error)) return res.status(400).json({ error: BAD_REFERENCE_MSG });
    console.error('Error updating project event:', error);
    return res.status(500).json({ error: 'Failed to update the event' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /marketing/projects/:projectId/events/:eventId
// ─────────────────────────────────────────────────────────────────────────────
export const deleteProjectEvent = async (req: Request, res: Response): Promise<any> => {
  try {
    const ctx = await getSalesAuth(req);
    const { project, event, denial } = await resolveEvent(req, ctx, true) as any;
    if (denial) return res.status(denial.status).json({ error: denial.message });
    if (!canWriteEvents(ctx)) {
      return res.status(403).json({ error: 'You do not have permission to delete calendar events.' });
    }

    // deleteMany, not delete: a second click after the first succeeded deletes
    // 0 rows and still returns 200, instead of throwing a spurious P2025.
    const { count } = await prisma.marketing_events.deleteMany({ where: { id: event.id, project_id: project.id } });

    if (count > 0) {
      await activityService.logActivity({
        actorUserId: uid(req),
        type: 'marketing_event_deleted',
        description: `Deleted calendar event "${event.title}" from ${project.name}`,
        metadata: { projectId: project.id, eventId: event.id },
      });
    }

    return res.json({ success: true, deleted: count > 0 });
  } catch (error) {
    console.error('Error deleting project event:', error);
    return res.status(500).json({ error: 'Failed to delete the event' });
  }
};
