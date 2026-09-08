import prisma from '../config/db.js';

/**
 * Content Card (M02) — the single authoritative implementation of the Content
 * Card business rules: Content ID generation, Content Type classification,
 * conditional production fields and the nearest-deadline calculation.
 *
 * Create, update and list all go through here, so none of these rules can drift
 * between endpoints or be re-implemented in the frontend.
 */

/* ── Content Type ──────────────────────────────────────────────────────────── */
export const CONTENT_TYPES = ['poster', 'carousel', 'reel', 'video'] as const;
export type ContentType = (typeof CONTENT_TYPES)[number];

/** Design-side types show Dimensions / Slide Count / Design Reference. */
const DESIGN_TYPES: readonly string[] = ['poster', 'carousel'];
/** Shoot-side types show Location / Props / Equipment / Shoot Date / Edit Deadline. */
const SHOOT_TYPES: readonly string[] = ['reel', 'video'];

export const isDesignType = (t?: string | null): boolean => !!t && DESIGN_TYPES.includes(t);
export const isShootType = (t?: string | null): boolean => !!t && SHOOT_TYPES.includes(t);

/**
 * Production data shape. BOTH sets are stored side by side and neither is ever
 * cleared when the Content Type changes — switching type only changes which set
 * is displayed, so previously entered values survive a round trip
 * (Poster → Reel → Poster) exactly as required.
 */
export interface ProductionData {
  design?: {
    dimensions?: string | null;
    slideCount?: number | null;
    designReference?: string | null;
  };
  shoot?: {
    location?: string | null;
    props?: string | null;
    equipment?: string | null;
    shootDate?: string | null;   // YYYY-MM-DD
    editDeadline?: string | null; // YYYY-MM-DD
  };
}

const isYmd = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
const str = (v: unknown, max = 255): string | null => {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t ? t.slice(0, max) : null;
};

/**
 * Merge an incoming production patch over what is already stored, per section.
 * A section that is absent from the patch is left untouched — so saving while
 * Poster fields are on screen can never wipe previously entered Reel fields.
 */
export function mergeProductionData(existing: unknown, patch: unknown): ProductionData {
  const base: ProductionData = (existing && typeof existing === 'object' ? existing : {}) as ProductionData;
  if (!patch || typeof patch !== 'object') return base;
  const p = patch as ProductionData;
  const out: ProductionData = { ...base };

  if (p.design && typeof p.design === 'object') {
    const d = p.design;
    const slide = d.slideCount;
    out.design = {
      ...(base.design ?? {}),
      ...(d.dimensions !== undefined ? { dimensions: str(d.dimensions, 60) } : {}),
      ...(slide !== undefined
        ? { slideCount: slide === null || slide === ('' as unknown) ? null : Number.isFinite(Number(slide)) ? Math.max(0, Math.trunc(Number(slide))) : null }
        : {}),
      ...(d.designReference !== undefined ? { designReference: str(d.designReference, 500) } : {}),
    };
  }
  if (p.shoot && typeof p.shoot === 'object') {
    const s = p.shoot;
    out.shoot = {
      ...(base.shoot ?? {}),
      ...(s.location !== undefined ? { location: str(s.location, 255) } : {}),
      ...(s.props !== undefined ? { props: str(s.props, 1000) } : {}),
      ...(s.equipment !== undefined ? { equipment: str(s.equipment, 1000) } : {}),
      ...(s.shootDate !== undefined ? { shootDate: isYmd(s.shootDate) ? s.shootDate : null } : {}),
      ...(s.editDeadline !== undefined ? { editDeadline: isYmd(s.editDeadline) ? s.editDeadline : null } : {}),
    };
  }
  return out;
}

/* ── Content ID ────────────────────────────────────────────────────────────── */
/**
 * Server-generated, unique, never accepted from the client. Backed by a Postgres
 * SEQUENCE, so concurrent creates can never collide; the unique index on
 * `content_id` is the final backstop.
 */
