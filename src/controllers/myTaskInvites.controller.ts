import { Request, Response } from 'express';
import { randomBytes } from 'crypto';
import prisma from '../config/db.js';
import { io } from '../socket.js';
import { canAccessMyTask } from '../utils/myTaskAccess.js';
import { normalizePhone } from '../utils/phone.js';
import { userLookupService } from '../services/userLookup.service.js';
import { isExternalUser } from '../utils/roles.js';
import { logMyTaskActivity, bumpMyTaskActivity, emitTaskEvent } from './myTasks.controller.js';

/**
 * TASK INVITES — assigning a My Task to a phone contact.
 *
 *  • The contact is already a company ERP user (phone on their account) →
 *    they are added as a member straight away, no invite.
 *  • Otherwise → a pending invite with a secret token. The app opens WhatsApp
 *    with `whatsappUrl`, a ready-made message carrying `inviteUrl`. Whoever opens
 *    the link logs in (company user) or signs up (External user, /auth/register)
 *    and accepts it, which makes them a task member.
 *
 * The invite is claimed by the TOKEN, not by phone: nothing verifies a phone
 * number yet (no OTP), so a phone typed at sign-up proves nothing. Possessing
 * the link sent to that WhatsApp is the proof — same model as email invite links.
 */

const uid = (req: Request) => Number((req as any).userId);
const urole = (req: Request) => String((req as any).userRole || '');

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Activity-timeline label: the contact name, else a masked number (phones are personal data). */
const inviteeLabel = (i: { name: string | null; phone: string }) => i.name || `•••${i.phone.slice(-4)}`;

function serializeInvite(i: any) {
  const expired = i.status === 'pending' && new Date(i.expires_at) <= new Date();
  return {
    id: i.id,
    phone: i.phone,
    name: i.name,
    status: expired ? 'expired' : i.status,
    expiresAt: i.expires_at,
    acceptedBy: i.accepted_by,
    acceptedAt: i.accepted_at,
  };
}

/**
 * Add one assignee. Same In-Charge rule as createMyTask: a task whose ONLY
 * member is this person gets them as In-Charge (so they can move its status).
 */
async function addAssignee(taskId: number, memberId: number, addedBy: number) {
  await prisma.my_task_members.createMany({
    data: [{ task_id: taskId, user_id: memberId, added_by: addedBy }],
    skipDuplicates: true,
  });
  await prisma.$executeRawUnsafe(
    `UPDATE my_tasks SET in_charge_id = $2
      WHERE id = $1 AND in_charge_id IS NULL
        AND (SELECT COUNT(*) FROM my_task_members WHERE task_id = $1) = 1;`,
    taskId, memberId,
  );
  io.to(`user_${memberId}`).emit('mytask_changed', { taskId, action: 'assigned' });
}

/* ── POST /api/my-tasks/:id/invites  { phone, name? } ─────────────────── */
export const createMyTaskInvite = async (req: Request, res: Response) => {
  try {
    const taskId = Number(req.params.id);
    const userId = uid(req);
    const access = await canAccessMyTask(taskId, userId, urole(req));
    if (!access.task) return res.status(404).json({ error: 'Task not found' });
    if (!access.canManage) return res.status(403).json({ error: 'Only the task creator can assign this task' });

    const phone = normalizePhone(req.body?.phone);
    if (!phone.ok) return res.status(400).json({ error: phone.error });
    const name = String(req.body?.name ?? '').trim().slice(0, 255) || null;

    // Already a company user with this number → assign directly, no invite.
    // (Same lookup + visibility rule as POST /users/lookup-by-phone.)
    // NOT for External inviters: they always get a normal invite, so they can
    // never add company staff directly, and the response never reveals whether
    // a number belongs to an employee. A staff member who gets one may accept it.
    const inviterIsExternal = isExternalUser((req as any).userRoleNames);
    const [match] = inviterIsExternal
      ? []
      : await userLookupService.findUsersByPhones([{ requested: phone.e164, e164: phone.e164 }]);
    if (match) {
      await addAssignee(taskId, match.user.id, userId);
      await logMyTaskActivity(taskId, userId, `Assigned member(s): ${match.user.name}`);
      await bumpMyTaskActivity(taskId, userId);
      await emitTaskEvent(taskId, 'mytask_changed', { taskId, action: 'members' });
      return res.status(200).json({ type: 'member', user: match.user });
    }

    // Not a company user → (re)issue the invite. Re-inviting the same number
    // refreshes the token + expiry, so an old forwarded link stops working.
    const token = randomBytes(32).toString('base64url');
    const invite = await prisma.my_task_invites.upsert({
      where: { task_id_phone: { task_id: taskId, phone: phone.e164 } },
      update: {
        token, name, invited_by: userId, status: 'pending',
        expires_at: new Date(Date.now() + INVITE_TTL_MS), accepted_by: null, accepted_at: null,
      },
      create: {
        task_id: taskId, phone: phone.e164, name, token, invited_by: userId,
        expires_at: new Date(Date.now() + INVITE_TTL_MS),
      },
    });

    const inviter = await prisma.users.findUnique({ where: { id: userId }, select: { name: true } });
    const base = (process.env.APP_INVITE_URL || process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/$/, '');
    const inviteUrl = `${base}/invite/${token}`;
    const text = `${inviter?.name || 'Someone'} assigned you a task: "${access.task.title}". Open it here: ${inviteUrl}`;
    const whatsappUrl = `https://wa.me/${phone.e164.replace(/\D/g, '')}?text=${encodeURIComponent(text)}`;

    await logMyTaskActivity(taskId, userId, `Invited ${inviteeLabel(invite)} via WhatsApp`);
    await bumpMyTaskActivity(taskId, userId);
    await emitTaskEvent(taskId, 'mytask_changed', { taskId, action: 'members' });
    return res.status(201).json({ type: 'invite', invite: serializeInvite(invite), inviteUrl, whatsappUrl });
  } catch (error) {
    console.error('Error creating my-task invite:', error);
    return res.status(500).json({ error: 'Failed to invite' });
  }
};

