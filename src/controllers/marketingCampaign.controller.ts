import type { Request, Response } from 'express';
import prisma from '../config/db.js';
import { getSalesAuth, can } from '../utils/salesAuth.js';
import { activityService } from '../services/activity.service.js';
import {
  CAMPAIGN_VIEW_KEYS, CAMPAIGN_CREATE_KEYS, CAMPAIGN_EDIT_KEY, CAMPAIGN_DELETE_KEY,
  canAny, campaignMetrics, money, isYmd, ymdToDate, dateToYmd,
  PAYMENT_STATUSES, SPEND_COUNTING_PAYMENT_STATUSES, type PaymentStatus,
} from '../services/marketingFinance.service.js';

/**
 * MK-004.4 Performance marketing tracker + MK-004.5 Influencer tracker.
 *
 * Both are per-client records with money and dates, so they share this file and
 * the same validation helpers. Every derived rate (CPL, CPC, CTR, ROI) comes
 * from campaignMetrics() in the shared service — never computed here, and never
 * stored, so a rate can never disagree with the counters behind it.
 */

const uid = (req: Request) => Number((req as any).userId);
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const intId = (v: unknown): number | null => {
  const n = Number(typeof v === 'string' ? v.trim() : v);
  return Number.isInteger(n) && n > 0 ? n : null;
};

/** A whole non-negative count. Rejects '12abc', 1.5 and negatives rather than
 *  coercing them into something that looks valid. */
function wholeCount(v: unknown, label: string, errors: Record<string, string>, field: string): number {
  if (v === undefined || v === null || v === '') return 0;
  const raw = typeof v === 'string' ? v.trim() : v;
  const n = Number(raw);
  if (!Number.isFinite(n)) { errors[field] = `${label} must be a number.`; return 0; }
  if (n < 0) { errors[field] = `${label} cannot be negative.`; return 0; }
  if (!Number.isInteger(n)) { errors[field] = `${label} must be a whole number.`; return 0; }
  if (n > Number.MAX_SAFE_INTEGER) { errors[field] = `${label} is too large.`; return 0; }
  return n;
}

function amountField(v: unknown, label: string, errors: Record<string, string>, field: string): number {
  if (v === undefined || v === null || v === '') return 0;
  const n = Number(typeof v === 'string' ? v.trim() : v);
  if (!Number.isFinite(n)) { errors[field] = `${label} must be a number.`; return 0; }
  if (n < 0) { errors[field] = `${label} cannot be negative.`; return 0; }
  if (n > 1e12) { errors[field] = `${label} is too large.`; return 0; }
  return money(n);
}

/** Resolve and AUTHORIZE the client/project pair against the database. */
async function resolveScope(
  clientIdRaw: unknown, projectIdRaw: unknown, errors: Record<string, string>,
): Promise<{ clientId: number; projectId: number | null } | null> {
  const clientId = intId(clientIdRaw);
  if (!clientId) { errors.clientId = 'Client is required.'; return null; }
  const client = await prisma.marketing_clients.findFirst({
    where: { id: clientId, active: true }, select: { id: true },
  });
  if (!client) { errors.clientId = 'Client not found.'; return null; }

  let projectId: number | null = null;
  if (projectIdRaw !== undefined && projectIdRaw !== null && projectIdRaw !== '') {
    const pid = intId(projectIdRaw);
    const project = pid
      ? await prisma.marketing_projects.findFirst({ where: { id: pid, client_id: client.id }, select: { id: true } })
      : null;
    if (!project) { errors.projectId = 'That project does not belong to the selected client.'; return null; }
    projectId = project.id;
  }
  return { clientId: client.id, projectId };
}

/** Platform values come from the EXISTING marketing_platforms reference list —
 *  not a hardcoded array — so Administration stays the one place to change them. */
async function validPlatform(value: string, errors: Record<string, string>): Promise<string> {
  if (!value) { errors.platform = 'Platform is required.'; return ''; }
  const row = await prisma.marketing_platforms.findFirst({
    where: { name: { equals: value, mode: 'insensitive' }, active: true }, select: { name: true },
  });
  if (!row) { errors.platform = 'Choose a platform from the list.'; return ''; }
  return row.name;
}

