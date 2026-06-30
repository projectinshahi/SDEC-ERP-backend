import { Request } from 'express';
import prisma from '../config/db.js';
import { permissionGranted } from './salesPermissions.js';
import { isGlobalAdmin } from './roles.js';

/**
 * Controller-level permission helper for the Sales Execution Layer.
 *
 * Route-level access is already gated by `checkPermission(...)`; this helper is
 * for finer in-handler decisions (e.g. "can this user publish a *global* saved
 * view?", "can they see *another* owner's tasks?"). It mirrors the middleware:
 * Admin / Super Admin bypass everything, otherwise permissions come from the
 * role's JSON array.
 */
export interface SalesAuthContext {
  userId: number;
  roleName: string;
  isAdmin: boolean;
  permissions: string[];
}

export async function getSalesAuth(req: Request): Promise<SalesAuthContext> {
  const userId = Number((req as any).userId);
  const roleName = String((req as any).userRole || 'User');
  // Use the canonical normalized check (matches isGlobalAdmin used by the auth
  // middleware + every other controller) so ANY admin spelling — "Super Admin",
  // "SuperAdmin", "super_admin", "Admin", "admin" — is recognised. A strict
  // string match here previously blinded a Founder whose role had no space
  // ("SuperAdmin"), scoping the Sales dashboards to their own (empty) ownership.
  const isAdmin = isGlobalAdmin(roleName);

  if (isAdmin) return { userId, roleName, isAdmin, permissions: ['*'] };

  let permissions: string[] = [];
  try {
    const roles = await prisma.$queryRawUnsafe<any[]>(
      'SELECT permissions FROM roles WHERE LOWER(name) = LOWER($1) LIMIT 1;',
      roleName,
    );
    if (roles.length > 0 && roles[0].permissions) {
      const raw = roles[0].permissions;
      permissions = Array.isArray(raw) ? raw : JSON.parse(raw);
    }
  } catch {
    permissions = [];
  }
  return { userId, roleName, isAdmin, permissions };
}

/** True if the context grants the given permission key (exact or via the bridge). */
export function can(ctx: SalesAuthContext, key: string): boolean {
  return ctx.isAdmin || permissionGranted(ctx.permissions, key);
}

/** Managers/Admins get team-wide visibility (can see other owners' records). */
export function isManager(ctx: SalesAuthContext): boolean {
  return ctx.isAdmin || ctx.roleName.toLowerCase().includes('manager') || can(ctx, 'sales.assign');
}

/**
 * SE-028 — the owner ids a caller may view. Returns `null` to mean "ALL owners"
 * (admins; and — for backward-compat — managers not yet assigned a team, so they
 * are not blinded the day teams ship). Otherwise the caller's team set: self +
 * members of teams they manage, or their own team's members if they're a lead,
 * or just [self] for an individual BDE.
 */
export async function resolveTeamOwnerIds(ctx: SalesAuthContext): Promise<number[] | null> {
  if (ctx.isAdmin) return null;

  // Teams this user manages (owns).
  const managed = await prisma.salesTeam.findMany({
    where: { managerId: ctx.userId, archived: false },
    select: { members: { select: { userId: true } } },
  });
  if (managed.length > 0) {
    const ids = new Set<number>([ctx.userId]);
    for (const t of managed) for (const m of t.members) ids.add(m.userId);
    return [...ids];
  }

  // Team lead of their own team.
  const membership = await prisma.salesTeamMember.findUnique({
    where: { userId: ctx.userId },
    select: { role: true, team: { select: { archived: true, members: { select: { userId: true } } } } },
  });
  if (membership && membership.role === 'team_lead' && membership.team && !membership.team.archived) {
    const ids = new Set<number>([ctx.userId]);
    for (const m of membership.team.members) ids.add(m.userId);
    return [...ids];
  }

  // Backward-compat: a 'manager' (by role/sales.assign) with no team keeps the
  // legacy all-owners view rather than going blind.
  if (isManager(ctx)) return null;

  return [ctx.userId];
}

/**
 * RBAC list scoping for owner-keyed resources (leads / deals / customers).
 * Returns the value to assign to a Prisma `where.ownerId`:
 *   - `undefined` → no constraint (Admin / unteamed-legacy-manager: all rows),
 *   - a number    → a specific in-scope owner the caller explicitly requested,
 *   - `{ in: ids }`→ the caller's team scope (manager/lead) or [self] (BDE).
 * An explicit `requested` owner outside the caller's scope yields `{ in: [] }`
 * so nothing leaks. Mirrors resolveTeamOwnerIds (null = all owners).
 */
export async function ownerScopeFilter(
  ctx: SalesAuthContext,
  requested?: number,
): Promise<{ in: number[] } | number | undefined> {
  const ownerIds = await resolveTeamOwnerIds(ctx); // null = all owners
  if (ownerIds === null) return requested; // admin/unteamed: honour request, else all
  const allowed = ownerIds.length ? ownerIds : [ctx.userId];
  if (requested !== undefined) {
    return allowed.includes(requested) ? requested : { in: [] };
  }
  return { in: allowed };
}

/** Active Admin/Manager-role users — the global reporting-manager heuristic. */
export async function getGlobalManagerIds(): Promise<number[]> {
  const managers = await prisma.users.findMany({
    where: {
      status: 'active',
      OR: [
        { role: { contains: 'admin', mode: 'insensitive' } },
        { role: { contains: 'manager', mode: 'insensitive' } },
      ],
    },
    select: { id: true },
  });
  return managers.map((m) => m.id);
}

/**
 * Reporting tier — true for ORG-wide report visibility (Admin + Director, i.e.
 * holders of sales.reports.view). Managers are NOT org-wide; they stay team-
 * scoped. Kept separate from isManager so widening org access never accidentally
 * grants team-management side effects.
 */
export function canViewOrgReports(ctx: SalesAuthContext): boolean {
  return ctx.isAdmin || can(ctx, 'sales.reports.view');
}

/**
 * Owner-id scope for a report. null = ALL owners (org-wide: Admin / Director).
 * Otherwise delegates to resolveTeamOwnerIds (teamed Manager = team set, BDE =
 * self; unteamed manager keeps the legacy null/all per resolveTeamOwnerIds).
 */
export async function resolveReportScope(ctx: SalesAuthContext): Promise<number[] | null> {
  if (canViewOrgReports(ctx)) return null;
  return resolveTeamOwnerIds(ctx);
}

/**
 * SE-029 — reporting managers for a sales owner: the manager of the team the
 * owner belongs to, else the global manager heuristic. Always excludes the owner.
 */
export async function getReportingManagerIds(ownerId: number): Promise<number[]> {
  const membership = await prisma.salesTeamMember.findUnique({
    where: { userId: ownerId },
    select: { team: { select: { managerId: true, archived: true } } },
  });
  if (membership?.team && !membership.team.archived) {
    return membership.team.managerId === ownerId ? [] : [membership.team.managerId];
  }
  const global = await getGlobalManagerIds();
  return global.filter((id) => id !== ownerId);
}
