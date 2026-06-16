import { Request } from 'express';
import prisma from '../config/db.js';

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
  const isAdmin = roleName.toLowerCase() === 'super admin' || roleName.toLowerCase() === 'admin';

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

/** True if the context grants the given permission key. */
export function can(ctx: SalesAuthContext, key: string): boolean {
  return ctx.isAdmin || ctx.permissions.includes(key);
}

/** Managers/Admins get team-wide visibility (can see other owners' records). */
export function isManager(ctx: SalesAuthContext): boolean {
  return ctx.isAdmin || ctx.roleName.toLowerCase().includes('manager') || can(ctx, 'sales.assign');
}