export async function generateContentId(): Promise<string> {
  const rows = await prisma.$queryRawUnsafe<{ id: string }[]>(
    `SELECT 'CNT-' || LPAD(nextval('marketing_content_id_seq')::text, 5, '0') AS id;`,
  );
  return rows[0].id;
}

/* ── Nearest deadline ──────────────────────────────────────────────────────── */
/**
 * The earliest real production deadline on a card: the card deadline, the shoot
 * date and the edit deadline. Returns null when the card genuinely has none —
 * never a fabricated or created-at fallback.
 */
export function nearestDeadline(card: { deadline?: Date | string | null; production_data?: unknown }): string | null {
  const pd = (card.production_data && typeof card.production_data === 'object' ? card.production_data : {}) as ProductionData;
  const candidates: string[] = [];
  if (card.deadline) {
    const d = card.deadline instanceof Date ? card.deadline.toISOString().slice(0, 10) : String(card.deadline).slice(0, 10);
    if (isYmd(d)) candidates.push(d);
  }
  // Every REAL production date participates — the M04 design/shoot deadlines
  // included. Nothing is invented and created_at is never used as a fallback.
  if (isYmd(pd.shoot?.shootDate)) candidates.push(pd.shoot!.shootDate!);
  if (isYmd(pd.shoot?.editDeadline)) candidates.push(pd.shoot!.editDeadline!);
  const anyPd = pd as { design?: Record<string, unknown>; shoot?: Record<string, unknown> };
  for (const v of [anyPd.design?.firstDraftDeadline, anyPd.design?.finalDeadline, anyPd.shoot?.finalDeadline]) {
    if (isYmd(v)) candidates.push(v);
  }
  if (!candidates.length) return null;
  // ISO 'YYYY-MM-DD' sorts chronologically as text — no timezone conversion, so
  // a calendar date can never shift a day.
  return candidates.sort()[0];
}

/* ── Validation ────────────────────────────────────────────────────────────── */
export interface FieldError { field: string; message: string }

/**
 * Server-side validation for create/update. Frontend validation is a
 * convenience; this is the enforcement point.
 *
 * Conditional by design: production fields are NEVER required, and the
 * irrelevant set for the selected Content Type is not validated at all.
 */
export function validateContentCard(
  body: Record<string, unknown>,
  { partial = false }: { partial?: boolean } = {},
): FieldError[] {
  const errors: FieldError[] = [];
  const has = (k: string) => body[k] !== undefined;

  if (!partial || has('title')) {
    const t = typeof body.title === 'string' ? body.title.trim() : '';
    if (!t) errors.push({ field: 'title', message: 'Content Title is required' });
    else if (t.length > 255) errors.push({ field: 'title', message: 'Content Title must be under 255 characters' });
  }
  if (!partial || has('format')) {
    const f = typeof body.format === 'string' ? body.format : '';
    if (!f) errors.push({ field: 'format', message: 'Content Type is required' });
    else if (!CONTENT_TYPES.includes(f as ContentType)) {
      errors.push({ field: 'format', message: `Content Type must be one of: ${CONTENT_TYPES.join(', ')}` });
    }
  }
  if (!partial || has('objective')) {
    const o = typeof body.objective === 'string' ? body.objective.trim() : '';
    if (!o) errors.push({ field: 'objective', message: 'Objective is required' });
  }
  if (has('platforms') && body.platforms !== null && !Array.isArray(body.platforms)) {
    errors.push({ field: 'platforms', message: 'Platform(s) must be a list' });
  }
  return errors;
}

/* ── Reference data ────────────────────────────────────────────────────────── */
export const REFERENCE_TABLES = ['clients', 'categories', 'pillars', 'campaigns', 'platforms', 'objectives'] as const;
export type ReferenceTable = (typeof REFERENCE_TABLES)[number];

