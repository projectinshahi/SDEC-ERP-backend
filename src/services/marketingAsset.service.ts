import prisma from '../config/db.js';
import { can, type SalesAuthContext } from '../utils/salesAuth.js';
import type { Denial } from './contentWorkflow.service.js';

/**
 * MK-002 — asset registry + booking rules.
 *
 * THE status definition lives here and is SERVED to the client (see
 * getAssetStatuses in the controller), so the frontend renders the list the
 * server enforces rather than keeping its own copy that can drift.
 */

export const REQUEST_STATUSES = ['requested', 'approved', 'rejected', 'cancelled'] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

export const REQUEST_STATUS_LABELS: Record<RequestStatus, string> = {
  requested: 'Requested',
  approved: 'Approved',
  rejected: 'Rejected',
  cancelled: 'Cancelled',
};

/** The ONLY status that reserves an asset. Everything else frees the slot. */
export const RESERVING_STATUS: RequestStatus = 'approved';

/* ── Permission keys ─────────────────────────────────────────────────────── */
export const ASSET_VIEW_KEY = 'marketing.assets.view';
/** Registry mutation (add / edit / deactivate / reactivate) — Admin-controlled. */
export const ASSET_MANAGE_KEY = 'marketing.assets.manage';
export const ASSET_REQUEST_KEY = 'marketing.assets.request';
export const ASSET_APPROVE_KEY = 'marketing.assets.approve';

export const canViewAssets = (ctx: SalesAuthContext) => can(ctx, ASSET_VIEW_KEY);
export const canManageAssets = (ctx: SalesAuthContext) => can(ctx, ASSET_MANAGE_KEY);
export const canRequestAssets = (ctx: SalesAuthContext) => can(ctx, ASSET_REQUEST_KEY);
export const canApproveAssets = (ctx: SalesAuthContext) => can(ctx, ASSET_APPROVE_KEY);

export type FieldErrors = Record<string, string>;

/* ── Asset validation ────────────────────────────────────────────────────── */

export interface AssetInput {
  name?: unknown;
  serialNumber?: unknown;
  category?: unknown;
  notes?: unknown;
}

export interface NormalisedAsset {
  name: string;
  serialNumber: string;
  category: string | null;
  notes: string | null;
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/**
 * @param existing  present for edits — only the supplied keys are re-checked,
 *                  so a partial PUT cannot blank a field it never sent.
 */
export function validateAsset(body: AssetInput, existing?: NormalisedAsset): { value?: NormalisedAsset; errors?: FieldErrors } {
  const errors: FieldErrors = {};

  const name = body.name !== undefined ? str(body.name) : (existing?.name ?? '');
  if (!name) errors.name = 'Asset name is required.';
  else if (name.length > 160) errors.name = 'Asset name must be 160 characters or fewer.';

  const serialNumber = body.serialNumber !== undefined ? str(body.serialNumber) : (existing?.serialNumber ?? '');
  if (!serialNumber) errors.serialNumber = 'Serial number is required.';
  else if (serialNumber.length > 80) errors.serialNumber = 'Serial number must be 80 characters or fewer.';

  let category = existing?.category ?? null;
  if (body.category !== undefined) {
    const raw = str(body.category);
    if (raw.length > 60) errors.category = 'Category must be 60 characters or fewer.';
    else category = raw || null;
  }

  const notes = body.notes !== undefined ? (str(body.notes) || null) : (existing?.notes ?? null);

  if (Object.keys(errors).length) return { errors };
  return { value: { name, serialNumber, category, notes } };
}

/* ── Booking window validation ───────────────────────────────────────────── */

export interface WindowInput { startAt?: unknown; endAt?: unknown }
export interface BookingWindow { startAt: Date; endAt: Date }

const parseInstant = (v: unknown): Date | null => {
  if (typeof v !== 'string' || !v.trim()) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

export function validateWindow(body: WindowInput): { value?: BookingWindow; errors?: FieldErrors } {
  const errors: FieldErrors = {};
  const startAt = parseInstant(body.startAt);
  const endAt = parseInstant(body.endAt);

  if (!startAt) errors.startAt = 'Enter a valid start date and time.';
  if (!endAt) errors.endAt = 'Enter a valid end date and time.';
  // Never silently swapped — the user is told which field is wrong.
  if (startAt && endAt && endAt <= startAt) errors.endAt = 'End must be after the start.';

  if (Object.keys(errors).length) return { errors };
  return { value: { startAt: startAt!, endAt: endAt! } };
}

/**
 * Approved bookings that collide with [startAt, endAt).
 *
 * HALF-OPEN intervals: `existing.start < new.end AND existing.end > new.start`.
 * So 10:00–12:00 and 12:00–14:00 do NOT collide — a handover at the boundary is
 * legal, which is what makes back-to-back bookings usable. This is the same
 * predicate the database's exclusion constraint applies, so the friendly check
 * here and the hard guarantee there can never disagree.
 */
export async function findConflicts(
  assetId: number,
  window: BookingWindow,
  excludeRequestId?: number,
): Promise<{ id: number; start_at: Date; end_at: Date; project_id: number }[]> {
  return prisma.marketing_asset_requests.findMany({
    where: {
      asset_id: assetId,
      status: RESERVING_STATUS,
      start_at: { lt: window.endAt },
      end_at: { gt: window.startAt },
      ...(excludeRequestId ? { id: { not: excludeRequestId } } : {}),
    },
    select: { id: true, start_at: true, end_at: true, project_id: true },
    orderBy: { start_at: 'asc' },
  });
}

/** Postgres raises 23P01 when the exclusion constraint rejects an overlap. */
export const isOverlapViolation = (e: unknown): boolean =>
  (e as { code?: string; meta?: { code?: string } } | null)?.code === '23P01'
  || (e as { meta?: { code?: string } } | null)?.meta?.code === '23P01'
  || /marketing_asset_requests_no_overlap/.test(String((e as Error | null)?.message ?? ''));

/** Postgres unique-violation (serial number), via Prisma or raw. */
export const isUniqueViolation = (e: unknown): boolean =>
  (e as { code?: string } | null)?.code === 'P2002'
  || (e as { code?: string } | null)?.code === '23505'
  || /marketing_assets_serial_key/.test(String((e as Error | null)?.message ?? ''));

/** May this actor act on this request? Requesters own their own cancellations. */
export function canCancel(ctx: SalesAuthContext, requesterId: number): boolean {
  return ctx.isAdmin || canApproveAssets(ctx) || ctx.userId === requesterId;
}

export function assetDenial(ctx: SalesAuthContext): Denial | null {
  return canViewAssets(ctx) ? null : { status: 403, message: 'You do not have permission to view Marketing assets.' };
}
