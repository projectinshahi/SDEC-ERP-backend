import { nearestDeadline } from './contentCard.service.js';

/**
 * M06 — THE shared Content Card query semantics.
 *
 * Kanban, the List/Table view and the Deadline view all build their `where`
 * here, so the three can never disagree about which cards exist. Before this
 * existed the board and the list ran two hand-written queries with different
 * rules (the board did not exclude archived cards at all), which is exactly how
 * "Kanban says 20, List says 18" happens.
 *
 * Only the SELECTED COLUMNS differ per view. The business semantics do not.
 */

/** Every team column a person can occupy on a card — the basis of both the
 *  Team Member filter and "My Cards". Kept in one place so the two can never
 *  drift apart (and so "My Cards" is never silently reduced to owner-only). */
export const TEAM_ASSIGNMENT_COLUMNS = [
  'owner_id', 'designer_id', 'videographer_id', 'editor_id',
  'scriptwriter_id', 'talent_id', 'approver_id',
] as const;

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const isYmd = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);

/**
 * Read a filter that may arrive once (`?priority=high`) or repeated
 * (`?priority=high&priority=urgent`) or comma-joined (`?priority=high,urgent`).
 * Multi-select filters are OR *within* the filter and AND *across* filters.
 */
function multi(v: unknown, allowed?: readonly string[]): string[] {
  const raw = Array.isArray(v) ? v : [v];
  const out: string[] = [];
  for (const item of raw) {
    for (const part of str(item).split(',')) {
      const t = part.trim();
      if (!t || t === 'all') continue;
      if (allowed && !allowed.includes(t)) continue;
      if (!out.includes(t)) out.push(t);
    }
  }
  return out;
}

const id = (v: unknown): number | null => {
  const n = Number(str(v));
  return Number.isInteger(n) && n > 0 ? n : null;
};

export interface ContentQueryOptions {
  /** Stage keys accepted by the caller's canonical pipeline. */
  allStages: readonly string[];
  platforms: readonly string[];
  priorities: readonly string[];
  formats: readonly string[];
  /** Authenticated user id — the ONLY source for `mine`; never read from the query. */
  actorId?: number;
  /** Stages where performance data is expected (Published / Analytics). */
  performanceStages: readonly string[];
}

/**
 * Build the Prisma `where` for a Content Card query from request query params.
 * Everything is AND-ed; multi-select values are OR-ed inside their own filter.
 */