/* ── GET /api/my-tasks/:id/invites — pending/accepted invites (creator only) ── */
export const listMyTaskInvites = async (req: Request, res: Response) => {
  try {
    const taskId = Number(req.params.id);
    const access = await canAccessMyTask(taskId, uid(req), urole(req));
    if (!access.task) return res.status(404).json({ error: 'Task not found' });
    // Invitee phone numbers are visible to the task owner only.
    if (!access.canManage) return res.status(403).json({ error: 'Only the task creator can view invites' });

    const invites = await prisma.my_task_invites.findMany({ where: { task_id: taskId }, orderBy: { created_at: 'desc' } });
    return res.status(200).json(invites.map(serializeInvite));
  } catch (error) {
    console.error('Error listing my-task invites:', error);
    return res.status(500).json({ error: 'Failed to load invites' });
  }
};

/* ── DELETE /api/my-tasks/:id/invites/:inviteId — cancel an invite ──────── */
export const deleteMyTaskInvite = async (req: Request, res: Response) => {
  try {
    const taskId = Number(req.params.id);
    const userId = uid(req);
    const access = await canAccessMyTask(taskId, userId, urole(req));
    if (!access.task) return res.status(404).json({ error: 'Task not found' });
    if (!access.canManage) return res.status(403).json({ error: 'Only the task creator can cancel invites' });

    const invite = await prisma.my_task_invites.findFirst({ where: { id: Number(req.params.inviteId), task_id: taskId } });
    if (!invite) return res.status(404).json({ error: 'Invite not found' });
    await prisma.my_task_invites.delete({ where: { id: invite.id } });
    await logMyTaskActivity(taskId, userId, `Cancelled invite for ${inviteeLabel(invite)}`);
    await emitTaskEvent(taskId, 'mytask_changed', { taskId, action: 'members' });
    return res.status(200).json({ success: true });
  } catch (error) {
    console.error('Error cancelling my-task invite:', error);
    return res.status(500).json({ error: 'Failed to cancel invite' });
  }
};

/** Load an invite by its link token (tokens are 43 chars; anything else is unknown). */
async function findByToken(token: unknown) {
  const t = String(token ?? '');
  if (!t || t.length > 64) return null;
  return prisma.my_task_invites.findUnique({ where: { token: t }, include: { task: { select: { title: true } } } });
}

/* ── GET /api/invites/:token — PUBLIC preview for the invite landing screen ── */
export const getInvite = async (req: Request, res: Response) => {
  try {
    const invite = await findByToken(req.params.token);
    if (!invite) return res.status(404).json({ error: 'Invite not found' });
    const inviter = await prisma.users.findUnique({ where: { id: invite.invited_by }, select: { name: true } });
    // Deliberately no phone / task id — a forwarded link must not leak them.
    return res.status(200).json({
      status: serializeInvite(invite).status,
      name: invite.name,
      taskTitle: invite.task.title,
      invitedBy: inviter?.name ?? null,
      expiresAt: invite.expires_at,
    });
  } catch (error) {
    console.error('Error loading invite:', error);
    return res.status(500).json({ error: 'Failed to load invite' });
  }
};

/* ── POST /api/invites/:token/accept — logged-in user (company or External) ── */
export const acceptInvite = async (req: Request, res: Response) => {
  try {
    const userId = uid(req);
    const invite = await findByToken(req.params.token);
    if (!invite) return res.status(404).json({ error: 'Invite not found' });

    if (invite.status === 'accepted') {
      // Idempotent for the person who accepted it; used-up for everyone else.
      if (invite.accepted_by === userId) return res.status(200).json({ success: true, taskId: invite.task_id });
      return res.status(410).json({ error: 'This invite has already been used' });
    }

    // Conditional update = the race guard: only one accept can win a pending row.
    const now = new Date();
    const won = await prisma.my_task_invites.updateMany({
      where: { id: invite.id, status: 'pending', expires_at: { gt: now } },
      data: { status: 'accepted', accepted_by: userId, accepted_at: now },
    });
    if (won.count === 0) {
      return res.status(410).json({ error: 'This invite has expired. Ask the sender to invite you again.' });
    }

    await addAssignee(invite.task_id, userId, invite.invited_by);
    await logMyTaskActivity(invite.task_id, userId, 'Accepted the task invite');
    await bumpMyTaskActivity(invite.task_id, userId);
    await emitTaskEvent(invite.task_id, 'mytask_changed', { taskId: invite.task_id, action: 'members' });
    return res.status(200).json({ success: true, taskId: invite.task_id });
  } catch (error) {
    console.error('Error accepting invite:', error);
    return res.status(500).json({ error: 'Failed to accept invite' });
  }
};