function dateRange(
  startRaw: unknown, endRaw: unknown, errors: Record<string, string>,
): { start: string; end: string } | null {
  const start = str(startRaw), end = str(endRaw);
  if (!start) errors.startDate = 'Start date is required.';
  else if (!isYmd(start)) errors.startDate = 'Enter a valid start date.';
  if (!end) errors.endDate = 'End date is required.';
  else if (!isYmd(end)) errors.endDate = 'Enter a valid end date.';
  if (isYmd(start) && isYmd(end) && end < start) {
    errors.endDate = 'The end date cannot be earlier than the start date.';
  }
  return errors.startDate || errors.endDate ? null : { start, end };
}

const bad = (res: Response, errors: Record<string, string>) =>
  res.status(400).json({ error: 'Please fix the highlighted fields.', fieldErrors: errors });

/* ═══════════════════════ MK-004.4 — Ad campaigns ═══════════════════════════ */

const shapeCampaign = (c: any, projectName: string | null) => {
  const raw = {
    budget: Number(c.budget), spend: Number(c.spend),
    impressions: Number(c.impressions), clicks: Number(c.clicks),
    leads: Number(c.leads), revenue: Number(c.revenue),
  };
  return {
    id: c.id,
    clientId: c.client_id,
    projectId: c.project_id,
    projectName,
    name: c.name,
    platform: c.platform,
    budget: money(raw.budget),
    spend: money(raw.spend),
    startDate: dateToYmd(c.start_date),
    endDate: dateToYmd(c.end_date),
    impressions: raw.impressions,
    clicks: raw.clicks,
    leads: raw.leads,
    conversions: Number(c.conversions),
    revenue: money(raw.revenue),
    notes: c.notes,
    // Derived once, server-side, from the SAME numbers returned above.
    metrics: campaignMetrics(raw),
  };
};

export const getCampaigns = async (req: Request, res: Response): Promise<any> => {
  try {
    const ctx = await getSalesAuth(req);
    if (!canAny(ctx, CAMPAIGN_VIEW_KEYS)) {
      return res.status(403).json({ error: 'You do not have permission to view Marketing campaigns.' });
    }

    const clientId = intId(req.query.clientId);
    const platform = str(req.query.platform);
    const search = str(req.query.search);
    const from = isYmd(req.query.from) ? String(req.query.from) : null;
    const to = isYmd(req.query.to) ? String(req.query.to) : null;
    if (from && to && to < from) {
      return res.status(400).json({
        error: 'The end date cannot be earlier than the start date.',
        fieldErrors: { to: 'The end date cannot be earlier than the start date.' },
      });
    }

    const where: Record<string, unknown> = {};
    // Client scope keeps one client's campaigns out of another's totals.
    if (clientId) where.client_id = clientId;
    if (platform) where.platform = platform;
    if (search) where.name = { contains: search, mode: 'insensitive' };
    // A campaign overlapping the window, not merely starting inside it.
    if (from) where.end_date = { gte: ymdToDate(from) };
    if (to) where.start_date = { lte: ymdToDate(to) };

    const [rows, clients, platforms] = await Promise.all([
      prisma.marketing_ad_campaigns.findMany({
        where, orderBy: [{ start_date: 'desc' }, { id: 'desc' }], take: 500,
      }),
      prisma.marketing_clients.findMany({
        where: { active: true }, select: { id: true, name: true },
        orderBy: [{ sort_order: 'asc' }, { name: 'asc' }],
      }),
      prisma.marketing_platforms.findMany({
        where: { active: true }, select: { id: true, name: true },
        orderBy: [{ sort_order: 'asc' }, { name: 'asc' }],
      }),
    ]);

    // One batched lookup for project names rather than a query per row.
    const projectIds = [...new Set(rows.map((r) => r.project_id).filter((v): v is number => !!v))];
    const projects = projectIds.length
      ? await prisma.marketing_projects.findMany({ where: { id: { in: projectIds } }, select: { id: true, name: true } })
      : [];
    const projectName = new Map(projects.map((p) => [p.id, p.name]));

    const campaigns = rows.map((c) => shapeCampaign(c, c.project_id ? projectName.get(c.project_id) ?? null : null));
    const totals = campaigns.reduce(
      (a, c) => ({
        budget: a.budget + c.budget, spend: a.spend + c.spend,
        leads: a.leads + c.leads, clicks: a.clicks + c.clicks,
        impressions: a.impressions + c.impressions, revenue: a.revenue + c.revenue,
      }),
      { budget: 0, spend: 0, leads: 0, clicks: 0, impressions: 0, revenue: 0 },
    );

    return res.json({
      success: true,
      campaigns, clients, platforms,
      totals: {
        budget: money(totals.budget), spend: money(totals.spend),
        leads: totals.leads, clicks: totals.clicks, impressions: totals.impressions,
        revenue: money(totals.revenue),
        // Blended CPL over the filtered set, same divide-by-zero rule as a row.
        ...campaignMetrics(totals),
      },
      permissions: {
        canCreate: canAny(ctx, CAMPAIGN_CREATE_KEYS),
        canEdit: can(ctx, CAMPAIGN_EDIT_KEY) || canAny(ctx, CAMPAIGN_CREATE_KEYS),
        canDelete: can(ctx, CAMPAIGN_DELETE_KEY),
      },
    });
  } catch (error) {
    console.error('Error loading marketing campaigns:', error);
    return res.status(500).json({ error: 'Failed to load campaigns' });
  }
};

