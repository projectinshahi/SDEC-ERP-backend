import type { Request, Response } from 'express';
import prisma from '../config/db.js';
import { getSalesAuth } from '../utils/salesAuth.js';
import { activityService } from '../services/activity.service.js';
import { RESERVING_STATUS } from '../services/marketingAsset.service.js';
import {
  MAINTENANCE_STATUS_LABELS,
  canCheckout, canFlagMaintenance, canRestoreMaintenance,
  findOpenCheckout, hasActiveBookingNow, assetBlockers,
  validateMaintenanceNote, isDuplicateCheckout,
} from '../services/marketingCheckout.service.js';

/**
 * MK-002.3 Asset checkout / return, and MK-002.5 condition & maintenance.
 *
 * Every timestamp here is server-generated. A client may ask to check an asset
 * out, but never says when — otherwise custody records could be back-dated.
 */

const uid = (req: Request) => Number((req as any).userId);
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const intId = (v: unknown): number | null => {
  const n = Number(typeof v === 'string' ? v.trim() : v);
  return Number.isInteger(n) && n > 0 ? n : null;
};

async function userNameMap(ids: (number | null)[]): Promise<Record<number, string>> {
  const unique = [...new Set(ids.filter((i): i is number => i != null))];
  if (!unique.length) return {};
  const users = await prisma.users.findMany({ where: { id: { in: unique } }, select: { id: true, name: true } });
  return Object.fromEntries(users.map((u) => [u.id, u.name]));
}

