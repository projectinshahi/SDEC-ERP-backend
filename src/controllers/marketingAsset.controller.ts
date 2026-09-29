import type { Request, Response } from 'express';
import prisma from '../config/db.js';
import { getSalesAuth } from '../utils/salesAuth.js';
import { activityService } from '../services/activity.service.js';
import { notificationService } from '../services/notification.service.js';
import { resolveProject } from '../services/marketingProject.service.js';
import {
  REQUEST_STATUSES, REQUEST_STATUS_LABELS, RESERVING_STATUS,
  validateAsset, validateWindow, findConflicts,
  isOverlapViolation, isUniqueViolation, canCancel,
  canManageAssets, canRequestAssets, canApproveAssets, assetDenial,
  type NormalisedAsset,
} from '../services/marketingAsset.service.js';
import { assetBlockers, findOpenCheckout } from '../services/marketingCheckout.service.js';

/**
 * MK-002 — Marketing asset registry, booking requests and approvals.
 *
 * Authorization is re-derived per request from the session; the asset id,
 * project id and requester id in a payload are all re-resolved server-side.
 */

const uid = (req: Request) => Number((req as any).userId);
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const intId = (v: unknown): number | null => {
  const n = Number(typeof v === 'string' ? v.trim() : v);
  return Number.isInteger(n) && n > 0 ? n : null;
};

const DUPLICATE_SERIAL = 'An asset with that serial number already exists.';

async function userNameMap(ids: (number | null)[]): Promise<Record<number, string>> {
  const unique = [...new Set(ids.filter((i): i is number => i != null))];
  if (!unique.length) return {};
  const users = await prisma.users.findMany({ where: { id: { in: unique } }, select: { id: true, name: true } });
  return Object.fromEntries(users.map((u) => [u.id, u.name]));
}

const serializeAsset = (a: any) => ({
  id: a.id, name: a.name, serialNumber: a.serial_number, category: a.category,
  notes: a.notes, active: a.active, createdAt: a.created_at,
  maintenanceStatus: a.maintenance_status ?? 'operational',
  /* Derived from the ledger, never stored on the asset — one source of truth
   * for "who has it right now". */
  checkedOut: !!a.checkouts?.length,
  checkedOutBy: a.checkouts?.[0]?.taker_id ?? null,
  openCheckoutId: a.checkouts?.[0]?.id ?? null,
});