/**
 * Validation result as an EXPLICIT discriminated union. Left to inference, TS
 * widens the two return shapes into one object with two optional properties, and
 * `'errors' in checked` then narrows to `Record<string, string> | undefined`.
 */
type Checked<T> = { errors: Record<string, string> } | { value: T };

interface CampaignInput {
  clientId: number; projectId: number | null; name: string; platform: string;
  budget: number; spend: number; revenue: number;
  impressions: number; clicks: number; leads: number; conversions: number;
  startDate: string; endDate: string; notes: string | null;
}

interface InfluencerInput {
  clientId: number; projectId: number | null; name: string; handle: string | null;
  platform: string; fee: number; deliverables: string;
  startDate: string; endDate: string; notes: string | null;
}

async function validateCampaign(b: Record<string, any>): Promise<Checked<CampaignInput>> {
  const errors: Record<string, string> = {};
  const name = str(b.name);
  if (!name) errors.name = 'Campaign name is required.';
  else if (name.length > 255) errors.name = 'Campaign name must be 255 characters or fewer.';

  const scope = await resolveScope(b.clientId, b.projectId, errors);
  const platform = await validPlatform(str(b.platform), errors);
  const range = dateRange(b.startDate, b.endDate, errors);

  const budget = amountField(b.budget, 'Budget', errors, 'budget');
  const spend = amountField(b.spend, 'Spend', errors, 'spend');
  const revenue = amountField(b.revenue, 'Revenue', errors, 'revenue');
  const impressions = wholeCount(b.impressions, 'Impressions', errors, 'impressions');
  const clicks = wholeCount(b.clicks, 'Clicks', errors, 'clicks');
  const leads = wholeCount(b.leads, 'Leads', errors, 'leads');
  const conversions = wholeCount(b.conversions, 'Conversions', errors, 'conversions');

  // Real-world sanity: you cannot have more clicks than impressions, or more
  // leads than clicks. Catches a transposed pair before it poisons CTR/CPL.
  if (!errors.clicks && !errors.impressions && impressions > 0 && clicks > impressions) {
    errors.clicks = 'Clicks cannot exceed impressions.';
  }
  if (!errors.leads && !errors.clicks && clicks > 0 && leads > clicks) {
    errors.leads = 'Leads cannot exceed clicks.';
  }

  if (Object.keys(errors).length || !scope || !range) return { errors };
  return {
    value: {
      ...scope, name, platform, budget, spend, revenue,
      impressions, clicks, leads, conversions,
      startDate: range.start, endDate: range.end,
      notes: str(b.notes) || null,
    },
  };
}

export const createCampaign = async (req: Request, res: Response): Promise<any> => {
  try {
    const ctx = await getSalesAuth(req);
    if (!canAny(ctx, CAMPAIGN_CREATE_KEYS)) {
      return res.status(403).json({ error: 'You do not have permission to create Marketing campaigns.' });
    }
    const checked = await validateCampaign(req.body ?? {});
    if ('errors' in checked) return bad(res, checked.errors);
    const v = checked.value;

    const row = await prisma.marketing_ad_campaigns.create({
      data: {
        client_id: v.clientId, project_id: v.projectId, name: v.name, platform: v.platform,
        budget: v.budget, spend: v.spend, revenue: v.revenue,
        start_date: ymdToDate(v.startDate), end_date: ymdToDate(v.endDate),
        impressions: v.impressions, clicks: v.clicks, leads: v.leads, conversions: v.conversions,
        notes: v.notes, created_by: uid(req),
      },
    });
    await activityService.logActivity({
      actorUserId: uid(req), type: 'marketing_campaign_created',
      description: `Created ad campaign '${row.name}'`,
      metadata: { campaignId: row.id, clientId: v.clientId, platform: v.platform, budget: v.budget },
    });
    return res.status(201).json({ success: true, campaign: shapeCampaign(row, null) });
  } catch (error) {
    console.error('Error creating marketing campaign:', error);
    return res.status(500).json({ error: 'Failed to create the campaign' });
  }
};

