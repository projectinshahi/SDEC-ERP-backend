/**
 * Shared Lead list filter builder.
 *
 * SINGLE SOURCE for turning the Sales Pipeline query-string filters into a Prisma
 * `where`. Used by the leads list (getLeads) AND the Sales Performance report
 * endpoint, so both apply IDENTICAL filter semantics — the report can never drift
 * from what the board shows. Owner SCOPE (RBAC / My-vs-All) is applied by the
 * caller via leadOwnerScopeFilter AFTER this, so this stays a pure filter map.
 */

export interface LeadQueryFilters {
  source?: unknown;
  status?: unknown;
  stage?: unknown;
  ownerId?: unknown;
  flaggedForReview?: unknown;
  search?: unknown;
  location?: unknown;
  active?: unknown;
  fromDate?: unknown;
  toDate?: unknown;
  temperature?: unknown;
  district?: unknown;
}

// Statuses that mean a lead has left the active pipeline (mirrors sales.controller).
const INACTIVE_LEAD_STATUSES = ['disqualified', 'converted', 'won', 'lost', 'closed'];

export function buildLeadWhere(query: LeadQueryFilters): Record<string, any> {
  const {
    source, status, stage, ownerId, flaggedForReview, search,
    location, active, fromDate, toDate, temperature, district,
  } = query;

  const where: any = {};

  if (typeof fromDate === 'string' && fromDate.trim()) {
    where.createdAt = { ...where.createdAt, gte: new Date(fromDate) };
  }
  if (typeof toDate === 'string' && toDate.trim()) {
    const to = new Date(toDate);
    to.setUTCHours(23, 59, 59, 999);
    where.createdAt = { ...where.createdAt, lte: to };
  }
  if (typeof source === 'string' && source.trim() && source !== 'all') {
    where.source = source.trim().toLowerCase();
  }
  if (typeof status === 'string' && status.trim() && status !== 'all') {
    where.status = status.trim().toLowerCase();
  }
  if (active === 'true') {
    where.status = { notIn: INACTIVE_LEAD_STATUSES };
  }
  if (typeof stage === 'string' && stage.trim() && stage !== 'all') {
    where.stage = stage.trim();
  }
  if (typeof ownerId === 'string' && ownerId.trim() && ownerId !== 'all') {
    const owner = Number(ownerId);
    if (!isNaN(owner)) where.ownerId = owner;
  }
  if (typeof temperature === 'string' && temperature.trim() && temperature !== 'all') {
    where.temperature = temperature.trim().toUpperCase();
  }
  if (typeof district === 'string' && district.trim() && district !== 'all') {
    const picked = district.split(',').map((d) => d.trim()).filter(Boolean);
    if (picked.length) where.district = picked.length === 1 ? picked[0] : { in: picked };
  }
  if (typeof location === 'string' && location.trim()) {
    where.customer = { is: { address: { contains: location.trim(), mode: 'insensitive' } } };
  }
  if (flaggedForReview === 'true') where.flaggedForReview = true;
  if (typeof search === 'string' && search.trim()) {
    const term = search.trim();
    where.OR = [
      { title: { contains: term, mode: 'insensitive' } },
      { customer: { is: { company: { contains: term, mode: 'insensitive' } } } },
      { customer: { is: { email: { contains: term, mode: 'insensitive' } } } },
      { customer: { is: { phone: { contains: term, mode: 'insensitive' } } } },
      { customer: { is: { name: { contains: term, mode: 'insensitive' } } } },
    ];
  }

  return where;
}
