import { Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import prisma from '../config/db.js';
import { io } from '../socket.js';
import { canAccessMyTask, getMyTaskAudience } from '../utils/myTaskAccess.js';

/* ── helpers ──────────────────────────────────────────────────────────── */
const uid = (req: Request) => Number((req as any).userId);
const urole = (req: Request) => String((req as any).userRole || '');

// Standard Global My Tasks status workflow (single source of truth).
// todo → in_progress → (waiting ⇄ in_progress) → done → approved.
// Transitions are intentionally NOT hard-gated here (the UI has always offered a
// free status dropdown; enforcing a graph would break existing free-form moves).
// Only the status VOCABULARY is validated; 'waiting' additionally requires a reason.
const VALID_MYTASK_STATUSES = ['todo', 'in_progress', 'waiting', 'done', 'approved'];
// Human labels for Activity Timeline messages (e.g. "To Do → In Progress").
const MYTASK_STATUS_LABELS: Record<string, string> = {
  todo: 'To Do', in_progress: 'In Progress', waiting: 'Waiting', done: 'Done', approved: 'Approved',
};
const statusLabel = (s: string) => MYTASK_STATUS_LABELS[s] || s;

const pad = (n: number) => String(n).padStart(2, '0');
/** Stored due_date (a DATE at UTC midnight) → 'YYYY-MM-DD' using its UTC parts. */
function dueYmd(d: Date | null | undefined): string | null {
  if (!d) return null;
  const dt = d instanceof Date ? d : new Date(d);
  if (isNaN(dt.getTime())) return null;
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}
/** Accepts 'YYYY-MM-DD' (or ISO) → a Date for a DATE column, or null. */
function parseDue(v: any): Date | null {
  if (!v) return null;
  const s = String(v).trim();
  if (!s) return null;
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  const iso = m ? `${m[1]}-${m[2]}-${m[3]}T00:00:00.000Z` : s;
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : d;
}

/** Log a chronological activity event for the Activity Timeline. */
export async function logMyTaskActivity(taskId: number, userId: number, action: string, details?: any) {
  try {
    await prisma.my_task_activities.create({
      data: { task_id: taskId, user_id: userId, action, details: details ?? undefined },
    });
  } catch (err) {
    console.error('logMyTaskActivity failed:', err);
  }
}

/** Standard Prisma include fragment for eager-loading activities with user. */
const ACTIVITY_INCLUDE = {
  activities: {
    include: { user: { select: { id: true, name: true } } },
    orderBy: { created_at: 'asc' as const },
  },
};

/** Standard Prisma include for a full task (used in workspace + detail endpoints). */
const TASK_INCLUDE = {
  // `status` drives the `active` flag — inactive users must not be mentionable.
  creator: { select: { id: true, name: true, email: true, status: true } },
  members: { include: { user: { select: { id: true, name: true, email: true, status: true } } } },
  attachments: { include: { uploader: { select: { id: true, name: true } } } },
  project: { select: { id: true, name: true } },
  ...ACTIVITY_INCLUDE,
};

function serializeTask(t: any, opts: { userId: number; unread?: number; unreadFlag?: boolean; mentions?: number }) {
  const members = (t.members || []).map((m: any) => ({
    id: m.user?.id ?? m.user_id,
    name: m.user?.name ?? 'Unknown',
    email: m.user?.email ?? null,
    active: (m.user?.status ?? 'active') === 'active',
  }));
  return {
    id: t.id,
    title: t.title,
    description: t.description || '',
    priority: t.priority || 'medium',
    status: t.status || 'todo',
    dueDate: dueYmd(t.due_date),
    dueTime: t.due_time || null,
    createdAt: t.created_at,
    updatedAt: t.updated_at,
    createdBy: t.creator
      ? { id: t.creator.id, name: t.creator.name, email: t.creator.email, active: (t.creator.status ?? 'active') === 'active' }
      : { id: t.created_by, name: 'Unknown', email: null, active: false },
    inChargeId: t.in_charge_id ?? null,
    // Dependency reason shown in Task Details while status = 'waiting' (NULL otherwise).
    waitingReason: t.waiting_reason ?? null,
    // Optional Project link (drives the Task Dashboard's Project filter).
    projectId: t.project_id ?? null,
    projectName: t.project?.name ?? null,
    members,
    memberCount: members.length,
    assignedToMe: members.some((m: any) => m.id === opts.userId),
    createdByMe: t.created_by === opts.userId,
    unreadCount: opts.unread ?? 0,
    /** Per-user unread: never opened, changed since last open, or new chat msgs. */
    unread: opts.unreadFlag ?? false,
    /** Per-user unread @mentions (subset of unreadCount) — drives the card's @ badge. */
    unreadMentions: opts.mentions ?? 0,
    attachments: (t.attachments || []).map((a: any) => ({
      id: a.id, file_name: a.file_name, file_url: a.file_url, file_size: a.file_size,
      uploaded_by: a.uploaded_by, uploader: a.uploader ?? null,
    })),
    activities: (t.activities || []).map((act: any) => ({
      id: act.id,
      action: act.action,
      details: act.details,
      createdAt: act.created_at,
      user: act.user ? { id: act.user.id, name: act.user.name } : null,
    })),
  };
}

function serializeMessage(m: any) {
  return {
    id: m.id,
    task_id: m.task_id,
    sender_id: m.sender_id,
    message: m.message,
    metadata: m.metadata || {},
    created_at: m.created_at,
    sender: m.sender ? { id: m.sender.id, name: m.sender.name, email: m.sender.email } : null,
  };
}

/** Real-time fan-out to every audience member's personal room (creator + members). */
async function emitTaskEvent(taskId: number, event: string, payload: any, exclude?: number) {
  try {
    const audience = await getMyTaskAudience(taskId);
    for (const u of audience) {
      if (exclude && u === exclude) continue;
      io.to(`user_${u}`).emit(event, payload);
    }
  } catch (err) {
    console.error('emitTaskEvent failed:', err);
  }
}

/** Mark a task READ for a single user (upsert their read cursor). */
async function markActorRead(taskId: number, actorId: number, now: Date) {
  await prisma.my_task_reads.upsert({
    where: { task_id_user_id: { task_id: taskId, user_id: actorId } },
    update: { last_read_at: now },
    create: { task_id: taskId, user_id: actorId, last_read_at: now },
  });
}

/**
 * Bump a task's activity clock AND mark it read for the actor — so the actor's
 * own change never flags the task unread for themselves, while every OTHER member
 * falls behind the new last_activity_at and sees it as unread until they open it.
 * Used for member/attachment changes (which don't otherwise touch the task row).
 */
export async function bumpMyTaskActivity(taskId: number, actorId: number, now: Date = new Date()) {
  try {
    await prisma.my_tasks.update({ where: { id: taskId }, data: { last_activity_at: now } });
    await markActorRead(taskId, actorId, now);
  } catch (err) {
    console.error('bumpMyTaskActivity failed:', err);
  }
}

/* ── workspace (Today / Inbox / Outbox) ───────────────────────────────── */
export const getMyTaskWorkspace = async (req: Request, res: Response) => {
  try {
    const userId = uid(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const memberships = await prisma.my_task_members.findMany({
      where: { user_id: userId },
      select: { task_id: true },
    });
    const memberTaskIds = memberships.map((m) => m.task_id);

    const orClauses: Prisma.my_tasksWhereInput[] = [{ created_by: userId }];
    if (memberTaskIds.length) orClauses.push({ id: { in: memberTaskIds } });

    const tasks = await prisma.my_tasks.findMany({
      where: { OR: orClauses },
      include: TASK_INCLUDE,
      orderBy: [{ due_date: 'asc' }, { due_time: 'asc' }, { created_at: 'desc' }],
    });

    const ids = tasks.map((t) => t.id);
    const unread: Record<number, number> = {};
    if (ids.length) {
      const rows: any[] = await prisma.$queryRaw`
        SELECT m.task_id, COUNT(m.id) AS unread_count
        FROM my_task_messages m
        LEFT JOIN my_task_reads r ON m.task_id = r.task_id AND r.user_id = ${userId}
        WHERE m.task_id IN (${Prisma.join(ids)})
          AND m.sender_id != ${userId}
          AND (r.last_read_at IS NULL OR m.created_at > r.last_read_at)
        GROUP BY m.task_id`;
      rows.forEach((row) => { unread[Number(row.task_id)] = Number(row.unread_count); });
    }

    // Per-user unread @MENTIONS — identical shape to the unread-message query above,
    // narrowed to messages whose metadata.mentions JSONB array contains this user.
    // Deliberately reuses the SAME my_task_reads cursor, so opening the task clears
    // mentions automatically and per-user; no separate mention-read table is needed.
    const mentionCounts: Record<number, number> = {};
    if (ids.length) {
      const mRows: any[] = await prisma.$queryRaw`
        SELECT m.task_id, COUNT(m.id) AS mention_count
        FROM my_task_messages m
        LEFT JOIN my_task_reads r ON m.task_id = r.task_id AND r.user_id = ${userId}
        WHERE m.task_id IN (${Prisma.join(ids)})
          AND m.sender_id != ${userId}
          AND (r.last_read_at IS NULL OR m.created_at > r.last_read_at)
          AND m.metadata -> 'mentions' @> ${JSON.stringify([userId])}::jsonb
        GROUP BY m.task_id`;
      mRows.forEach((row) => { mentionCounts[Number(row.task_id)] = Number(row.mention_count); });
    }

    // Per-user reads → unread FLAG = never opened, OR the task changed since the
    // user last opened it (last_activity_at), OR there are unread chat messages.
    const readAt = new Map<number, Date>();
    if (ids.length) {
      const reads = await prisma.my_task_reads.findMany({
        where: { user_id: userId, task_id: { in: ids } },
        select: { task_id: true, last_read_at: true },
      });
      for (const r of reads) readAt.set(r.task_id, r.last_read_at);
    }
    const isUnread = (t: any): boolean => {
      const last = readAt.get(t.id);
      if (!last) return true;
      if (t.last_activity_at && new Date(t.last_activity_at) > last) return true;
      return (unread[t.id] || 0) > 0;
    };

    const inbox: any[] = [];
    const outbox: any[] = [];
    for (const t of tasks) {
      const s = serializeTask(t, {
        userId, unread: unread[t.id] || 0, unreadFlag: isUnread(t), mentions: mentionCounts[t.id] || 0,
      });
      // Inbox  = tasks where I must act, any due date. assignedToMe = I'm a member,
      //          which ALREADY includes the In-Charge (create validates in-charge ∈
      //          members). FUTURE-READY: also push when I'm the Approver — add
      //          `|| s.isApprover` here once an approver field exists. Urgency (due
      //          today / overdue) is surfaced per-row in the UI, not a separate tab.
      // Outbox = tasks I created (sent to others / myself), any due date.
      if (s.assignedToMe) inbox.push(s);
      if (s.createdByMe) outbox.push(s);
    }

    return res.status(200).json({
      me: { id: userId },
      inbox,
      outbox,
    });
  } catch (error) {
    console.error('Error loading my-tasks workspace:', error);
    return res.status(500).json({ error: 'Failed to load your tasks' });
  }
};

/* ── single task detail ───────────────────────────────────────────────── */
export const getMyTask = async (req: Request, res: Response) => {
  try {
    const taskId = Number(req.params.id);
    const userId = uid(req);
    const access = await canAccessMyTask(taskId, userId, urole(req));
    if (!access.task) return res.status(404).json({ error: 'Task not found' });
    if (!access.allowed) return res.status(403).json({ error: 'You do not have access to this task' });

    const task = await prisma.my_tasks.findUnique({
      where: { id: taskId },
      include: TASK_INCLUDE,
    });
    if (!task) return res.status(404).json({ error: 'Task not found' });
    return res.status(200).json(serializeTask(task, { userId }));
  } catch (error) {
    console.error('Error loading my-task:', error);
    return res.status(500).json({ error: 'Failed to load task' });
  }
};

/* ── create ───────────────────────────────────────────────────────────── */
export const createMyTask = async (req: Request, res: Response) => {
  try {
    const userId = uid(req);
    const { title, description, priority, dueDate, dueTime, status } = req.body;
    const memberIds: number[] = Array.isArray(req.body.memberIds)
      ? Array.from(new Set(req.body.memberIds.map((n: any) => Number(n)).filter((n: number) => !!n && !Number.isNaN(n))))
      : [];

    if (!title || !String(title).trim()) return res.status(400).json({ error: 'Title is required' });

    // Only assign real users (avoids FK violations).
    const validMembers = memberIds.length
      ? (await prisma.users.findMany({ where: { id: { in: memberIds } }, select: { id: true } })).map((u) => u.id)
      : [];

    let inChargeId = req.body.inChargeId ? Number(req.body.inChargeId) : null;
    if (validMembers.length === 1) {
      inChargeId = validMembers[0];
    } else if (validMembers.length > 1) {
      if (!inChargeId || !validMembers.includes(inChargeId)) {
        return res.status(400).json({ error: 'For multiple members, exactly one valid In-Charge must be selected.' });
      }
    } else {
      inChargeId = null;
    }

    // Enforce the standardized status vocabulary + waiting-reason invariant on the
    // create path too (default 'todo'; a supplied 'waiting' must carry a reason).
    const nextStatus = status ? String(status) : 'todo';
    if (!VALID_MYTASK_STATUSES.includes(nextStatus)) {
      return res.status(400).json({ error: `Invalid status. Must be one of: ${VALID_MYTASK_STATUSES.join(', ')}.` });
    }
    let waitingReasonValue: string | null = null;
    if (nextStatus === 'waiting') {
      const r = typeof req.body.waitingReason === 'string' ? req.body.waitingReason.trim() : '';
      if (!r) return res.status(400).json({ error: 'A waiting reason is required when setting status to Waiting.' });
      waitingReasonValue = r.slice(0, 255);
    }

    const created = await prisma.my_tasks.create({
      data: {
        in_charge_id: inChargeId,
        title: String(title).trim(),
        description: description ? String(description) : null,
        priority: priority || 'medium',
        status: nextStatus,
        waiting_reason: waitingReasonValue,
        project_id: req.body.projectId ? String(req.body.projectId) : null,
        due_date: parseDue(dueDate),
        due_time: dueTime ? String(dueTime) : null,
        created_by: userId,
        members: validMembers.length
          ? { create: validMembers.map((mId) => ({ user_id: mId, added_by: userId })) }
          : undefined,
      },
      include: TASK_INCLUDE,
    });

    // The creator has implicitly "read" their own new task; members get NO read
    // row → the task shows as unread for them until they open it.
    await markActorRead(created.id, userId, created.last_activity_at ?? new Date());
    await logMyTaskActivity(created.id, userId, 'Created the task');
    if (nextStatus === 'waiting' && waitingReasonValue) {
      await logMyTaskActivity(created.id, userId, `Waiting Reason set to ${waitingReasonValue}`);
    }
    const payload = serializeTask(created, { userId });
    await emitTaskEvent(created.id, 'mytask_changed', { taskId: created.id, action: 'created' });
    return res.status(201).json(payload);
  } catch (error) {
    console.error('Error creating my-task:', error);
    return res.status(500).json({ error: 'Failed to create task' });
  }
};

/* ── update (title / description / priority / dueDate / status) ────────── */
export const updateMyTask = async (req: Request, res: Response) => {
  try {
    const taskId = Number(req.params.id);
    const userId = uid(req);
    const access = await canAccessMyTask(taskId, userId, urole(req));
    if (!access.task) return res.status(404).json({ error: 'Task not found' });
    if (!access.allowed) return res.status(403).json({ error: 'You do not have access to this task' });

    // RBAC: core task fields (incl. reassigning the In-Charge) are OWNER-level.
    // An assigned member may participate (chat / attachments / their own progress)
    // but must never rename, re-prioritise, re-schedule or reassign the task.
    const CORE_FIELDS = ['title', 'description', 'priority', 'dueDate', 'dueTime', 'inChargeId', 'projectId'];
    if (CORE_FIELDS.some((f) => req.body[f] !== undefined) && !access.canManage) {
      return res.status(403).json({ error: 'Only the task creator can edit task details or reassign this task.' });
    }

    const { title, description, priority, dueDate, dueTime, status, inChargeId, waitingReason, projectId } = req.body;
    const oldTask = access.task!;
    const data: any = {};
    const logs: { action: string; details?: any }[] = [];

    if (title !== undefined && title !== oldTask.title) {
      data.title = String(title).trim();
      logs.push({ action: 'Changed Title', details: { from: oldTask.title, to: data.title } });
    }
    if (description !== undefined && description !== oldTask.description) {
      data.description = description ? String(description) : null;
      logs.push({ action: 'Updated Description' });
    }
    if (priority !== undefined && priority !== oldTask.priority) {
      data.priority = priority;
      logs.push({ action: `Changed Priority from ${oldTask.priority} → ${priority}` });
    }
    if (status !== undefined && status !== oldTask.status) {
      const nextStatus = String(status);
      if (!VALID_MYTASK_STATUSES.includes(nextStatus)) {
        return res.status(400).json({ error: `Invalid status. Must be one of: ${VALID_MYTASK_STATUSES.join(', ')}.` });
      }
      // Same status RBAC as PATCH /:id/status — this path must not be a bypass.
      if (!access.canExecute) {
        return res.status(403).json({ error: 'Only the task creator or the Task In-Charge can change the status.' });
      }
      if (nextStatus === 'approved' && !access.canManage) {
        return res.status(403).json({ error: 'Only the task creator can approve a task.' });
      }
      data.status = nextStatus;
      logs.push({ action: `Changed Status from ${statusLabel(oldTask.status)} → ${statusLabel(nextStatus)}` });
      if (nextStatus === 'waiting') {
        const r = typeof waitingReason === 'string' ? waitingReason.trim() : '';
        if (!r) return res.status(400).json({ error: 'A waiting reason is required when setting status to Waiting.' });
        data.waiting_reason = r.slice(0, 255);
        if (data.waiting_reason !== ((oldTask as any).waiting_reason ?? null)) {
          logs.push({ action: `Waiting Reason set to ${data.waiting_reason}` });
        }
      } else {
        data.waiting_reason = null; // leaving Waiting clears the stale reason
      }
    }
    if (dueDate !== undefined || dueTime !== undefined) {
      if (dueDate !== undefined) data.due_date = parseDue(dueDate);
      if (dueTime !== undefined) data.due_time = dueTime ? String(dueTime) : null;
      logs.push({ action: 'Changed Due Date/Time' });
    }
    if (inChargeId !== undefined && inChargeId !== oldTask.in_charge_id) {
      data.in_charge_id = inChargeId ? Number(inChargeId) : null;
      logs.push({ action: 'Changed Task In-Charge' });
    }
    if (projectId !== undefined) {
      const nextProject = projectId ? String(projectId) : null;
      if (nextProject !== ((oldTask as any).project_id ?? null)) {
        data.project_id = nextProject;
        logs.push({ action: 'Changed Project' });
      }
    }

    const now = new Date();
    data.last_activity_at = now;
    await prisma.my_tasks.update({ where: { id: taskId }, data });
    await markActorRead(taskId, userId, now);
    for (const l of logs) await logMyTaskActivity(taskId, userId, l.action, l.details);

    const task = await prisma.my_tasks.findUnique({
      where: { id: taskId },
      include: TASK_INCLUDE,
    });

    await emitTaskEvent(taskId, 'mytask_changed', { taskId, action: 'updated' });
    return res.status(200).json(serializeTask(task, { userId }));
  } catch (error) {
    console.error('Error updating my-task:', error);
    return res.status(500).json({ error: 'Failed to update task' });
  }
};

/* ── status change (dedicated for real-time status events) ────────────── */
export const updateMyTaskStatus = async (req: Request, res: Response) => {
  try {
    const taskId = Number(req.params.id);
    const userId = uid(req);
    const { status, waitingReason } = req.body;
    if (!status) return res.status(400).json({ error: 'Status is required' });
    const nextStatus = String(status);
    if (!VALID_MYTASK_STATUSES.includes(nextStatus)) {
      return res.status(400).json({ error: `Invalid status. Must be one of: ${VALID_MYTASK_STATUSES.join(', ')}.` });
    }

    const access = await canAccessMyTask(taskId, userId, urole(req));
    if (!access.task) return res.status(404).json({ error: 'Task not found' });
    if (!access.allowed) return res.status(403).json({ error: 'You do not have access to this task' });

    // RBAC: status is EXECUTION-level (creator / In-Charge / admin) — an assigned
    // member participates but does not drive the task's state. Approving is stricter
    // still: it is the owner's verification step, so it stays OWNER-level.
    if (!access.canExecute) {
      return res.status(403).json({ error: 'Only the task creator or the Task In-Charge can update the status.' });
    }
    if (nextStatus === 'approved' && !access.canManage) {
      return res.status(403).json({ error: 'Only the task creator can approve a task.' });
    }

    // 'waiting' must carry a dependency reason; any other status clears a stale one.
    let reason: string | null = null;
    if (nextStatus === 'waiting') {
      const r = typeof waitingReason === 'string' ? waitingReason.trim() : '';
      if (!r) return res.status(400).json({ error: 'A waiting reason is required when setting status to Waiting.' });
      reason = r.slice(0, 255);
    }

    const prevStatus = access.task.status;
    const prevReason = (access.task as any).waiting_reason ?? null;
    const now = new Date();
    await prisma.my_tasks.update({
      where: { id: taskId },
      data: { status: nextStatus, waiting_reason: reason, last_activity_at: now },
    });
    await markActorRead(taskId, userId, now);

    // Activity Timeline: log the status change, then the reason (only when it changed).
    if (prevStatus !== nextStatus) {
      await logMyTaskActivity(taskId, userId, `Changed Status from ${statusLabel(prevStatus)} → ${statusLabel(nextStatus)}`);
    }
    if (nextStatus === 'waiting' && reason && reason !== prevReason) {
      await logMyTaskActivity(taskId, userId, `Waiting Reason set to ${reason}`);
    }

    await emitTaskEvent(taskId, 'mytask_changed', { taskId, action: 'status', status: nextStatus });
    return res.status(200).json({ success: true, status: nextStatus, waitingReason: reason });
  } catch (error) {
    console.error('Error updating my-task status:', error);
    return res.status(500).json({ error: 'Failed to update status' });
  }
};

/* ── delete (creator or admin only) ───────────────────────────────────── */
export const deleteMyTask = async (req: Request, res: Response) => {
  try {
    const taskId = Number(req.params.id);
    const userId = uid(req);
    const access = await canAccessMyTask(taskId, userId, urole(req));
    if (!access.task) return res.status(404).json({ error: 'Task not found' });
    if (!(access.isCreator || access.isAdmin)) {
      return res.status(403).json({ error: 'Only the task creator can delete this task' });
    }

    const audience = await getMyTaskAudience(taskId); // capture BEFORE cascade delete
    await prisma.my_tasks.delete({ where: { id: taskId } });
    for (const u of audience) io.to(`user_${u}`).emit('mytask_changed', { taskId, action: 'deleted' });
    return res.status(200).json({ success: true });
  } catch (error) {
    console.error('Error deleting my-task:', error);
    return res.status(500).json({ error: 'Failed to delete task' });
  }
};

/* ── members ──────────────────────────────────────────────────────────── */
export const addMyTaskMembers = async (req: Request, res: Response) => {
  try {
    const taskId = Number(req.params.id);
    const userId = uid(req);
    const access = await canAccessMyTask(taskId, userId, urole(req));
    if (!access.task) return res.status(404).json({ error: 'Task not found' });
    if (!(access.isCreator || access.isAdmin)) {
      return res.status(403).json({ error: 'Only the task creator can manage members' });
    }

    const rawIds: number[] = Array.isArray(req.body.userIds)
      ? Array.from(new Set(req.body.userIds.map((n: any) => Number(n)).filter((n: number) => !!n && !Number.isNaN(n))))
      : [];
    if (!rawIds.length) return res.status(400).json({ error: 'userIds are required' });

    const valid = (await prisma.users.findMany({ where: { id: { in: rawIds } }, select: { id: true, name: true } }));
    const validIds = valid.map((u) => u.id);
    if (validIds.length) {
      await prisma.my_task_members.createMany({
        data: validIds.map((mId) => ({ task_id: taskId, user_id: mId, added_by: userId })),
        skipDuplicates: true,
      });
      await logMyTaskActivity(taskId, userId, `Assigned member(s): ${valid.map(u => u.name).join(', ')}`);
    }

    const members = await prisma.my_task_members.findMany({
      where: { task_id: taskId },
      include: { user: { select: { id: true, name: true, email: true } } },
    });
    await bumpMyTaskActivity(taskId, userId);
    await emitTaskEvent(taskId, 'mytask_changed', { taskId, action: 'members' });
    // Ping newly-added users specifically (their Inbox just gained a task).
    for (const mId of validIds) io.to(`user_${mId}`).emit('mytask_changed', { taskId, action: 'assigned' });

    return res.status(200).json(members.map((m) => ({ id: m.user.id, name: m.user.name, email: m.user.email })));
  } catch (error) {
    console.error('Error adding members:', error);
    return res.status(500).json({ error: 'Failed to add members' });
  }
};

export const removeMyTaskMember = async (req: Request, res: Response) => {
  try {
    const taskId = Number(req.params.id);
    const memberUserId = Number(req.params.userId);
    const userId = uid(req);
    const access = await canAccessMyTask(taskId, userId, urole(req));
    if (!access.task) return res.status(404).json({ error: 'Task not found' });
    if (!(access.isCreator || access.isAdmin)) {
      return res.status(403).json({ error: 'Only the task creator can manage members' });
    }

    const removedUser = await prisma.users.findUnique({ where: { id: memberUserId }, select: { name: true } });
    await prisma.my_task_members.deleteMany({ where: { task_id: taskId, user_id: memberUserId } });
    if (removedUser) await logMyTaskActivity(taskId, userId, `Removed member: ${removedUser.name}`);
    await bumpMyTaskActivity(taskId, userId);
    await emitTaskEvent(taskId, 'mytask_changed', { taskId, action: 'members' });
    io.to(`user_${memberUserId}`).emit('mytask_changed', { taskId, action: 'unassigned' });
    return res.status(200).json({ success: true });
  } catch (error) {
    console.error('Error removing member:', error);
    return res.status(500).json({ error: 'Failed to remove member' });
  }
};

/* ── chat ─────────────────────────────────────────────────────────────── */
export const getMyTaskMessages = async (req: Request, res: Response) => {
  try {
    const taskId = Number(req.params.id);
    const userId = uid(req);
    const access = await canAccessMyTask(taskId, userId, urole(req));
    if (!access.task) return res.status(404).json({ error: 'Task not found' });
    if (!access.allowed) return res.status(403).json({ error: 'You do not have access to this chat' });

    const messages = await prisma.my_task_messages.findMany({
      where: { task_id: taskId },
      include: { sender: { select: { id: true, name: true, email: true } } },
      orderBy: { created_at: 'asc' },
    });
    return res.status(200).json(messages.map(serializeMessage));
  } catch (error) {
    console.error('Error fetching my-task messages:', error);
    return res.status(500).json({ error: 'Failed to fetch messages' });
  }
};

export const addMyTaskMessage = async (req: Request, res: Response) => {
  try {
    const taskId = Number(req.params.id);
    const userId = uid(req);
    const { message, mentions } = req.body;
    if (!message || !String(message).trim()) return res.status(400).json({ error: 'Message is required' });

    const access = await canAccessMyTask(taskId, userId, urole(req));
    if (!access.task) return res.status(404).json({ error: 'Task not found' });
    if (!access.allowed) return res.status(403).json({ error: 'You do not have access to this chat' });

    let validMentions: number[] = [];
    if (Array.isArray(mentions) && mentions.length > 0) {
      const parsedMentions = Array.from(new Set(mentions.map((n: any) => Number(n)).filter((n: number) => !!n && !Number.isNaN(n))));
      if (parsedMentions.length > 0) {
        const taskMembers = await prisma.my_task_members.findMany({
          where: { task_id: taskId, user_id: { in: parsedMentions } },
          select: { user_id: true }
        });
        // A task PARTICIPANT is any member OR the creator/owner. The creator was
        // previously dropped here whenever they had not also assigned themselves,
        // which is why the owner could not be tagged. (In-Charge is always a member.)
        const participants = new Set<number>(taskMembers.map((m: any) => m.user_id));
        if (parsedMentions.includes(access.task.created_by)) participants.add(access.task.created_by);
        // Never mention inactive / deleted users.
        const activeUsers = participants.size
          ? await prisma.users.findMany({
            where: { id: { in: [...participants] }, OR: [{ status: 'active' }, { status: null }] },
            select: { id: true },
          })
          : [];
        const allowed = new Set(activeUsers.map((u) => u.id));
        validMentions = parsedMentions.filter((id) => allowed.has(id));
      }
    }

    const created = await prisma.my_task_messages.create({
      data: {
        task_id: taskId,
        sender_id: userId,
        message: String(message),
        metadata: validMentions.length > 0 ? { mentions: validMentions } : {}
      },
      include: { sender: { select: { id: true, name: true, email: true } } },
    });
    const payload = serializeMessage(created);

    // Live delivery to everyone currently in the task chat room.
    io.to(`mytask_${taskId}`).emit('mytask_new_message', payload);
    // Bump unread badges for audience members who are not actively in the room.
    await emitTaskEvent(taskId, 'mytask_changed', { taskId, action: 'message' }, userId);

    if (validMentions.length > 0) {
      for (const mId of validMentions) {
        if (mId === userId) continue;
        const notification = await prisma.notifications.create({
          data: {
            user_id: mId,
            type: 'mention',
            title: 'New Mention',
            message: `${payload.sender?.name || 'Someone'} mentioned you in Task: ${access.task.title}`,
            entity_type: 'my_task',
            entity_id: taskId,
          }
        });
        io.to(`user_${mId}`).emit('notification', notification);
      }
    }

    return res.status(201).json({ success: true, message: payload });
  } catch (error) {
    console.error('Error sending my-task message:', error);
    return res.status(500).json({ error: 'Failed to send message' });
  }
};

export const deleteMyTaskMessage = async (req: Request, res: Response) => {
  try {
    const taskId = Number(req.params.id);
    const messageId = Number(req.params.messageId);
    const userId = uid(req);
    const role = urole(req);

    if (Number.isNaN(messageId) || Number.isNaN(taskId)) return res.status(404).json({ error: 'Message not found' });
    const msg = await prisma.my_task_messages.findUnique({ where: { id: messageId } });
    if (!msg || msg.task_id !== taskId) return res.status(404).json({ error: 'Message not found' });

    const access = await canAccessMyTask(taskId, userId, role);
    if (msg.sender_id !== userId && !access.isAdmin) {
      return res.status(403).json({ error: 'You can only delete your own messages' });
    }

    await prisma.my_task_messages.delete({ where: { id: messageId } });
    io.to(`mytask_${taskId}`).emit('mytask_message_deleted', { messageId });
    return res.status(200).json({ success: true });
  } catch (error) {
    console.error('Error deleting my-task message:', error);
    return res.status(500).json({ error: 'Failed to delete message' });
  }
};

export const markMyTaskRead = async (req: Request, res: Response) => {
  try {
    const taskId = Number(req.params.id);
    const userId = uid(req);
    const access = await canAccessMyTask(taskId, userId, urole(req));
    if (!access.task) return res.status(404).json({ error: 'Task not found' });
    if (!access.allowed) return res.status(403).json({ error: 'You do not have access to this task' });

    await prisma.my_task_reads.upsert({
      where: { task_id_user_id: { task_id: taskId, user_id: userId } },
      update: { last_read_at: new Date() },
      create: { task_id: taskId, user_id: userId },
    });
    return res.status(200).json({ success: true });
  } catch (error) {
    console.error('Error marking my-task read:', error);
    return res.status(500).json({ error: 'Failed to mark read' });
  }
};