const REF_DELEGATE = {
  clients: () => prisma.marketing_clients,
  categories: () => prisma.marketing_categories,
  pillars: () => prisma.marketing_pillars,
  campaigns: () => prisma.marketing_campaigns,
  // M10 #43 — platforms and objectives are stored BY VALUE (the platform key /
  // the objective label), so a card's existing value stays valid even after the
  // row is deactivated.
  platforms: () => prisma.marketing_platforms,
  objectives: () => prisma.marketing_objectives,
} as const;

/** Tables whose `name` is the value written onto a Content Card. */
export const VALUE_REFERENCE_TABLES = ['platforms', 'objectives'] as const;
export type ValueReferenceTable = (typeof VALUE_REFERENCE_TABLES)[number];

export interface ReferenceItem { id: number; name: string; active: boolean; sort_order: number }

/** Active-only by default — the dropdowns must not offer deactivated values. */
export async function listReference(table: ReferenceTable, includeInactive = false): Promise<ReferenceItem[]> {
  const delegate = REF_DELEGATE[table]() as {
    findMany: (a: unknown) => Promise<ReferenceItem[]>;
  };
  return delegate.findMany({
    where: includeInactive ? {} : { active: true },
    orderBy: [{ sort_order: 'asc' }, { name: 'asc' }],
    select: { id: true, name: true, active: true, sort_order: true },
  });
}

export async function createReference(table: ReferenceTable, name: string, sortOrder = 0): Promise<ReferenceItem> {
  const delegate = REF_DELEGATE[table]() as { create: (a: unknown) => Promise<ReferenceItem> };
  return delegate.create({
    data: { name: name.trim().slice(0, 160), sort_order: sortOrder },
    select: { id: true, name: true, active: true, sort_order: true },
  });
}

export async function updateReference(
  table: ReferenceTable,
  id: number,
  patch: { name?: string; active?: boolean; sort_order?: number },
): Promise<ReferenceItem> {
  const data: Record<string, unknown> = {};
  if (typeof patch.name === 'string' && patch.name.trim()) data.name = patch.name.trim().slice(0, 160);
  if (typeof patch.active === 'boolean') data.active = patch.active;
  if (Number.isInteger(patch.sort_order)) data.sort_order = patch.sort_order;
  const delegate = REF_DELEGATE[table]() as { update: (a: unknown) => Promise<ReferenceItem> };
  return delegate.update({
    where: { id },
    data,
    select: { id: true, name: true, active: true, sort_order: true },
  });
}


/* ── M10 #43: active-value lookup ──────────────────────────────────────────── */

/**
 * Deactivating a reference must stop NEW cards using it while leaving existing
 * cards untouched. Validation therefore has to consult the database, so the
 * active sets are cached briefly and invalidated on every reference write —
 * a create request does not pay for a lookup on every keystroke, and an admin
 * change takes effect immediately rather than after a TTL.
 */
const activeCache = new Map<ValueReferenceTable, { at: number; values: string[] }>();
const ACTIVE_TTL_MS = 30_000;

export function invalidateActiveReferenceCache(table?: ReferenceTable): void {
  if (table && (VALUE_REFERENCE_TABLES as readonly string[]).includes(table)) {
    activeCache.delete(table as ValueReferenceTable);
  } else if (!table) {
    activeCache.clear();
  }
}

/** The ACTIVE values for a value-backed reference list. */
export async function activeReferenceValues(table: ValueReferenceTable): Promise<string[]> {
  const hit = activeCache.get(table);
  if (hit && Date.now() - hit.at < ACTIVE_TTL_MS) return hit.values;
  const rows = await listReference(table, false);
  const values = rows.map((r) => r.name);
  activeCache.set(table, { at: Date.now(), values });
  return values;
}

/**
 * Is this value selectable for a NEW card? An empty list means the admin has
 * not configured the list at all — in that case nothing is blocked, so the
 * module keeps working exactly as before rather than refusing every save.
 */
export async function isSelectable(table: ValueReferenceTable, value: string): Promise<boolean> {
  const values = await activeReferenceValues(table);
  if (!values.length) return true;
  return values.includes(value);
}
