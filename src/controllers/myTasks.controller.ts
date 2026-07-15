import { Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import prisma from '../config/db.js';
import { io } from '../socket.js';
import { canAccessMyTask, getMyTaskAudience } from '../utils/myTaskAccess.js';

/* ── helpers ──────────────────────────────────────────────────────────── */
const uid = (req: Request) => Number((req as any).userId);
const urole = (req: Request) => String((req as any).userRole || '');

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

function serializeTask(t: any, opts: { userId: number; unread?: number }) {
  const members = (t.members || []).map((m: any) => ({
    id: m.user?.id ?? m.user_id,
    name: m.user?.name ?? 'Unknown',
    email: m.user?.email ?? null,
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
    createdBy: t.creator ? { id: t.creator.id, name: t.creator.name, email: t.creator.email } : { id: t.created_by, name: 'Unknown', email: null },
    inChargeId: t.in_charge_id ?? null,
    members,
    memberCount: members.length,
    assignedToMe: members.some((m: any) => m.id === opts.userId),
    createdByMe: t.created_by === opts.userId,
    unreadCount: opts.unread ?? 0,
    attachments: (t.attachments || []).map((a: any) => ({
      id: a.id, file_name: a.file_name, file_url: a.file_url, file_size: a.file_size,
      uploaded_by: a.uploaded_by, uploader: a.uploader ?? null,
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
      include: {
        creator: { select: { id: true, name: true, email: true } },
        members: { include: { user: { select: { id: true, name: true, email: true } } } },
        attachments: { include: { uploader: { select: { id: true, name: true } } } },
      },
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

    const inbox: any[] = [];
    const outbox: any[] = [];
    for (const t of tasks) {
      const s = serializeTask(t, { userId, unread: unread[t.id] || 0 });
      // Inbox  = tasks ASSIGNED to me (incoming), any due date. Urgency (due
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
      include: {
        creator: { select: { id: true, name: true, email: true } },
        members: { include: { user: { select: { id: true, name: true, email: true } } } },
        attachments: { include: { uploader: { select: { id: true, name: true } } } },
      },
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

    const created = await prisma.my_tasks.create({
      data: {
        in_charge_id: inChargeId,
        title: String(title).trim(),
        description: description ? String(description) : null,
        priority: priority || 'medium',
        status: status || 'todo',
        due_date: parseDue(dueDate),
        due_time: dueTime ? String(dueTime) : null,
        created_by: userId,
        members: validMembers.length
          ? { create: validMembers.map((mId) => ({ user_id: mId, added_by: userId })) }
          : undefined,
      },
      include: {
        creator: { select: { id: true, name: true, email: true } },
        members: { include: { user: { select: { id: true, name: true, email: true } } } },
      },
    });

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

    const { title, description, priority, dueDate, dueTime, status, inChargeId } = req.body;
    const data: any = {};
    if (title !== undefined) data.title = String(title).trim();
    if (description !== undefined) data.description = description ? String(description) : null;
    if (priority !== undefined) data.priority = priority;
    if (status !== undefined) data.status = status;
    if (dueDate !== undefined) data.due_date = parseDue(dueDate);
    if (dueTime !== undefined) data.due_time = dueTime ? String(dueTime) : null;
    if (inChargeId !== undefined) {
      data.in_charge_id = inChargeId ? Number(inChargeId) : null;
    }

    await prisma.my_tasks.update({ where: { id: taskId }, data });

    const task = await prisma.my_tasks.findUnique({
      where: { id: taskId },
      include: {
        creator: { select: { id: true, name: true, email: true } },
        members: { include: { user: { select: { id: true, name: true, email: true } } } },
      },
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
    const { status } = req.body;
    if (!status) return res.status(400).json({ error: 'Status is required' });

    const access = await canAccessMyTask(taskId, userId, urole(req));
    if (!access.task) return res.status(404).json({ error: 'Task not found' });
    if (!access.allowed) return res.status(403).json({ error: 'You do not have access to this task' });

    await prisma.my_tasks.update({ where: { id: taskId }, data: { status: String(status) } });
    await emitTaskEvent(taskId, 'mytask_changed', { taskId, action: 'status', status });
    return res.status(200).json({ success: true, status });
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

    const valid = (await prisma.users.findMany({ where: { id: { in: rawIds } }, select: { id: true } })).map((u) => u.id);
    if (valid.length) {
      await prisma.my_task_members.createMany({
        data: valid.map((mId) => ({ task_id: taskId, user_id: mId, added_by: userId })),
        skipDuplicates: true,
      });
    }

    const members = await prisma.my_task_members.findMany({
      where: { task_id: taskId },
      include: { user: { select: { id: true, name: true, email: true } } },
    });
    await emitTaskEvent(taskId, 'mytask_changed', { taskId, action: 'members' });
    // Ping newly-added users specifically (their Inbox just gained a task).
    for (const mId of valid) io.to(`user_${mId}`).emit('mytask_changed', { taskId, action: 'assigned' });

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

    await prisma.my_task_members.deleteMany({ where: { task_id: taskId, user_id: memberUserId } });
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
        validMentions = taskMembers.map((m: any) => m.user_id);
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