const serializeCheckout = (r: any, names: Record<number, string>) => ({
  id: r.id,
  assetId: r.asset_id,
  assetName: r.asset?.name ?? null,
  assetSerial: r.asset?.serial_number ?? null,
  requestId: r.request_id,
  projectId: r.project_id,
  projectName: r.project?.name ?? null,
  takerId: r.taker_id,
  takerName: names[r.taker_id] ?? null,
  checkedOutAt: r.checked_out_at,
  checkedOutBy: r.checked_out_by,
  checkedOutByName: names[r.checked_out_by] ?? null,
  returnedAt: r.returned_at,
  returnedBy: r.returned_by,
  returnedByName: r.returned_by ? names[r.returned_by] ?? null : null,
  notes: r.notes,
  /** Derived, never stored — the one place "still out" is decided. */
  open: r.returned_at === null,
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /marketing/asset-requests/:id/checkout
// ─────────────────────────────────────────────────────────────────────────────
export const checkoutAsset = async (req: Request, res: Response): Promise<any> => {
  try {
    const ctx = await getSalesAuth(req);
    if (!canCheckout(ctx)) {
      return res.status(403).json({ error: 'You do not have permission to check out Marketing assets.' });
    }

    const requestId = intId(req.params.id);
    if (!requestId) return res.status(400).json({ error: 'Invalid request id.' });

    const request: any = await prisma.marketing_asset_requests.findUnique({
      where: { id: requestId },
      include: { asset: true, project: { select: { id: true, name: true, status: true } } },
    });
    if (!request) return res.status(404).json({ error: 'Request not found.' });

    // Only an APPROVED booking may become a physical checkout. A pending or
    // rejected request confers no custody.
    if (request.status !== RESERVING_STATUS) {
      return res.status(409).json({
        error: `This request is ${request.status} — only an approved request can be checked out.`,
      });
    }

    const blocked = assetBlockers(request.asset);
    if (blocked) return res.status(blocked.status).json({ error: blocked.message });

    const already = await findOpenCheckout(request.asset_id);
    if (already) {
      return res.status(409).json({
        error: `${request.asset.name} is already checked out and has not been returned.`,
      });
    }

    const now = new Date();
    let row: any;
    try {
      row = await prisma.marketing_asset_checkouts.create({
        data: {
          asset_id: request.asset_id,
          request_id: request.id,
          // Project and taker come from the STORED request, never from the body:
          // custody follows the approved booking.
          project_id: request.project_id,
          taker_id: request.requester_id,
          checked_out_at: now,
          checked_out_by: ctx.userId,
          notes: str(req.body?.notes) || null,
        },
        include: { asset: true, project: { select: { name: true } } },
      });
    } catch (err) {
      // Lost the race: the partial unique index refused a second open checkout.
      if (isDuplicateCheckout(err)) {
        return res.status(409).json({
          error: `${request.asset.name} was just checked out by someone else.`,
        });
      }
      throw err;
    }

    const names = await userNameMap([row.taker_id, row.checked_out_by]);
    await activityService.logActivity({
      actorUserId: ctx.userId,
      type: 'marketing_asset_checked_out',
      description: `Checked out '${request.asset.name}' for ${request.project.name}`,
      metadata: {
        checkoutId: row.id, assetId: row.asset_id, requestId: row.request_id,
        projectId: row.project_id, takerId: row.taker_id, at: now.toISOString(),
      },
    });

    return res.status(201).json({ success: true, checkout: serializeCheckout(row, names) });
  } catch (error) {
    console.error('Error checking out asset:', error);
    return res.status(500).json({ error: 'Failed to check out the asset' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /marketing/asset-checkouts/:id/return
// ─────────────────────────────────────────────────────────────────────────────
export const returnAsset = async (req: Request, res: Response): Promise<any> => {
  try {
    const ctx = await getSalesAuth(req);
    if (!canCheckout(ctx)) {
      return res.status(403).json({ error: 'You do not have permission to return Marketing assets.' });
    }

    const id = intId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid checkout id.' });

    const existing: any = await prisma.marketing_asset_checkouts.findUnique({
      where: { id },
      include: { asset: { select: { name: true } }, project: { select: { name: true } } },
    });
    if (!existing) return res.status(404).json({ error: 'Checkout record not found.' });
    if (existing.returned_at) {
      return res.status(409).json({ error: 'That asset has already been returned.' });
    }

    const now = new Date();
    // Conditional on still being open, so two rapid returns produce ONE write.
    // The DB CHECK independently refuses returned_at < checked_out_at.
    const { count } = await prisma.marketing_asset_checkouts.updateMany({
      where: { id, returned_at: null },
      data: { returned_at: now, returned_by: ctx.userId },
    });
    if (count === 0) {
      return res.status(409).json({ error: 'That asset has already been returned.' });
    }

    const row: any = await prisma.marketing_asset_checkouts.findUnique({
      where: { id },
      include: { asset: true, project: { select: { name: true } } },
    });
    const names = await userNameMap([row.taker_id, row.checked_out_by, row.returned_by]);

    await activityService.logActivity({
      actorUserId: ctx.userId,
      type: 'marketing_asset_returned',
      description: `Returned '${existing.asset.name}' from ${existing.project.name}`,
      metadata: { checkoutId: id, assetId: existing.asset_id, at: now.toISOString() },
    });

    return res.json({ success: true, checkout: serializeCheckout(row, names) });
  } catch (error) {
    console.error('Error returning asset:', error);
    return res.status(500).json({ error: 'Failed to record the return' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /marketing/asset-checkouts?assetId=&open=
//   The custody ledger. READ-ONLY by design: there is no update or delete route
//   for a checkout row, for any role.
// ─────────────────────────────────────────────────────────────────────────────
export const getCheckouts = async (req: Request, res: Response): Promise<any> => {
  try {
    const ctx = await getSalesAuth(req);
    if (!canFlagMaintenance(ctx)) {
      return res.status(403).json({ error: 'You do not have permission to view Marketing assets.' });
    }

    const where: Record<string, unknown> = {};
    const assetId = intId(req.query.assetId);
    if (assetId) where.asset_id = assetId;
    if (str(req.query.open) === 'true') where.returned_at = null;

    const rows: any[] = await prisma.marketing_asset_checkouts.findMany({
      where,
      include: {
        asset: { select: { name: true, serial_number: true } },
        project: { select: { name: true } },
      },
      // Newest first; the ledger is append-only so this IS chronological order.
      orderBy: [{ checked_out_at: 'desc' }, { id: 'desc' }],
      take: 300,
    });
    const names = await userNameMap(rows.flatMap((r) => [r.taker_id, r.checked_out_by, r.returned_by]));

    return res.json({
      success: true,
      canCheckout: canCheckout(ctx),
      checkouts: rows.map((r) => serializeCheckout(r, names)),
    });
  } catch (error) {
    console.error('Error loading checkouts:', error);
    return res.status(500).json({ error: 'Failed to load the checkout history' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /marketing/assets/:id/maintenance — flag / restore
// ─────────────────────────────────────────────────────────────────────────────
export const setAssetMaintenance = async (req: Request, res: Response): Promise<any> => {
  try {
    const ctx = await getSalesAuth(req);

    const id = intId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid asset id.' });

    const action = str(req.body?.action);
    if (action !== 'flagged' && action !== 'restored') {
      return res.status(400).json({ error: "action must be 'flagged' or 'restored'." });
    }

    // Flagging a fault is a duty of care (any viewer); restoring is registry
    // management. Two different keys, checked here as well as at the route.
    if (action === 'flagged' && !canFlagMaintenance(ctx)) {
      return res.status(403).json({ error: 'You do not have permission to flag Marketing assets.' });
    }
    if (action === 'restored' && !canRestoreMaintenance(ctx)) {
      return res.status(403).json({ error: 'Only an administrator can mark an asset repaired.' });
    }

    const asset: any = await prisma.marketing_assets.findUnique({ where: { id } });
    if (!asset) return res.status(404).json({ error: 'Asset not found.' });

    let overrodeActiveBooking = false;

    if (action === 'flagged') {
      const { note, errors } = validateMaintenanceNote(req.body?.note);
      if (errors) return res.status(400).json({ error: errors.note, fieldErrors: errors });

      if (asset.maintenance_status === 'under_maintenance') {
        return res.json({ success: true, maintenanceStatus: asset.maintenance_status, changed: false });
      }

      /* MK-002.5 — an asset on an ACTIVE booking right now cannot be flagged
       * without an Admin override. The existing booking is never auto-cancelled:
       * the requirement says preserve it, and silently voiding someone's booking
       * would be inventing a workflow. */
      if (await hasActiveBookingNow(id)) {
        if (!ctx.isAdmin) {
          return res.status(409).json({
            error: `${asset.name} is currently out on an approved booking. An administrator must override to flag it for maintenance.`,
          });
        }
        overrodeActiveBooking = true;
      }

      const [row] = await prisma.$transaction([
        prisma.marketing_assets.update({ where: { id }, data: { maintenance_status: 'under_maintenance' } }),
        prisma.marketing_asset_maintenance.create({
          data: { asset_id: id, action: 'flagged', note: note!, actor_id: ctx.userId, overrode_active_booking: overrodeActiveBooking },
        }),
      ]);

      await activityService.logActivity({
        actorUserId: ctx.userId,
        type: 'marketing_asset_maintenance_flagged',
        description: `Flagged '${asset.name}' for maintenance`,
        metadata: { assetId: id, note, overrodeActiveBooking },
      });

      return res.json({
        success: true, changed: true, maintenanceStatus: (row as any).maintenance_status, overrodeActiveBooking,
      });
    }

    // ── restore ────────────────────────────────────────────────────────────
    if (asset.maintenance_status === 'operational') {
      return res.json({ success: true, maintenanceStatus: asset.maintenance_status, changed: false });
    }

    const note = str(req.body?.note) || null;
    const [row] = await prisma.$transaction([
      prisma.marketing_assets.update({ where: { id }, data: { maintenance_status: 'operational' } }),
      // The flag row is NOT deleted — the ledger keeps both events.
      prisma.marketing_asset_maintenance.create({
        data: { asset_id: id, action: 'restored', note, actor_id: ctx.userId },
      }),
    ]);

    await activityService.logActivity({
      actorUserId: ctx.userId,
      type: 'marketing_asset_maintenance_restored',
      description: `Marked '${asset.name}' repaired and available`,
      metadata: { assetId: id, note },
    });

    return res.json({ success: true, changed: true, maintenanceStatus: (row as any).maintenance_status });
  } catch (error) {
    console.error('Error updating maintenance state:', error);
    return res.status(500).json({ error: 'Failed to update the maintenance state' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /marketing/assets/:id/maintenance — immutable condition ledger
// ─────────────────────────────────────────────────────────────────────────────
export const getAssetMaintenance = async (req: Request, res: Response): Promise<any> => {
  try {
    const ctx = await getSalesAuth(req);
    if (!canFlagMaintenance(ctx)) {
      return res.status(403).json({ error: 'You do not have permission to view Marketing assets.' });
    }
    const id = intId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid asset id.' });

    const rows: any[] = await prisma.marketing_asset_maintenance.findMany({
      where: { asset_id: id },
      orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
      take: 100,
    });
    const names = await userNameMap(rows.map((r) => r.actor_id));

    return res.json({
      success: true,
      statuses: Object.entries(MAINTENANCE_STATUS_LABELS).map(([key, label]) => ({ key, label })),
      canRestore: canRestoreMaintenance(ctx),
      entries: rows.map((r) => ({
        id: r.id,
        action: r.action,
        note: r.note,
        actorId: r.actor_id,
        actorName: names[r.actor_id] ?? null,
        overrodeActiveBooking: r.overrode_active_booking,
        createdAt: r.created_at,
      })),
    });
  } catch (error) {
    console.error('Error loading maintenance history:', error);
    return res.status(500).json({ error: 'Failed to load the maintenance history' });
  }
};
