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

/**
 * Developer-role detection for the Developer Performance module.
 *
 * `users.role` stores the role NAME (e.g. 'Developer', 'Senior Developer',
 * 'Full Stack Developer'). Developer roles are custom-created, so match every
 * variant by normalising (lowercase + strip spaces/_/-) and checking for the
 * 'developer' substring, plus the short form 'dev'. This INCLUDES Developer,
 * Senior/Junior/Full Stack/Frontend/Backend Developer, and EXCLUDES Sales,
 * Sales Manager, BDE, Admin, Director, HR, Finance, Viewer, etc.
 */
export function isDeveloperRole(role?: string | null): boolean {
  const normalized = (role || '').toLowerCase().replace(/[\s_-]/g, '');
  return normalized === 'dev' || normalized.includes('developer');
}