export const updateCampaign = async (req: Request, res: Response): Promise<any> => {
  try {
    const ctx = await getSalesAuth(req);
    if (!can(ctx, CAMPAIGN_EDIT_KEY) && !canAny(ctx, CAMPAIGN_CREATE_KEYS)) {
      return res.status(403).json({ error: 'You do not have permission to edit Marketing campaigns.' });
    }
    const id = intId(req.params.id);
    if (!id) return res.status(404).json({ error: 'Campaign not found.' });
    const existing = await prisma.marketing_ad_campaigns.findUnique({ where: { id }, select: { id: true } });
    if (!existing) return res.status(404).json({ error: 'Campaign not found.' });

    const checked = await validateCampaign(req.body ?? {});
    if ('errors' in checked) return bad(res, checked.errors);
    const v = checked.value;

    // Every field is written together, so a partial payload can never blank an
    // unrelated column — the validator has already supplied a value for each.
    const row = await prisma.marketing_ad_campaigns.update({
      where: { id },
      data: {
        client_id: v.clientId, project_id: v.projectId, name: v.name, platform: v.platform,
        budget: v.budget, spend: v.spend, revenue: v.revenue,
        start_date: ymdToDate(v.startDate), end_date: ymdToDate(v.endDate),
        impressions: v.impressions, clicks: v.clicks, leads: v.leads, conversions: v.conversions,
        notes: v.notes, updated_at: new Date(),
      },
    });
    await activityService.logActivity({
      actorUserId: uid(req), type: 'marketing_campaign_updated',
      description: `Updated ad campaign '${row.name}'`,
      metadata: { campaignId: id, spend: v.spend, leads: v.leads },
    });
    return res.json({ success: true, campaign: shapeCampaign(row, null) });
  } catch (error) {
    console.error('Error updating marketing campaign:', error);
    return res.status(500).json({ error: 'Failed to update the campaign' });
  }
};

export const deleteCampaign = async (req: Request, res: Response): Promise<any> => {
  try {
    const ctx = await getSalesAuth(req);
    if (!can(ctx, CAMPAIGN_DELETE_KEY)) {
      return res.status(403).json({ error: 'You do not have permission to delete Marketing campaigns.' });
    }
    const id = intId(req.params.id);
    if (!id) return res.status(404).json({ error: 'Campaign not found.' });
    const existing = await prisma.marketing_ad_campaigns.findUnique({ where: { id }, select: { id: true, name: true } });
    if (!existing) return res.status(404).json({ error: 'Campaign not found.' });

    await prisma.marketing_ad_campaigns.delete({ where: { id } });
    await activityService.logActivity({
      actorUserId: uid(req), type: 'marketing_campaign_deleted',
      description: `Deleted ad campaign '${existing.name}'`, metadata: { campaignId: id },
    });
    return res.json({ success: true });
  } catch (error) {
    console.error('Error deleting marketing campaign:', error);
    return res.status(500).json({ error: 'Failed to delete the campaign' });
  }
};

/* ═══════════════════════ MK-004.5 — Influencers ════════════════════════════ */

const shapeInfluencer = (i: any, projectName: string | null) => ({
  id: i.id,
  clientId: i.client_id,
  projectId: i.project_id,
  projectName,
  name: i.name,
  handle: i.handle,
  platform: i.platform,
  fee: money(Number(i.fee)),
  deliverables: i.deliverables,
  startDate: dateToYmd(i.start_date),
  endDate: dateToYmd(i.end_date),
  paymentStatus: i.payment_status,
  paidAt: i.paid_at,
  notes: i.notes,
  /** Whether this row's fee is counted as client spend — derived from the one
   *  shared rule, so the tracker and the cost dashboard always agree. */
  countsAsSpend: (SPEND_COUNTING_PAYMENT_STATUSES as readonly string[]).includes(i.payment_status),
});

