import prisma from '../config/db.js';
import { isGlobalAdmin } from './roles.js';
import { permissionGranted } from './salesPermissions.js';

/**
 * Authorization for the Development task and bug discussion rooms.
 *
 * These rooms mirror the REST rule for the SAME resource, deliberately, so
 * socket access can never be looser (or tighter) than the HTTP door it shadows:
 *
 *   task_<id>  →  `task.read`  (kanban read routes: GET /kanban/boards,
 *                               GET /kanban/boards/:id/tasks)
 *   bug_<id>   →  `bugs.read`  (GET /bugs, GET /bugs/:id, GET /bugs/:id/discussions)
 *
 * Neither module has a per-resource membership model — holding the permission
 * already grants read of every board/task and every bug over REST — so adding
 * membership HERE would invent a second, stricter permission system that the
 * REST API would immediately contradict. See canAccessMyTask for the module
 * that genuinely is membership-scoped.
 */

export interface RoomAccess {
  /** True only when the caller is allowed to enter the room. */
  allowed: boolean;
}

const DENY: RoomAccess = { allowed: false };
const ALLOW: RoomAccess = { allowed: true };

/** Postgres int4 ceiling — a larger id would error the query rather than miss. */
const MAX_INT4 = 2147483647;

/**
 * Does this user hold `required`? Exactly the rule checkPermission applies to
 * REST: an inactive/missing user holds nothing, a global admin holds
 * everything, otherwise the union of every assigned role's keys is run through
 * permissionGranted (which carries the coarse→granular bridges).
 *
 * Kept independent of Express so the socket can ask the same question a route
 * asks. ponytail: auth.middleware.checkPermission still has its own inline copy
 * of this lookup — migrating it to call this would leave one source of truth,
 * but Phase 2.6A.1 is explicitly not allowed to touch REST authorization.
 */
export async function userHasPermission(userId: number, required: string): Promise<boolean> {
  if (!Number.isInteger(userId) || userId <= 0 || userId > MAX_INT4) return false;

  // Parity with REST: a deactivated account holds no permissions at all.
  const users = await prisma.$queryRawUnsafe<any[]>(
    "SELECT role FROM users WHERE id = $1 AND LOWER(COALESCE(status, 'active')) <> 'inactive' LIMIT 1;",
    userId,
  );
  if (users.length === 0) return false;

  const roleNames = String(users[0].role ?? 'User')
    .split(',')
    .map((r) => r.trim())
    .filter(Boolean);
  if (roleNames.some((r) => isGlobalAdmin(r))) return true;

  // One query per role the USER holds (typically one). This does not grow with
  // the number of tasks/bugs/rooms, so it is not an N+1 on the resource.
  const granted = new Set<string>();
  for (const name of roleNames) {
    const roles = await prisma.$queryRawUnsafe<any[]>(
      'SELECT permissions FROM roles WHERE name = $1 OR LOWER(name) = LOWER($1) ORDER BY (name = $1) DESC LIMIT 1;',
      name,
    );
    const raw = roles[0]?.permissions;
    if (!raw) continue;
    try {
      const parsed = Array.isArray(raw) ? raw : JSON.parse(raw);
      if (Array.isArray(parsed)) parsed.forEach((p) => granted.add(String(p)));
    } catch {
      // A malformed permissions blob grants nothing rather than throwing.
    }
  }

  return permissionGranted(Array.from(granted), required);
}

/**
 * task_<id>: `task.read` plus the task existing. Permission is checked BEFORE
 * the lookup so a caller without it cannot use join timing/results to probe
 * which task ids are real, and every failure returns the same verdict.
 */
export async function canJoinTaskRoom(taskId: unknown, userId: number): Promise<RoomAccess> {
  // kanban_tasks.id is a VarChar(255), not a number.
  const id =
    typeof taskId === 'string'
      ? taskId.trim()
      : typeof taskId === 'number' && Number.isFinite(taskId)
        ? String(taskId)
        : '';
  if (!id || id.length > 255 || id === 'undefined' || id === 'null') return DENY;

  if (!(await userHasPermission(userId, 'task.read'))) return DENY;

  const rows = await prisma.$queryRawUnsafe<any[]>(
    'SELECT 1 AS ok FROM kanban_tasks WHERE id = $1 LIMIT 1;',
    id,
  );
  return rows.length > 0 ? ALLOW : DENY;
}

/** bug_<id>: `bugs.read` plus the bug existing. Same ordering and same verdict. */
export async function canJoinBugRoom(bugId: unknown, userId: number): Promise<RoomAccess> {
  const raw = typeof bugId === 'number' ? bugId : Number(String(bugId ?? '').trim());
  if (!Number.isInteger(raw) || raw <= 0 || raw > MAX_INT4) return DENY;

  if (!(await userHasPermission(userId, 'bugs.read'))) return DENY;

  const rows = await prisma.$queryRawUnsafe<any[]>(
    'SELECT 1 AS ok FROM bugs WHERE id = $1 LIMIT 1;',
    raw,
  );
  return rows.length > 0 ? ALLOW : DENY;
}