const serializeRequest = (r: any, names: Record<number, string>) => ({
  id: r.id,
  assetId: r.asset_id,
  assetName: r.asset?.name ?? null,
  assetSerial: r.asset?.serial_number ?? null,
  projectId: r.project_id,
  projectName: r.project?.name ?? null,
  requesterId: r.requester_id,
  requesterName: names[r.requester_id] ?? null,
  startAt: r.start_at,
  endAt: r.end_at,
  notes: r.notes,
  status: r.status,
  statusLabel: REQUEST_STATUS_LABELS[r.status as keyof typeof REQUEST_STATUS_LABELS] ?? r.status,
  decidedBy: r.decided_by,
  decidedByName: r.decided_by ? names[r.decided_by] ?? null : null,
  decidedAt: r.decided_at,
  decisionNote: r.decision_note,
  createdAt: r.created_at,
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /marketing/assets
// ─────────────────────────────────────────────────────────────────────────────
export const getAssets = async (req: Request, res: Response): Promise<any> => {
  try {
    const ctx = await getSalesAuth(req);
    const denial = assetDenial(ctx);
    if (denial) return res.status(denial.status).json({ error: denial.message });

    // Inactive assets are excluded unless explicitly requested — the registry's
    // "active list" and the archive are the same endpoint, one flag apart.
    const includeInactive = str(req.query.includeInactive) === 'true';

    const assets: any[] = await prisma.marketing_assets.findMany({
      where: includeInactive ? {} : { active: true },
      // ONE query for the open checkouts too — not a per-asset lookup.
      include: { checkouts: { where: { returned_at: null }, select: { id: true, taker_id: true }, take: 1 } },
      orderBy: [{ active: 'desc' }, { name: 'asc' }],
    });

    return res.json({
      success: true,
      canManage: canManageAssets(ctx),
      canRequest: canRequestAssets(ctx),
      canApprove: canApproveAssets(ctx),
      // Served, not duplicated in the client.
      statuses: REQUEST_STATUSES.map((key) => ({ key, label: REQUEST_STATUS_LABELS[key] })),
      assets: assets.map(serializeAsset),
    });
  } catch (error) {
    console.error('Error loading Marketing assets:', error);
    return res.status(500).json({ error: 'Failed to load the asset registry' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /marketing/assets
// ─────────────────────────────────────────────────────────────────────────────
export const createAsset = async (req: Request, res: Response): Promise<any> => {
  try {
    const ctx = await getSalesAuth(req);
    if (!canManageAssets(ctx)) {
      return res.status(403).json({ error: 'You do not have permission to manage the asset registry.' });
    }

    const { value, errors } = validateAsset(req.body ?? {});
    if (errors) return res.status(400).json({ error: 'Please fix the highlighted fields.', fieldErrors: errors });

    const row: any = await prisma.marketing_assets.create({
      data: {
        name: value!.name,
        serial_number: value!.serialNumber,
        category: value!.category,
        notes: value!.notes,
        created_by: uid(req),
      },
    });

    await activityService.logActivity({
      actorUserId: uid(req),
      type: 'marketing_asset_created',
      description: `Added asset '${row.name}' (${row.serial_number}) to the Marketing registry`,
      metadata: { assetId: row.id },
    });

    return res.status(201).json({ success: true, asset: serializeAsset(row) });
  } catch (error) {
    // The uniqueness guarantee is the DB index; this only translates it.
    if (isUniqueViolation(error)) {
      return res.status(409).json({ error: DUPLICATE_SERIAL, fieldErrors: { serialNumber: DUPLICATE_SERIAL } });
    }
    console.error('Error creating Marketing asset:', error);
    return res.status(500).json({ error: 'Failed to create the asset' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// PUT /marketing/assets/:id — partial edit
// ─────────────────────────────────────────────────────────────────────────────
export const updateAsset = async (req: Request, res: Response): Promise<any> => {
  try {
    const ctx = await getSalesAuth(req);
    if (!canManageAssets(ctx)) {
      return res.status(403).json({ error: 'You do not have permission to manage the asset registry.' });
    }

    const id = intId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid asset id.' });

    const existing = await prisma.marketing_assets.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: 'Asset not found.' });

    // Merged over the STORED row, so a payload carrying only `notes` cannot
    // blank the name or the serial number.
    const current: NormalisedAsset = {
      name: existing.name,
      serialNumber: existing.serial_number,
      category: existing.category,
      notes: existing.notes,
    };
    const { value, errors } = validateAsset(req.body ?? {}, current);
    if (errors) return res.status(400).json({ error: 'Please fix the highlighted fields.', fieldErrors: errors });

    const row: any = await prisma.marketing_assets.update({
      where: { id },
      data: {
        name: value!.name,
        serial_number: value!.serialNumber,
        category: value!.category,
        notes: value!.notes,
      },
    });

    await activityService.logActivity({
      actorUserId: uid(req),
      type: 'marketing_asset_updated',
      description: `Updated asset '${row.name}' (${row.serial_number})`,
      metadata: { assetId: row.id },
    });

    return res.json({ success: true, asset: serializeAsset(row) });
  } catch (error) {
    if (isUniqueViolation(error)) {
      return res.status(409).json({ error: DUPLICATE_SERIAL, fieldErrors: { serialNumber: DUPLICATE_SERIAL } });
    }
    console.error('Error updating Marketing asset:', error);
    return res.status(500).json({ error: 'Failed to update the asset' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /marketing/assets/:id/active — SOFT deactivate / reactivate
// ─────────────────────────────────────────────────────────────────────────────
export const setAssetActive = async (req: Request, res: Response): Promise<any> => {
  try {
    const ctx = await getSalesAuth(req);
    if (!canManageAssets(ctx)) {
      return res.status(403).json({ error: 'You do not have permission to manage the asset registry.' });
    }

    const id = intId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid asset id.' });

    const active = (req.body ?? {}).active;
    if (typeof active !== 'boolean') return res.status(400).json({ error: 'active must be true or false.' });

    const existing = await prisma.marketing_assets.findUnique({ where: { id }, select: { id: true, name: true, active: true } });
    if (!existing) return res.status(404).json({ error: 'Asset not found.' });

    // Idempotent: a second click neither errors nor writes a duplicate audit row.
    if (existing.active === active) {
      return res.json({ success: true, active: existing.active, changed: false });
    }

    // The row is UPDATED, never deleted — every historical request keeps a live
    // asset reference, and reactivating restores the same record rather than
    // creating a second one.
    const row: any = await prisma.marketing_assets.update({ where: { id }, data: { active } });

    await activityService.logActivity({
      actorUserId: uid(req),
      type: active ? 'marketing_asset_reactivated' : 'marketing_asset_deactivated',
      description: `${active ? 'Reactivated' : 'Deactivated'} asset '${existing.name}'`,
      metadata: { assetId: id },
    });

    return res.json({ success: true, active: row.active, changed: true });
  } catch (error) {
    console.error('Error changing asset state:', error);
    return res.status(500).json({ error: 'Failed to update the asset' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /marketing/asset-requests
// ─────────────────────────────────────────────────────────────────────────────
export const getAssetRequests = async (req: Request, res: Response): Promise<any> => {
  try {
    const ctx = await getSalesAuth(req);
    const denial = assetDenial(ctx);
    if (denial) return res.status(denial.status).json({ error: denial.message });

    const where: Record<string, unknown> = {};

    const assetId = intId(req.query.assetId);
    if (assetId) where.asset_id = assetId;

    const status = str(req.query.status);
    if (status && (REQUEST_STATUSES as readonly string[]).includes(status)) where.status = status;

    // `mine` resolves from the SESSION; a client-supplied requester id is never
    // honoured, so this can only ever narrow what the caller already sees.
    if (str(req.query.mine) === 'true') where.requester_id = ctx.userId;

    // Approvers see the queue; everyone else sees only their own requests, so a
    // plain member cannot enumerate the team's bookings.
    if (!canApproveAssets(ctx) && !ctx.isAdmin) where.requester_id = ctx.userId;

    const rows: any[] = await prisma.marketing_asset_requests.findMany({
      where,
      include: {
        asset: { select: { name: true, serial_number: true } },
        project: { select: { name: true } },
      },
      orderBy: [{ created_at: 'desc' }],
      take: 200,
    });
    const names = await userNameMap(rows.flatMap((r) => [r.requester_id, r.decided_by]));

    return res.json({
      success: true,
      canApprove: canApproveAssets(ctx),
      canRequest: canRequestAssets(ctx),
      statuses: REQUEST_STATUSES.map((key) => ({ key, label: REQUEST_STATUS_LABELS[key] })),
      requests: rows.map((r) => serializeRequest(r, names)),
    });
  } catch (error) {
    console.error('Error loading asset requests:', error);
    return res.status(500).json({ error: 'Failed to load asset requests' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /marketing/asset-requests
// ─────────────────────────────────────────────────────────────────────────────
export const createAssetRequest = async (req: Request, res: Response): Promise<any> => {
  try {
    const ctx = await getSalesAuth(req);
    if (!canRequestAssets(ctx)) {
      return res.status(403).json({ error: 'You do not have permission to request Marketing assets.' });
    }

    const b = req.body ?? {};
    const assetId = intId(b.assetId);
    if (!assetId) return res.status(400).json({ error: 'Choose an asset.', fieldErrors: { assetId: 'Choose an asset.' } });

    // The project is re-resolved and authorized — a request cannot be filed
    // under a project the caller cannot reach by editing the payload.
    const { project, denial } = await resolveProject(b.projectId, ctx, { write: true });
    if (denial) return res.status(denial.status).json({ error: denial.message, fieldErrors: { projectId: denial.message } });

    const { value: window, errors } = validateWindow(b);
    if (errors) return res.status(400).json({ error: 'Please fix the highlighted fields.', fieldErrors: errors });

    const asset: any = await prisma.marketing_assets.findUnique({
      where: { id: assetId }, select: { id: true, name: true, active: true, maintenance_status: true },
    });
    if (!asset) return res.status(404).json({ error: 'Asset not found.' });
    /* ONE availability rule, shared with the checkout path (assetBlockers), so
     * "inactive" and "under maintenance" can never be enforced in one place and
     * forgotten in the other. MK-002.5 requires this server-side — hiding the
     * asset from the dropdown is not enough. */
    const blocked = assetBlockers(asset);
    if (blocked) {
      return res.status(blocked.status).json({ error: blocked.message, fieldErrors: { assetId: blocked.message } });
    }

    // Friendly pre-check. The REAL guarantee is the exclusion constraint applied
    // at approval; this exists so the requester is told immediately rather than
    // waiting for an approver to discover the clash.
    const conflicts = await findConflicts(assetId, window!);
    if (conflicts.length) {
      return res.status(409).json({
        error: `${asset.name} is already booked for part of that period.`,
        conflicts: conflicts.map((c) => ({ startAt: c.start_at, endAt: c.end_at })),
        fieldErrors: { startAt: 'This period overlaps an approved booking.' },
      });
    }

    const row: any = await prisma.marketing_asset_requests.create({
      data: {
        asset_id: assetId,
        project_id: project!.id,
        // ALWAYS the authenticated caller — never a requesterId from the body.
        requester_id: ctx.userId,
        start_at: window!.startAt,
        end_at: window!.endAt,
        notes: str(b.notes) || null,
        status: 'requested',
      },
      include: { asset: { select: { name: true, serial_number: true } }, project: { select: { name: true } } },
    });
    const names = await userNameMap([row.requester_id]);

    await activityService.logActivity({
      actorUserId: ctx.userId,
      type: 'marketing_asset_requested',
      description: `Requested '${asset.name}' for ${project!.name}`,
      metadata: { requestId: row.id, assetId, projectId: project!.id, startAt: row.start_at, endAt: row.end_at },
    });

    return res.status(201).json({ success: true, request: serializeRequest(row, names) });
  } catch (error) {
    console.error('Error creating asset request:', error);
    return res.status(500).json({ error: 'Failed to submit the request' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /marketing/asset-requests/:id/decision — approve / reject
// ─────────────────────────────────────────────────────────────────────────────
export const decideAssetRequest = async (req: Request, res: Response): Promise<any> => {
  try {
    const ctx = await getSalesAuth(req);
    if (!canApproveAssets(ctx)) {
      return res.status(403).json({ error: 'You do not have permission to approve asset requests.' });
    }

    const id = intId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid request id.' });

    const decision = str((req.body ?? {}).decision);
    if (decision !== 'approved' && decision !== 'rejected') {
      return res.status(400).json({ error: 'Decision must be approved or rejected.' });
    }
    const note = str((req.body ?? {}).note) || null;

    const existing: any = await prisma.marketing_asset_requests.findUnique({
      where: { id },
      include: { asset: { select: { name: true, active: true } }, project: { select: { name: true } } },
    });
    if (!existing) return res.status(404).json({ error: 'Request not found.' });
    if (existing.status !== 'requested') {
      return res.status(409).json({ error: `This request has already been ${existing.status}.` });
    }
    // Re-checked at APPROVAL too: an asset can be deactivated or flagged for
    // maintenance between the request being filed and it being decided.
    if (decision === 'approved') {
      const blocked = assetBlockers(existing.asset);
      if (blocked) return res.status(blocked.status).json({ error: blocked.message });
    }

    /* Approval is the moment the asset is reserved, so it is the moment the
     * no-double-booking rule has to hold. `updateMany` scoped to the CURRENT
     * status is the optimistic-concurrency guard (a second approver's write
     * matches 0 rows), and the database's exclusion constraint is the
     * authoritative check — two approvals racing on overlapping windows cannot
     * both commit, whatever the application does. */
    let written = 0;
    try {
      const result = await prisma.marketing_asset_requests.updateMany({
        where: { id, status: 'requested' },
        data: {
          status: decision,
          decided_by: ctx.userId,
          decided_at: new Date(),
          decision_note: note,
        },
      });
      written = result.count;
    } catch (err) {
      if (isOverlapViolation(err)) {
        const conflicts = await findConflicts(existing.asset_id, { startAt: existing.start_at, endAt: existing.end_at }, id);
        return res.status(409).json({
          error: `${existing.asset.name} is already booked for part of that period — this request cannot be approved.`,
          conflicts: conflicts.map((c) => ({ startAt: c.start_at, endAt: c.end_at })),
        });
      }
      throw err;
    }

    if (written === 0) {
      return res.status(409).json({ error: 'That request was just decided by someone else. Reload to see the current status.' });
    }

    await activityService.logActivity({
      actorUserId: ctx.userId,
      type: `marketing_asset_${decision}`,
      description: `${decision === 'approved' ? 'Approved' : 'Rejected'} the request for '${existing.asset.name}' (${existing.project.name})`,
      metadata: {
        requestId: id, assetId: existing.asset_id, projectId: existing.project_id,
        requesterId: existing.requester_id, startAt: existing.start_at, endAt: existing.end_at, note,
      },
    });

    /* Decision notification — to the STORED requester, never to an id from the
     * request body, and using the existing notification service rather than a
     * second one. Sent once, after the write is known to have succeeded. */
    await notificationService.createNotification({
      userId: existing.requester_id,
      type: 'marketing_asset_decision',
      title: `Asset request ${decision}`,
      message: `Your request for ${existing.asset.name} (${existing.project.name}) was ${decision}${note ? `: ${note}` : '.'}`,
      entityId: id,
      entityType: 'marketing_asset_request',
    } as any);

    const row: any = await prisma.marketing_asset_requests.findUnique({
      where: { id },
      include: { asset: { select: { name: true, serial_number: true } }, project: { select: { name: true } } },
    });
    const names = await userNameMap([row!.requester_id, row!.decided_by]);
    return res.json({ success: true, request: serializeRequest(row, names) });
  } catch (error) {
    console.error('Error deciding asset request:', error);
    return res.status(500).json({ error: 'Failed to record the decision' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /marketing/asset-requests/:id/cancel — frees an approved slot
// ─────────────────────────────────────────────────────────────────────────────
export const cancelAssetRequest = async (req: Request, res: Response): Promise<any> => {
  try {
    const ctx = await getSalesAuth(req);
    const id = intId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid request id.' });

    const existing: any = await prisma.marketing_asset_requests.findUnique({
      where: { id },
      include: { asset: { select: { name: true } } },
    });
    if (!existing) return res.status(404).json({ error: 'Request not found.' });

    // The requester may cancel their own; approvers/Admins may cancel any.
    if (!canCancel(ctx, existing.requester_id)) {
      return res.status(403).json({ error: 'You do not have permission to cancel this request.' });
    }
    if (existing.status === 'cancelled') return res.json({ success: true, changed: false });
    if (existing.status === 'rejected') {
      return res.status(409).json({ error: 'A rejected request cannot be cancelled.' });
    }

    // Cancelling moves the row OUT of the 'approved' set the exclusion
    // constraint covers, so the slot genuinely reopens — no ghost reservation.
    const { count } = await prisma.marketing_asset_requests.updateMany({
      where: { id, status: { in: ['requested', 'approved'] } },
      data: { status: 'cancelled', decided_by: ctx.userId, decided_at: new Date() },
    });
    if (count === 0) return res.status(409).json({ error: 'That request was just changed. Reload to see the current status.' });

    await activityService.logActivity({
      actorUserId: ctx.userId,
      type: 'marketing_asset_cancelled',
      description: `Cancelled the booking for '${existing.asset.name}'`,
      metadata: { requestId: id, assetId: existing.asset_id },
    });

    // The requester is told when somebody ELSE cancels their booking.
    if (existing.requester_id !== ctx.userId) {
      await notificationService.createNotification({
        userId: existing.requester_id,
        type: 'marketing_asset_decision',
        title: 'Asset booking cancelled',
        message: `Your booking for ${existing.asset.name} was cancelled.`,
        entityId: id,
        entityType: 'marketing_asset_request',
      } as any);
    }

    return res.json({ success: true, changed: true });
  } catch (error) {
    console.error('Error cancelling asset request:', error);
    return res.status(500).json({ error: 'Failed to cancel the request' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /marketing/assets/availability?from=&to=
// ─────────────────────────────────────────────────────────────────────────────
export const getAssetAvailability = async (req: Request, res: Response): Promise<any> => {
  try {
    const ctx = await getSalesAuth(req);
    const denial = assetDenial(ctx);
    if (denial) return res.status(denial.status).json({ error: denial.message });

    const from = str(req.query.from) ? new Date(str(req.query.from)) : null;
    const to = str(req.query.to) ? new Date(str(req.query.to)) : null;
    const valid = (d: Date | null) => d && !Number.isNaN(d.getTime());

    // ONLY approved rows. A rejected or cancelled request reserves nothing, so
    // it can never appear as a booking here.
    const bookings: any[] = await prisma.marketing_asset_requests.findMany({
      where: {
        status: RESERVING_STATUS,
        ...(valid(from) ? { end_at: { gt: from! } } : {}),
        ...(valid(to) ? { start_at: { lt: to! } } : {}),
      },
      include: {
        asset: { select: { id: true, name: true, serial_number: true } },
        project: { select: { name: true } },
      },
      orderBy: [{ start_at: 'asc' }],
      take: 500,
    });
    const names = await userNameMap(bookings.map((b) => b.requester_id));

    return res.json({
      success: true,
      bookings: bookings.map((b) => ({
        requestId: b.id,
        assetId: b.asset_id,
        assetName: b.asset.name,
        assetSerial: b.asset.serial_number,
        projectName: b.project.name,
        requesterName: names[b.requester_id] ?? null,
        startAt: b.start_at,
        endAt: b.end_at,
      })),
    });
  } catch (error) {
    console.error('Error loading asset availability:', error);
    return res.status(500).json({ error: 'Failed to load availability' });
  }
};