export const getInfluencers = async (req: Request, res: Response): Promise<any> => {
  try {
    const ctx = await getSalesAuth(req);
    if (!canAny(ctx, CAMPAIGN_VIEW_KEYS)) {
      return res.status(403).json({ error: 'You do not have permission to view influencer campaigns.' });
    }

    const clientId = intId(req.query.clientId);
    const platform = str(req.query.platform);
    const paymentStatus = str(req.query.paymentStatus);
    const search = str(req.query.search);

    const where: Record<string, unknown> = {};
    if (clientId) where.client_id = clientId;
    if (platform) where.platform = platform;
    if ((PAYMENT_STATUSES as readonly string[]).includes(paymentStatus)) where.payment_status = paymentStatus;
    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { handle: { contains: search, mode: 'insensitive' } },
      ];
    }

    const [rows, clients, platforms] = await Promise.all([
      prisma.marketing_influencers.findMany({
        where, orderBy: [{ start_date: 'desc' }, { id: 'desc' }], take: 500,
      }),
      prisma.marketing_clients.findMany({
        where: { active: true }, select: { id: true, name: true },
        orderBy: [{ sort_order: 'asc' }, { name: 'asc' }],
      }),
      prisma.marketing_platforms.findMany({
        where: { active: true }, select: { id: true, name: true },
        orderBy: [{ sort_order: 'asc' }, { name: 'asc' }],
      }),
    ]);

    const projectIds = [...new Set(rows.map((r) => r.project_id).filter((v): v is number => !!v))];
    const projects = projectIds.length
      ? await prisma.marketing_projects.findMany({ where: { id: { in: projectIds } }, select: { id: true, name: true } })
      : [];
    const projectName = new Map(projects.map((p) => [p.id, p.name]));
    const influencers = rows.map((i) => shapeInfluencer(i, i.project_id ? projectName.get(i.project_id) ?? null : null));

    return res.json({
      success: true,
      influencers, clients, platforms,
      paymentStatuses: PAYMENT_STATUSES,
      totals: {
        // `committed` is what reaches the cost dashboard: pending + paid.
        // Cancelled is reported separately so it is visible but never counted.
        committed: money(influencers.filter((i) => i.countsAsSpend).reduce((s, i) => s + i.fee, 0)),
        paid: money(influencers.filter((i) => i.paymentStatus === 'paid').reduce((s, i) => s + i.fee, 0)),
        pending: money(influencers.filter((i) => i.paymentStatus === 'pending').reduce((s, i) => s + i.fee, 0)),
        cancelled: money(influencers.filter((i) => i.paymentStatus === 'cancelled').reduce((s, i) => s + i.fee, 0)),
        count: influencers.length,
      },
      permissions: {
        canCreate: canAny(ctx, CAMPAIGN_CREATE_KEYS),
        canEdit: can(ctx, CAMPAIGN_EDIT_KEY) || canAny(ctx, CAMPAIGN_CREATE_KEYS),
        canDelete: can(ctx, CAMPAIGN_DELETE_KEY),
      },
    });
  } catch (error) {
    console.error('Error loading influencer campaigns:', error);
    return res.status(500).json({ error: 'Failed to load influencer campaigns' });
  }
};

async function validateInfluencer(b: Record<string, any>): Promise<Checked<InfluencerInput>> {
  const errors: Record<string, string> = {};
  const name = str(b.name);
  if (!name) errors.name = 'Influencer name is required.';
  else if (name.length > 255) errors.name = 'Influencer name must be 255 characters or fewer.';

  const handle = str(b.handle);
  if (handle.length > 255) errors.handle = 'Handle must be 255 characters or fewer.';

  const scope = await resolveScope(b.clientId, b.projectId, errors);
  const platform = await validPlatform(str(b.platform), errors);
  const range = dateRange(b.startDate, b.endDate, errors);

  // The agreed fee is the point of the record, so unlike a campaign budget it
  // must actually be entered.
  const rawFee = typeof b.fee === 'string' ? b.fee.trim() : b.fee;
  let fee = 0;
  if (rawFee === '' || rawFee === null || rawFee === undefined) errors.fee = 'Agreed fee is required.';
  else {
    const n = Number(rawFee);
    if (!Number.isFinite(n)) errors.fee = 'Agreed fee must be a number.';
    else if (n < 0) errors.fee = 'Agreed fee cannot be negative.';
    else if (n > 1e12) errors.fee = 'Agreed fee is too large.';
    else fee = money(n);
  }

  const deliverables = str(b.deliverables);
  if (!deliverables) errors.deliverables = 'Deliverables are required.';
  else if (deliverables.length > 2000) errors.deliverables = 'Deliverables must be 2000 characters or fewer.';

  if (Object.keys(errors).length || !scope || !range) return { errors };
  return {
    value: {
      ...scope, name, handle: handle || null, platform, fee, deliverables,
      startDate: range.start, endDate: range.end, notes: str(b.notes) || null,
    },
  };
}

