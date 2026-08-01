/**
 * Sales coarse→granular permission bridge (backend mirror of the frontend
 * permission.utils logic). Sales has legacy COARSE keys that IMPLY the granular
 * per-feature keys, so routes can be gated purely on granular keys (1:1 with the
 * Development module) while roles still holding the coarse/master keys keep
 * working, and a role with ONLY granular keys is scoped exactly to them.
 *
 *   • `sales.view`   ⇒ every `sales.*.view` key (the "Full Sales Access" VISIBILITY
 *                     master — it unlocks tabs, NOT create/edit/delete actions)
 *   • `sales.create` ⇒ every `sales.*.create`
 *   • `sales.edit`   ⇒ every `sales.*.edit`
 *   • `sales.delete` ⇒ every `sales.*.delete`
 *
 * Non-sales keys and the coarse capability keys (assign / approve / *.manage / …)
 * are exact-match only, so the Development module is unaffected and a view-only
 * master role can never escalate to an action it was never granted.
 */
export function salesGrants(permissions: string[], key: string): boolean {
  if (!key.startsWith('sales.')) return false;
  if (key.endsWith('.view') && permissions.includes('sales.view')) return true;
  if (key.endsWith('.create') && permissions.includes('sales.create')) return true;
  if (key.endsWith('.edit') && permissions.includes('sales.edit')) return true;
  if (key.endsWith('.delete') && permissions.includes('sales.delete')) return true;
  return false;
}

/**
 * Finance coarse→granular VIEW bridge. `finance.view` (the module-access master)
 * implies every `finance.*.view` tab key, mirroring the Sales `sales.view` bridge
 * so a route may be gated on a granular finance view key while a coarse holder
 * still passes. It NEVER implies create/edit/delete (those stay exact-match), so
 * a view-only holder can never escalate to a write action.
 */
export function financeGrants(permissions: string[], key: string): boolean {
  if (!key.startsWith('finance.')) return false;
  if (key.endsWith('.view') && permissions.includes('finance.view')) return true;
  return false;
}

/**
 * HR coarse→granular bridge — the SAME mechanism as `salesGrants`, so HR routes
 * can be gated purely on granular keys (1:1 with the sidebar / Development model)
 * while the seeded roles that hold the legacy COARSE keys keep working with no
 * migration:
 *   • `hr.view`   ⇒ every `hr.*.view`   (module-access master)
 *   • `hr.create` ⇒ every `hr.*.create`
 *   • `hr.edit`   ⇒ every `hr.*.edit`
 *   • `hr.delete` ⇒ every `hr.*.delete`
 *   • `hr.attendance` (legacy capability) ⇒ the granular attendance WRITE keys
 *     (create/edit/delete) — preserves the self-service Employee role's ability
 *     to post attendance without granting it the attendance LIST view.
 * Capability keys (hr.payroll.process, hr.leave.approve, hr.performance.*) stay
 * exact-match, so a view-only holder can never escalate to a write action.
 */
export function hrGrants(permissions: string[], key: string): boolean {
  if (!key.startsWith('hr.')) return false;
  if (key.endsWith('.view') && permissions.includes('hr.view')) return true;
  if (key.endsWith('.create') && permissions.includes('hr.create')) return true;
  if (key.endsWith('.edit') && permissions.includes('hr.edit')) return true;
  if (key.endsWith('.delete') && permissions.includes('hr.delete')) return true;
  // Legacy coarse attendance capability → granular attendance write actions only.
  if (
    (key === 'hr.attendance.create' || key === 'hr.attendance.edit' || key === 'hr.attendance.delete') &&
    permissions.includes('hr.attendance')
  ) {
    return true;
  }
  return false;
}

/** True if `permissions` grants `required` (exact match or via a module bridge). */
export function permissionGranted(permissions: string[], required: string): boolean {
  return permissions.includes(required)
    || salesGrants(permissions, required)
    || financeGrants(permissions, required)
    || hrGrants(permissions, required);
}
