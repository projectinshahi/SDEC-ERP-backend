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

/** True if `permissions` grants `required` (exact match or via a module bridge). */
export function permissionGranted(permissions: string[], required: string): boolean {
  return permissions.includes(required) || salesGrants(permissions, required) || financeGrants(permissions, required);
}
