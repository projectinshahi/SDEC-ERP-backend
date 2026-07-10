import prisma from '../config/db.js';
import { isGlobalAdmin } from './roles.js';

export interface MyTaskAccess {
  task: any | null;
  allowed: boolean;
  isAdmin: boolean;
  isCreator: boolean;
  isMember: boolean;
}

/**
 * Membership for a My Task (details + chat). Access is granted to a global admin
 * (Founder / SuperAdmin), the task CREATOR, or an assigned MEMBER — and to no one
 * else. This module is fully independent of the Development task system; the only
 * lookups are against my_tasks / my_task_members.
 *
 * Shared by the REST controllers and the Socket.IO room join so chat access can
 * never diverge between the HTTP and websocket paths.
 */
export async function canAccessMyTask(
  taskId: number,
  userId: number,
  roleHint?: string | null,
): Promise<MyTaskAccess> {
  const deny: MyTaskAccess = { task: null, allowed: false, isAdmin: false, isCreator: false, isMember: false };
  if (!taskId || !userId || Number.isNaN(taskId)) return deny;

  const task = await prisma.my_tasks.findUnique({ where: { id: taskId } });
  if (!task) return deny;

  let role = roleHint ?? null;
  if (role == null) {
    const u = await prisma.users.findUnique({ where: { id: userId }, select: { role: true } });
    role = u?.role ?? '';
  }
  const isAdmin = isGlobalAdmin(role);
  const isCreator = task.created_by === userId;

  let isMember = isCreator;
  if (!isAdmin && !isCreator) {
    const m = await prisma.my_task_members.findUnique({
      where: { task_id_user_id: { task_id: taskId, user_id: userId } },
      select: { id: true },
    });
    isMember = !!m;
  }

  return { task, allowed: isAdmin || isCreator || isMember, isAdmin, isCreator, isMember };
}

/** All user ids who should receive real-time updates for a task (creator + members). */
export async function getMyTaskAudience(taskId: number): Promise<number[]> {
  const [task, members] = await Promise.all([
    prisma.my_tasks.findUnique({ where: { id: taskId }, select: { created_by: true } }),
    prisma.my_task_members.findMany({ where: { task_id: taskId }, select: { user_id: true } }),
  ]);
  const ids = new Set<number>();
  if (task?.created_by) ids.add(task.created_by);
  members.forEach((m) => ids.add(m.user_id));
  return Array.from(ids);
}
