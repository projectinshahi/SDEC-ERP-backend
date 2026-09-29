import prisma from '../config/db.js';
import { can, type SalesAuthContext } from '../utils/salesAuth.js';
import { RESERVING_STATUS } from './marketingAsset.service.js';
import type { Denial } from './contentWorkflow.service.js';

/**
 * MK-002.3 / MK-002.5 — physical custody and condition of an asset.
 *
 * Three states an asset can be in, and they are deliberately DIFFERENT columns
 * because they answer different questions:
 *   active              — is it in the registry at all? (MK-002.1 soft delete)
 *   maintenance_status  — is it physically usable?      (MK-002.5)
 *   an open checkout    — is somebody holding it now?   (MK-002.3)
 * A booking can be blocked by any of the three, so each is checked by name
 * rather than collapsed into one ambiguous "available" flag.
 */

export const MAINTENANCE_STATUSES = ['operational', 'under_maintenance'] as const;
export type MaintenanceStatus = (typeof MAINTENANCE_STATUSES)[number];

export const MAINTENANCE_STATUS_LABELS: Record<MaintenanceStatus, string> = {
  operational: 'Operational',
  under_maintenance: 'Under Maintenance',
};

export const MAINTENANCE_ACTIONS = ['flagged', 'restored'] as const;

/* ── Permission keys ─────────────────────────────────────────────────────── */
/** Taking an asset out / bringing it back. Rides the request authority: the
 *  people who may book equipment are the people who physically collect it. */
export const CHECKOUT_KEY = 'marketing.assets.request';
/** Flagging a fault is a duty of care — any team member who can see the
 *  registry may report one. Restoring it is registry management. */
export const MAINTENANCE_FLAG_KEY = 'marketing.assets.view';
export const MAINTENANCE_RESTORE_KEY = 'marketing.assets.manage';

export const canCheckout = (ctx: SalesAuthContext) => can(ctx, CHECKOUT_KEY);
export const canFlagMaintenance = (ctx: SalesAuthContext) => can(ctx, MAINTENANCE_FLAG_KEY);
export const canRestoreMaintenance = (ctx: SalesAuthContext) => can(ctx, MAINTENANCE_RESTORE_KEY);

export type FieldErrors = Record<string, string>;

/** The open (un-returned) checkout for an asset, or null. */
export async function findOpenCheckout(assetId: number): Promise<any | null> {
  const rows: any[] = await prisma.marketing_asset_checkouts.findMany({
    where: { asset_id: assetId, returned_at: null },
    take: 1,
  });
  return rows[0] ?? null;
}

/**
 * Is there an APPROVED booking overlapping right now?
 *
 * Used by MK-002.5: "an asset currently on an active booking cannot be flagged
 * without an admin override". "Currently" means the wall-clock instant, so a
 * booking that has already finished does not block a maintenance flag.
 */
export async function hasActiveBookingNow(assetId: number, at: Date = new Date()): Promise<boolean> {
  const n = await prisma.marketing_asset_requests.count({
    where: { asset_id: assetId, status: RESERVING_STATUS, start_at: { lte: at }, end_at: { gt: at } },
  });
  return n > 0;
}

/**
 * Every reason an asset cannot be taken out or newly booked, checked in a fixed
 * order so the message names the FIRST real obstacle rather than a generic
 * "unavailable". Shared by the booking path and the checkout path so the two can
 * never disagree about what "available" means.
 */
export function assetBlockers(asset: { active: boolean; maintenance_status: string; name: string }): Denial | null {
  if (!asset.active) {
    return { status: 409, message: `${asset.name} is inactive and cannot be booked or taken out.` };
  }
  if (asset.maintenance_status === 'under_maintenance') {
    return { status: 409, message: `${asset.name} is under maintenance and cannot be booked or taken out.` };
  }
  return null;
}

/** A maintenance note is mandatory when flagging, and whitespace is not a note. */
export function validateMaintenanceNote(raw: unknown): { note?: string; errors?: FieldErrors } {
  const note = typeof raw === 'string' ? raw.trim() : '';
  if (!note) return { errors: { note: 'A repair or maintenance note is required.' } };
  if (note.length > 2000) return { errors: { note: 'Note must be 2000 characters or fewer.' } };
  return { note };
}

/** Postgres unique-violation raised by the one-open-checkout partial index. */
export const isDuplicateCheckout = (e: unknown): boolean =>
  (e as { code?: string } | null)?.code === 'P2002'
  || (e as { code?: string } | null)?.code === '23505'
  || /marketing_asset_checkouts_one_open_key/.test(String((e as Error | null)?.message ?? ''));