export const createInfluencer = async (req: Request, res: Response): Promise<any> => {
  try {
    const ctx = await getSalesAuth(req);
    if (!canAny(ctx, CAMPAIGN_CREATE_KEYS)) {
      return res.status(403).json({ error: 'You do not have permission to create influencer campaigns.' });
    }
    const checked = await validateInfluencer(req.body ?? {});
    if ('errors' in checked) return bad(res, checked.errors);
    const v = checked.value;

    const row = await prisma.marketing_influencers.create({
      data: {
        client_id: v.clientId, project_id: v.projectId, name: v.name, handle: v.handle,
        platform: v.platform, fee: v.fee, deliverables: v.deliverables,
        start_date: ymdToDate(v.startDate), end_date: ymdToDate(v.endDate),
        // A new record always starts pending; a caller cannot post it as
        // already-paid and skip the payment transition.
        payment_status: 'pending',
        notes: v.notes, created_by: uid(req),
      },
    });
    await activityService.logActivity({
      actorUserId: uid(req), type: 'marketing_influencer_created',
      description: `Added influencer campaign '${row.name}'`,
      metadata: { influencerId: row.id, clientId: v.clientId, platform: v.platform, fee: v.fee },
    });
    return res.status(201).json({ success: true, influencer: shapeInfluencer(row, null) });
  } catch (error) {
    console.error('Error creating influencer campaign:', error);
    return res.status(500).json({ error: 'Failed to create the influencer campaign' });
  }
};

export const updateInfluencer = async (req: Request, res: Response): Promise<any> => {
  try {
    const ctx = await getSalesAuth(req);
    if (!can(ctx, CAMPAIGN_EDIT_KEY) && !canAny(ctx, CAMPAIGN_CREATE_KEYS)) {
      return res.status(403).json({ error: 'You do not have permission to edit influencer campaigns.' });
    }
    const id = intId(req.params.id);
    if (!id) return res.status(404).json({ error: 'Influencer campaign not found.' });
    const existing = await prisma.marketing_influencers.findUnique({
      where: { id }, select: { id: true, payment_status: true, name: true },
    });
    if (!existing) return res.status(404).json({ error: 'Influencer campaign not found.' });

    const checked = await validateInfluencer(req.body ?? {});
    if ('errors' in checked) return bad(res, checked.errors);
    const v = checked.value;

    /* A PAID payout is a settled financial fact, so its fee is frozen. The rest
     * of the record (deliverables, notes, dates) stays editable — freezing the
     * whole row would be inventing a restriction the workflow does not need. */
    const feeLocked = existing.payment_status === 'paid';
    if (feeLocked && v.fee !== money(Number(
      (await prisma.marketing_influencers.findUnique({ where: { id }, select: { fee: true } }))!.fee))) {
      return bad(res, { fee: 'The fee cannot be changed after the payout is marked paid.' });
    }

    const row = await prisma.marketing_influencers.update({
      where: { id },
      data: {
        client_id: v.clientId, project_id: v.projectId, name: v.name, handle: v.handle,
        platform: v.platform, deliverables: v.deliverables,
        ...(feeLocked ? {} : { fee: v.fee }),
        start_date: ymdToDate(v.startDate), end_date: ymdToDate(v.endDate),
        notes: v.notes, updated_at: new Date(),
      },
    });
    await activityService.logActivity({
      actorUserId: uid(req), type: 'marketing_influencer_updated',
      description: `Updated influencer campaign '${row.name}'`, metadata: { influencerId: id },
    });
    return res.json({ success: true, influencer: shapeInfluencer(row, null) });
  } catch (error) {
    console.error('Error updating influencer campaign:', error);
    return res.status(500).json({ error: 'Failed to update the influencer campaign' });
  }
};

