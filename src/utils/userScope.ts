import prisma from '../config/db.js';

/**
 * Module-aware user scoping for assignment / selection dropdowns.
 *
 * A user "belongs to" a module iff at least one of their (comma-separated) roles
 * grants a permission under that module's key prefixes. This mirrors the frontend
 * registry in `lib/permissions/moduleAccess.ts` (APP_MODULES.prefixes) so the two
 * never drift — adding a future module (finance, support, …) is a one-line change
 * HERE, with no per-endpoint hardcoding.
 *
 * Used to ensure every assignment dropdown shows only relevant users (e.g. Sales
 * pickers never list Developers/HR, and vice-versa) on the BACKEND, so unrelated
 * users are never even sent to the client.
 */
export const MODULE_PREFIXES: Record<string, string[]> = {
  sales: ['sales.'],
  development: ['dashboard.', 'project.', 'task.', 'sprints.', 'bugs.', 'blockers.', 'meetings.', 'tickets.'],
  hr: ['hr.'],
  user: ['user.', 'role.'],
  marketing: ['marketing.'],
};

/** The base/default module a user with no recognised module permission falls into. */
const DEFAULT_MODULE = 'development';

/** Global roles belong to EVERY module (mirrors the isGlobalAdmin / SuperAdmin bypass). */
function isGlobalRole(roleName: string): boolean {
  const n = roleName.toLowerCase().replace(/[\s_-]/g, '');
  return n === 'superadmin' || n === 'admin';
}

const ALL_PREFIXES: string[] = Object.values(MODULE_PREFIXES).flat();

export interface PickUser {
  id: number;
  name: string;
  email: string;
  role: string | null;
}

/**
 * Active users who belong to `module`.
 *
 * Rules (data-driven, no hardcoded user lists):
 *   • a global role (Admin / Super Admin) belongs to every module;
 *   • otherwise a user belongs to `module` iff a role of theirs grants ≥1
 *     permission under that module's prefixes;
 *   • a user whose roles grant NO recognised module permission (permissionless
 *     or default "User" role) falls back to the base module (development) so
 *     such users never vanish from the base pickers.
 */
export async function getUsersForModule(module: string): Promise<PickUser[]> {
  const [users, roles] = await Promise.all([
    prisma.users.findMany({
      where: { status: 'active' },
      select: { id: true, name: true, email: true, role: true },
      orderBy: { name: 'asc' },
    }),
    prisma.roles.findMany({ select: { name: true, permissions: true } }),
  ]);

  // role-name (lower-cased) → permission keys
  const permsByRole = new Map<string, string[]>();
  for (const r of roles) {
    const perms = Array.isArray(r.permissions) ? (r.permissions as string[]) : [];
    permsByRole.set(r.name.toLowerCase(), perms);
  }

  const prefixes = MODULE_PREFIXES[module] ?? [];

  const belongs = (roleField: string | null): boolean => {
    const names = (roleField || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    // No role at all → base module only.
    if (names.length === 0) return module === DEFAULT_MODULE;
    // Global admins are members of every module.
    if (names.some(isGlobalRole)) return true;

    // Union the permissions across all of the user's roles.
    const perms = new Set<string>();
    for (const n of names) {
      for (const p of permsByRole.get(n.toLowerCase()) ?? []) perms.add(p);
    }
    if (perms.size === 0) return module === DEFAULT_MODULE;

    // Holds a permission for THIS module?
    if ([...perms].some((p) => prefixes.some((pre) => p.startsWith(pre)))) return true;

    // Has permissions, but NONE map to any known module → base-module fallback.
    const inAnyModule = [...perms].some((p) => ALL_PREFIXES.some((pre) => p.startsWith(pre)));
    return !inAnyModule && module === DEFAULT_MODULE;
  };

  return users.filter((u) => belongs(u.role));
}