export function buildContentCardWhere(q: Record<string, unknown>, opts: ContentQueryOptions): Record<string, unknown> {
  const where: Record<string, unknown> = {};
  const and: Record<string, unknown>[] = [];

  // Archived cards are excluded EVERYWHERE unless explicitly requested. This is
  // the rule the Kanban board was missing.
  where.archived = str(q.archived) === 'true' ? undefined : false;
  if (where.archived === undefined) delete where.archived;

  const stage = str(q.stage);
  if (stage && stage !== 'all' && opts.allStages.includes(stage)) where.stage = stage;

  /* MK-001.1 project scope. It lives HERE, in the one builder every view
   * already shares, so the project Kanban, the List and the Deadline view
   * cannot end up with three different ideas of which cards a project owns.
   * The controller separately AUTHORIZES the project before calling this —
   * parsing an id is not permission to read it. */
  const projectId = id(q.projectId);
  if (projectId) where.project_id = projectId;

  // ── Classification ────────────────────────────────────────────────────────
  const clientId = id(q.clientId);
  if (clientId) where.client_id = clientId;
  const categoryId = id(q.categoryId);
  if (categoryId) where.category_id = categoryId;
  const pillarId = id(q.pillarId);
  if (pillarId) where.pillar_id = pillarId;
  const campaignId = id(q.campaignId);
  if (campaignId) where.campaign_id = campaignId;

  // ── Multi-selects ─────────────────────────────────────────────────────────
  const formats = multi(q.format ?? q.formats ?? q.type, opts.formats);
  if (formats.length) where.format = { in: formats };

  const priorities = multi(q.priority ?? q.priorities, opts.priorities);
  if (priorities.length) where.priority = { in: priorities };

  // Platform(s): the multi-select `platforms` array is authoritative, but rows
  // created before M02 only have the legacy single column — so a match on
  // either counts, and no pre-M02 card silently disappears from a filter.
  const platforms = multi(q.platform ?? q.platforms, opts.platforms);
  if (platforms.length) {
    and.push({ OR: [{ platforms: { hasSome: platforms } }, { platform: { in: platforms } }] });
  }

  const objective = str(q.objective);
  if (objective && objective !== 'all') where.objective = { contains: objective, mode: 'insensitive' };

  // ── People ────────────────────────────────────────────────────────────────
  // Per-role filters (pre-existing behaviour, kept).
  for (const [param, col] of [
    ['ownerId', 'owner_id'], ['designerId', 'designer_id'],
    ['videographerId', 'videographer_id'], ['editorId', 'editor_id'],
    ['scriptwriterId', 'scriptwriter_id'], ['talentId', 'talent_id'], ['approverId', 'approver_id'],
  ] as const) {
    const v = id(q[param]);
    if (v) where[col] = v;
  }

  // Team Member: ANY assignment role on the card, not just owner.
  const teamMember = id(q.teamMember);
  if (teamMember) and.push({ OR: TEAM_ASSIGNMENT_COLUMNS.map((c) => ({ [c]: teamMember })) });

  // "My Cards" resolves from the AUTHENTICATED user only. A client-supplied id
  // is never honoured, so this can never widen what a caller can see.
  if (str(q.mine) === 'true' && opts.actorId) {
    and.push({ OR: TEAM_ASSIGNMENT_COLUMNS.map((c) => ({ [c]: opts.actorId })) });
  }

  /* ── M09 #42: Awaiting Performance Data ────────────────────────────────────
   * ONE condition, in the ONE filter builder every view already uses, so the
   * board, the list and the deadline view cannot return different sets.
   *
   * "Awaiting" = the card is Published (or in Performance / Analytics) AND has
   * no performance data. `has_performance_data` is the maintained mirror of
   * hasPerformanceData(metrics) — an indexed boolean, so this is a real SQL
   * predicate that filters BEFORE any pagination and never scans JSONB.
   * Because the flag is computed by that one rule, a metric of 0 correctly
   * counts as entered data and excludes the card. */
  if (str(q.awaitingPerformance) === 'true') {
    where.has_performance_data = false;
    // AND-ed with any stage filter already set, so a contradictory combination
    // simply returns nothing rather than silently widening the result.
    and.push({ stage: { in: [...opts.performanceStages] } });
  }

  // ── Dates & search ────────────────────────────────────────────────────────
  // Date-only column: bounds are built at UTC midnight to match how the column
  // is written, so a card never lands on the wrong side of a boundary.
  const deadline: Record<string, Date> = {};
  if (isYmd(q.deadlineFrom)) deadline.gte = new Date(`${q.deadlineFrom}T00:00:00.000Z`);
  if (isYmd(q.deadlineTo)) deadline.lte = new Date(`${q.deadlineTo}T00:00:00.000Z`);
  if (Object.keys(deadline).length) where.deadline = deadline;

  const search = str(q.search);
  if (search) {
    and.push({
      OR: [
        { title: { contains: search, mode: 'insensitive' } },
        { description: { contains: search, mode: 'insensitive' } },
        { content_id: { contains: search, mode: 'insensitive' } },
      ],
    });
  }

  if (and.length) where.AND = and;
  return where;
}

/**
 * Deadline-view predicate. The nearest deadline is derived from `production_data`
 * (JSONB) as well as the `deadline` column, so it cannot be expressed as a SQL
 * predicate without duplicating `nearestDeadline()` in SQL — which would be a
 * second implementation of the rule. It is applied to the already-filtered rows
 * instead, using the SAME function every view displays.
 */
export function hasAnyDeadline(row: { deadline?: Date | string | null; production_data?: unknown }): boolean {
  return nearestDeadline(row) !== null;
}