/**
 * PATCH /marketing/influencers/:id/payment — the payment status transition.
 *
 * Kept OFF the general update endpoint so the legal-transition rule lives in one
 * place and an ordinary edit cannot move money state as a side effect.
 */
export const setInfluencerPayment = async (req: Request, res: Response): Promise<any> => {
  try {
    const ctx = await getSalesAuth(req);
    if (!can(ctx, CAMPAIGN_EDIT_KEY) && !canAny(ctx, CAMPAIGN_CREATE_KEYS)) {
      return res.status(403).json({ error: 'You do not have permission to change payment status.' });
    }
    const id = intId(req.params.id);
    if (!id) return res.status(404).json({ error: 'Influencer campaign not found.' });

    const next = str(req.body?.paymentStatus).toLowerCase() as PaymentStatus;
    if (!(PAYMENT_STATUSES as readonly string[]).includes(next)) {
      return bad(res, { paymentStatus: 'Choose Pending, Paid or Cancelled.' });
    }

    const existing = await prisma.marketing_influencers.findUnique({
      where: { id }, select: { id: true, payment_status: true, name: true, fee: true },
    });
    if (!existing) return res.status(404).json({ error: 'Influencer campaign not found.' });
    const current = existing.payment_status as PaymentStatus;
    if (current === next) return res.json({ success: true, unchanged: true });

    /* Legal transitions. Pending is the only open state; paid and cancelled are
     * both settled. Reversing a settled payout is an accounting correction, so
     * it is allowed ONLY to a holder of the approval-grade key rather than being
     * silently irreversible or casually reversible. */
    const settled = current === 'paid' || current === 'cancelled';
    if (settled && !can(ctx, CAMPAIGN_DELETE_KEY)) {
      return res.status(409).json({
        error: current === 'paid'
          ? 'This payout is already marked paid. Reversing it requires a manager.'
          : 'This payout was cancelled. Reopening it requires a manager.',
      });
    }

    await prisma.marketing_influencers.update({
      where: { id },
      data: {
        payment_status: next,
        // The paid timestamp is set when it becomes paid and cleared when it
        // stops being paid, so it never describes a state the row is not in.
        paid_at: next === 'paid' ? new Date() : null,
        updated_at: new Date(),
      },
    });
    await activityService.logActivity({
      actorUserId: uid(req), type: 'marketing_influencer_payment',
      description: `Marked '${existing.name}' payout as ${next}`,
      metadata: { influencerId: id, from: current, to: next, fee: Number(existing.fee) },
    });

    const row = await prisma.marketing_influencers.findUnique({ where: { id } });
    return res.json({ success: true, influencer: shapeInfluencer(row, null) });
  } catch (error) {
    console.error('Error updating influencer payment status:', error);
    return res.status(500).json({ error: 'Failed to update the payment status' });
  }
};

export const deleteInfluencer = async (req: Request, res: Response): Promise<any> => {
  try {
    const ctx = await getSalesAuth(req);
    if (!can(ctx, CAMPAIGN_DELETE_KEY)) {
      return res.status(403).json({ error: 'You do not have permission to delete influencer campaigns.' });
    }
    const id = intId(req.params.id);
    if (!id) return res.status(404).json({ error: 'Influencer campaign not found.' });
    const existing = await prisma.marketing_influencers.findUnique({
      where: { id }, select: { id: true, name: true, payment_status: true },
    });
    if (!existing) return res.status(404).json({ error: 'Influencer campaign not found.' });
    if (existing.payment_status === 'paid') {
      return res.status(409).json({ error: 'A paid influencer payout cannot be deleted.' });
    }

    await prisma.marketing_influencers.delete({ where: { id } });
    await activityService.logActivity({
      actorUserId: uid(req), type: 'marketing_influencer_deleted',
      description: `Deleted influencer campaign '${existing.name}'`, metadata: { influencerId: id },
    });
    return res.json({ success: true });
  } catch (error) {
    console.error('Error deleting influencer campaign:', error);
    return res.status(500).json({ error: 'Failed to delete the influencer campaign' });
  }
};
