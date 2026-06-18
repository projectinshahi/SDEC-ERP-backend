/**
 * Global-admin role detection, tolerant of every spelling this system stores.
 *
 * The SuperAdmin role has been written as 'SuperAdmin', 'Super Admin',
 * 'super admin' and 'superadmin' in different places, and `req.userRole`
 * surfaces whatever is in the DB. Several access checks only compared against
 * `'super admin'` (with a space) and therefore 403'd a SuperAdmin whose role
 * lowercases to `'superadmin'` (e.g. opening a project they aren't a member of
 * from the org-wide Master Dashboard). Normalise by lowercasing and stripping
 * spaces / underscores / hyphens before comparing so all variants match.
 */
export function isGlobalAdmin(role?: string | null): boolean {
  const normalized = (role || '').toLowerCase().replace(/[\s_-]/g, '');
  return normalized === 'superadmin' || normalized === 'admin';
}
