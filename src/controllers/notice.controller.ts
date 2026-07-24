import { Request, Response } from 'express';
import prisma from '../config/db.js';
import { io } from '../socket.js';
import { isGlobalAdmin } from '../utils/roles.js';

/**
 * Notice module — company-wide announcements with per-user read tracking.
 *
 * Per-user unread reuses the exact My Tasks pattern: a `notice_reads` cursor
 * (one row per (user,notice) with last_read_at). A notice is UNREAD when the user
 * has no read row OR the notice was edited after they last opened it
 * (updated_at > last_read_at) — the same "re-flag on edit" mechanic My Tasks uses.
 * No prisma groupBy (tsc OOM in this backend): a single findMany + JS grouping.
 */

const uid = (req: Request) => Number((req as any).userId);
const urole = (req: Request) => String((req as any).userRole || '');

/**
 * Real-time nudge for the sidebar unread dot: a notice's audience is dynamic (company /
 * department) and computed per viewer, so we broadcast a lightweight signal and let each
 * client re-fetch its OWN audience-filtered unread count (the count endpoint does the
 * per-user filtering). Fired only on infrequent admin lifecycle actions — never per read.
 * No notification rows are created (the bell/notification center is intentionally untouched).
 */
function emitNoticeChanged(reason: string) {
  try {
    io.emit('notice_changed', { reason });
  } catch (err) {
    console.error('emitNoticeChanged failed:', err);
  }
}

const NOTICE_PRIORITIES = ['low', 'medium', 'high', 'critical'];

/**
 * Resolve the audience scope for the current viewer. `department` is the user's HR
 * department (from employees.department — the same source the rest of the ERP uses;
 * NOT a hardcoded list). Global admins (Founder/SuperAdmin) bypass targeting.
 */
async function viewerAudience(req: Request): Promise<{ isAdmin: boolean; department: string | null }> {
  // Check ALL of the user's roles (userRole is only role[0]); a multi-role admin
  // whose admin role isn't listed first must still bypass targeting.
  const roleNames: string[] = (req as any).userRoleNames || [urole(req)].filter(Boolean);
  const isAdmin = roleNames.some((r) => isGlobalAdmin(r));
  if (isAdmin) return { isAdmin: true, department: null };
  const emp = await prisma.employees.findFirst({ where: { user_id: uid(req) }, select: { department: true } });
  return { isAdmin: false, department: emp?.department ?? null };
}

/**
 * Is the notice within the caller's audience AND actionable? Write paths (mark-read,
 * acknowledge) MUST mirror the read scope, or a user could read/acknowledge a notice
 * not targeted to them by guessing an id. Drafts are excluded entirely — they are
 * author-only and never broadcast, so an audience member must not be able to
 * read/acknowledge one by guessing its id (published + archived stay actionable).
 * Returns false for a non-existent id too (so we 404 without leaking existence).
 */
async function noticeVisibleTo(req: Request, noticeId: number): Promise<boolean> {
  const aud = await viewerAudience(req);
  const n = await prisma.notices.findFirst({
    where: { AND: [{ id: noticeId }, { status: { not: 'draft' } }, audienceWhere(aud)] },
    select: { id: true },
  });
  return !!n;
}

/**
 * Prisma `where` that limits notices to those the viewer may see: company-wide
 * notices, or department-targeted notices matching the viewer's own department.
 * Admins get {} (everything). Future target kinds (role/team/…) extend the OR here.
 */
function audienceWhere(a: { isAdmin: boolean; department: string | null }): any {
  if (a.isAdmin) return {};
  const clauses: any[] = [{ audience_type: 'company' }];
  if (a.department) clauses.push({ targets: { some: { target_type: 'department', target_value: a.department } } });
  return { OR: clauses };
}

/** Validate the audience choice from a create/edit body. */
function parseAudience(body: any): { audienceType: 'company' | 'departments'; departments: string[] } | { error: string } {
  const type = body?.audienceType === 'departments' ? 'departments' : 'company';
  if (type === 'company') return { audienceType: 'company', departments: [] };
  const departments: string[] = Array.isArray(body?.targetDepartments)
    ? Array.from(new Set<string>(
      (body.targetDepartments as any[]).map((d) => String(d).trim()).filter((s: string) => s.length > 0),
    )).slice(0, 100)
    : [];
  if (departments.length === 0) return { error: 'Select at least one department, or choose Entire Company.' };
  return { audienceType: 'departments', departments };
}
const DAY_MS = 86_400_000;

/**
 * Parse an expiry value. A bare 'YYYY-MM-DD' from the date picker means the notice
 * stays valid through the END of that day in IST (the app timezone). Parsing it as
 * plain UTC midnight (the JS default for date-only strings) made a "expires today"
 * notice vanish instantly and future ones expire ~a day early. Full ISO → as-is.
 */
function parseDate(v: unknown): Date | null {
  if (!v) return null;
  const s = String(v);
  const d = /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(`${s}T23:59:59.999+05:30`) : new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Does the caller hold notice.manage (or global admin)? Pinning / marking important
 * is a manage-level capability, so a notice.create-only publisher must not be able
 * to float their announcement above everyone else's at publish time. Mirrors the
 * role→permissions resolution checkPermission does (no perm set is stashed on req).
 */
export async function callerHasManage(req: Request): Promise<boolean> {
  const roleNames: string[] = (req as any).userRoleNames || [(req as any).userRole].filter(Boolean);
  if (roleNames.some((r) => isGlobalAdmin(r))) return true;
  for (const rName of roleNames) {
    const rows = await prisma.$queryRawUnsafe<any[]>(
      'SELECT permissions FROM roles WHERE LOWER(name) = LOWER($1) LIMIT 1;', rName,
    );
    if (rows.length && rows[0].permissions) {
      const raw = rows[0].permissions;
      const parsed = Array.isArray(raw) ? raw : JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.includes('notice.manage')) return true;
    }
  }
  return false;
}

const NOTICE_STATUSES = ['draft', 'published', 'archived'];

/** Global admin (Founder/SuperAdmin) — checks ALL roles, not just the first. */
function isAdminReq(req: Request): boolean {
  const roleNames: string[] = (req as any).userRoleNames || [urole(req)].filter(Boolean);
  return roleNames.some((r) => isGlobalAdmin(r));
}

/**
 * Ownership gate for manage actions (edit/delete/pin/publish/archive/attachments).
 * A Founder/SuperAdmin manages ANY notice; a manager (holds notice.manage, already
 * enforced at the route) manages only notices they PUBLISHED. Mirrors the spec:
 * "Founder full access" vs management "Edit Their Own Notices".
 */
export function isNoticeOwnerOrAdmin(req: Request, publishedBy: number | null): boolean {
  if (publishedBy != null && publishedBy === uid(req)) return true;
  return isAdminReq(req);
}

const NOTICE_INCLUDE = {
  category: { select: { id: true, name: true, color: true, icon: true } },
  // Publisher's department (from the HR employee record) for the details view.
  publisher: { select: { id: true, name: true, employee: { select: { department: true } } } },
  attachments: { orderBy: { uploaded_at: 'asc' as const } },
  targets: { select: { target_type: true, target_value: true } },
};

// Default ordering: pinned first, then Critical → High → Medium → Low, then newest.
const PRIORITY_RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
const rankOf = (p: string) => PRIORITY_RANK[p] ?? 2;
const noticeOrder = (a: any, b: any) =>
  (b.is_pinned ? 1 : 0) - (a.is_pinned ? 1 : 0)
  || rankOf(a.priority) - rankOf(b.priority)
  || new Date(b.published_at).getTime() - new Date(a.published_at).getTime();

function serializeNotice(n: any, unread: boolean, acknowledgedAt: Date | null = null) {
  return {
    id: n.id,
    title: n.title,
    body: n.body,
    priority: n.priority || 'medium',
    isPinned: n.is_pinned,
    isImportant: n.is_important,
    status: n.status || 'published',
    audience: {
      type: n.audience_type || 'company',
      departments: (n.targets || []).filter((t: any) => t.target_type === 'department').map((t: any) => t.target_value),
    },
    acknowledged: !!acknowledgedAt,
    acknowledgedAt: acknowledgedAt ?? null,
    publishedAt: n.published_at,
    expiresAt: n.expires_at ?? null,
    updatedAt: n.updated_at,
    category: n.category
      ? { id: n.category.id, name: n.category.name, color: n.category.color, icon: n.category.icon ?? null }
      : null,
    publishedBy: n.publisher
      ? { id: n.publisher.id, name: n.publisher.name, department: n.publisher.employee?.department ?? null }
      : null,
    attachments: (n.attachments || []).map((a: any) => ({
      id: a.id,
      fileName: a.file_name,
      fileUrl: a.file_url,
      fileSize: a.file_size ?? null,
      fileType: a.file_type ?? null,
      isLink: a.is_link,
      uploadedAt: a.uploaded_at,
    })),
    unread,
  };
}

/**
 * GET /notices/dashboard — the prioritised overview.
 * Sections: Unread → Pinned → Recent → Expiring. Expired notices are excluded
 * everywhere. All computed from ONE active-notices fetch + the user's read cursor.
 */
export const getNoticeDashboard = async (req: Request, res: Response) => {
  try {
    const userId = uid(req);
    const now = new Date();
    const recentLimit = Math.min(Math.max(Number(req.query.recentLimit) || 20, 1), 100);

    // Active notices the viewer may see: PUBLISHED, not expired, audience-matched
    // (drafts + archived never appear in the active dashboard).
    const aud = await viewerAudience(req);
    const notices = await prisma.notices.findMany({
      where: { AND: [{ status: 'published' }, { OR: [{ expires_at: null }, { expires_at: { gte: now } }] }, audienceWhere(aud)] },
      include: NOTICE_INCLUDE,
      orderBy: { published_at: 'desc' },
    });

    // Per-user read cursor → unread + acknowledgement maps (extends the reads model).
    const ids = notices.map((n) => n.id);
    const readAt = new Map<number, Date>();
    const ackAt = new Map<number, Date>();
    if (ids.length) {
      const reads = await prisma.notice_reads.findMany({
        where: { user_id: userId, notice_id: { in: ids } },
        select: { notice_id: true, last_read_at: true, acknowledged_at: true },
      });
      for (const r of reads) {
        readAt.set(r.notice_id, r.last_read_at);
        if (r.acknowledged_at) ackAt.set(r.notice_id, r.acknowledged_at);
      }
    }
    const isUnread = (n: any): boolean => {
      const last = readAt.get(n.id);
      if (!last) return true;                                   // never opened
      return new Date(n.updated_at) > last;                     // edited since last open
    };
    const ser = (n: any, unread: boolean) => serializeNotice(n, unread, ackAt.get(n.id) ?? null);

    const withUnread = notices.map((n) => ({ n, unread: isUnread(n) }));

    // All three lists share the standardized order: pinned → priority → newest,
    // so Critical always outranks lower priorities (and pinned outranks all).
    const unread = withUnread.filter((x) => x.unread)
      .sort((a, b) => noticeOrder(a.n, b.n))
      .map((x) => ser(x.n, true));

    const pinned = withUnread.filter((x) => x.n.is_pinned)
      .sort((a, b) => noticeOrder(a.n, b.n))
      .map((x) => ser(x.n, x.unread));

    // "Recent" is chronological BY DEFINITION (newest first, pinned floated up).
    // Priority ordering drives Unread/Pinned visibility; applying it here too would
    // let a high-priority backlog crowd genuinely-new notices out before the slice.
    const recentOrder = (a: any, b: any) =>
      (b.is_pinned ? 1 : 0) - (a.is_pinned ? 1 : 0)
      || new Date(b.published_at).getTime() - new Date(a.published_at).getTime();
    const recent = [...withUnread]
      .sort((a, b) => recentOrder(a.n, b.n))
      .slice(0, recentLimit)
      .map((x) => ser(x.n, x.unread));

    // Expiring within the next 7 days (inclusive), not yet expired. Bucketed.
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const bucketOf = (d: Date): 'today' | 'tomorrow' | 'week' => {
      const days = Math.floor((new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() - startOfToday.getTime()) / DAY_MS);
      if (days <= 0) return 'today';
      if (days === 1) return 'tomorrow';
      return 'week';
    };
    const in7 = new Date(startOfToday.getTime() + 8 * DAY_MS); // through end of day+7
    const expiring = withUnread
      .filter((x) => x.n.expires_at != null && new Date(x.n.expires_at) >= now && new Date(x.n.expires_at) < in7)
      .sort((a, b) => new Date(a.n.expires_at as Date).getTime() - new Date(b.n.expires_at as Date).getTime())
      .map((x) => ({ ...ser(x.n, x.unread), expiringBucket: bucketOf(new Date(x.n.expires_at as Date)) }));

    return res.status(200).json({
      unread,
      pinned,
      recent,
      expiring,
      counts: {
        unread: unread.length,
        pinned: pinned.length,
        active: notices.length,
        expiring: expiring.length,
      },
      generatedAt: now.toISOString(),
    });
  } catch (error) {
    console.error('Error building notice dashboard:', error);
    return res.status(500).json({ error: 'Failed to build notice dashboard' });
  }
};

/**
 * GET /notices/unread-count — lightweight aggregate for the sidebar unread dot.
 * Returns { count } of UNREAD notices for the caller, using the EXACT same rule as the
 * dashboard (never opened OR edited since last open: updated_at > last_read_at), over the
 * same audience-matched, published, non-expired set. Selects only id + updated_at (no
 * NOTICE_INCLUDE, no serialization) so it stays cheap for login + real-time nudges.
 */
export const getNoticeUnreadCount = async (req: Request, res: Response) => {
  try {
    const userId = uid(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    const now = new Date();
    const aud = await viewerAudience(req);
    const notices = await prisma.notices.findMany({
      where: { AND: [{ status: 'published' }, { OR: [{ expires_at: null }, { expires_at: { gte: now } }] }, audienceWhere(aud)] },
      select: { id: true, updated_at: true },
    });
    if (!notices.length) return res.status(200).json({ count: 0 });
    const ids = notices.map((n) => n.id);
    const reads = await prisma.notice_reads.findMany({
      where: { user_id: userId, notice_id: { in: ids } },
      select: { notice_id: true, last_read_at: true },
    });
    const readAt = new Map<number, Date>();
    for (const r of reads) readAt.set(r.notice_id, r.last_read_at);
    let count = 0;
    for (const n of notices) {
      const last = readAt.get(n.id);
      if (!last || new Date(n.updated_at) > last) count++;   // never opened OR edited since
    }
    return res.status(200).json({ count });
  } catch (error) {
    console.error('Error computing notice unread count:', error);
    return res.status(500).json({ error: 'Failed to compute notice unread count' });
  }
};

/**
 * GET /notices?scope=active|archived|expired|drafts — flat list for search + the
 * archived/expired/drafts views. Every scope is audience-filtered (drafts are also
 * owner-scoped: only your own, unless admin). Powers "archived remains searchable".
 */
export const listNotices = async (req: Request, res: Response) => {
  try {
    const userId = uid(req);
    const now = new Date();
    const scope = String(req.query.scope || 'active');
    const aud = await viewerAudience(req);

    let where: any;
    if (scope === 'archived') {
      where = { AND: [{ status: 'archived' }, audienceWhere(aud)] };
    } else if (scope === 'expired') {
      where = { AND: [{ status: 'published' }, { expires_at: { lt: now } }, audienceWhere(aud)] };
    } else if (scope === 'drafts') {
      // Drafts are author-only (admins see all) — never audience-broadcast.
      where = aud.isAdmin ? { status: 'draft' } : { status: 'draft', published_by: userId };
    } else {
      where = { AND: [{ status: 'published' }, { OR: [{ expires_at: null }, { expires_at: { gte: now } }] }, audienceWhere(aud)] };
    }

    const notices = await prisma.notices.findMany({
      where,
      include: NOTICE_INCLUDE,
      orderBy: [{ is_pinned: 'desc' }, { published_at: 'desc' }],
    });
    const ids = notices.map((n) => n.id);
    const readAt = new Map<number, Date>();
    const ackAt = new Map<number, Date>();
    if (ids.length) {
      const reads = await prisma.notice_reads.findMany({
        where: { user_id: userId, notice_id: { in: ids } },
        select: { notice_id: true, last_read_at: true, acknowledged_at: true },
      });
      for (const r of reads) {
        readAt.set(r.notice_id, r.last_read_at);
        if (r.acknowledged_at) ackAt.set(r.notice_id, r.acknowledged_at);
      }
    }
    const out = notices.map((n) => {
      const last = readAt.get(n.id);
      // A draft has no read-tracking semantics (it is only visible to its author and can
      // never be marked-read — noticeVisibleTo excludes drafts). Never flag it unread, or
      // editing your own draft would leave a permanent, unclearable unread accent.
      const unread = n.status !== 'draft' && (!last || new Date(n.updated_at) > last);
      return serializeNotice(n, unread, ackAt.get(n.id) ?? null);
    });
    // Same standardized order as the dashboard: pinned → priority → newest.
    out.sort((a, b) =>
      (b.isPinned ? 1 : 0) - (a.isPinned ? 1 : 0)
      || rankOf(a.priority) - rankOf(b.priority)
      || new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime());
    res.json(out);
  } catch (error) {
    console.error('Error listing notices:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

/** POST /notices — publish a notice (needs notice.create). */
export const createNotice = async (req: Request, res: Response) => {
  try {
    const userId = uid(req);
    const { title, body, categoryId, priority, isPinned, isImportant, expiresAt } = req.body;

    if (!title || !String(title).trim()) return res.status(400).json({ error: 'Title is required.' });
    if (!body || !String(body).trim()) return res.status(400).json({ error: 'Body is required.' });

    // Every notice must belong to a category.
    const catId = Number(categoryId);
    if (!catId || Number.isNaN(catId)) return res.status(400).json({ error: 'A category is required.' });
    const category = await prisma.notice_categories.findUnique({ where: { id: catId } });
    if (!category) return res.status(400).json({ error: 'Selected category does not exist.' });

    const prio = priority && NOTICE_PRIORITIES.includes(String(priority)) ? String(priority) : 'medium';

    const audience = parseAudience(req.body);
    if ('error' in audience) return res.status(400).json({ error: audience.error });

    // Pinning / importance is a manage capability — ignore it for create-only users.
    const canManage = await callerHasManage(req);

    // Lifecycle: publish immediately, or save as a draft. Drafting is a manage-tier
    // capability (only a manager can later publish/edit/delete via the /publish, PUT,
    // DELETE routes) — a create-only publisher requesting a draft would strand a notice
    // they could never publish, so their request publishes immediately instead.
    const status = req.body.status === 'draft' && canManage ? 'draft' : 'published';

    // Notice + its audience targets are written atomically (a departments notice
    // must never end up with zero targets = invisible to its intended audience).
    const created = await prisma.$transaction(async (tx) => {
      const n = await tx.notices.create({
        data: {
          title: String(title).trim().slice(0, 255),
          body: String(body),
          category_id: catId,
          priority: prio,
          is_pinned: canManage ? !!isPinned : false,
          is_important: canManage ? !!isImportant : false,
          audience_type: audience.audienceType,
          status,
          published_by: userId,
          expires_at: parseDate(expiresAt),
        },
        include: NOTICE_INCLUDE,
      });
      if (audience.audienceType === 'departments' && audience.departments.length) {
        await tx.notice_targets.createMany({
          data: audience.departments.map((d) => ({ notice_id: n.id, target_type: 'department', target_value: d })),
        });
      }
      return n;
    });
    if (audience.audienceType === 'departments' && audience.departments.length) {
      (created as any).targets = audience.departments.map((d) => ({ target_type: 'department', target_value: d }));
    }
    // The author has implicitly "read" their own notice.
    await prisma.notice_reads.upsert({
      where: { notice_id_user_id: { notice_id: created.id, user_id: userId } },
      update: { last_read_at: new Date() },
      create: { notice_id: created.id, user_id: userId },
    });
    // Only a PUBLISHED notice is broadcast (a draft is invisible until published).
    if (status === 'published') emitNoticeChanged('created');
    return res.status(201).json(serializeNotice(created, false));
  } catch (error) {
    console.error('Error creating notice:', error);
    return res.status(500).json({ error: 'Failed to create notice' });
  }
};

/** PUT /notices/:id — edit a notice (needs notice.manage). */
export const updateNotice = async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid notice id' });
    const existing = await prisma.notices.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: 'Notice not found' });
    if (!isNoticeOwnerOrAdmin(req, existing.published_by)) {
      return res.status(403).json({ error: 'You can only edit notices you published.' });
    }

    const { title, body, categoryId, priority, isPinned, isImportant, expiresAt } = req.body;
    const data: any = {};
    if (title !== undefined) {
      if (!String(title).trim()) return res.status(400).json({ error: 'Title cannot be empty.' });
      data.title = String(title).trim().slice(0, 255);
    }
    if (body !== undefined) {
      if (!String(body).trim()) return res.status(400).json({ error: 'Body cannot be empty.' });
      data.body = String(body);
    }
    if (categoryId !== undefined) {
      const catId = Number(categoryId);
      if (!catId || Number.isNaN(catId)) return res.status(400).json({ error: 'A valid category is required.' });
      const category = await prisma.notice_categories.findUnique({ where: { id: catId } });
      if (!category) return res.status(400).json({ error: 'Selected category does not exist.' });
      data.category_id = catId;
    }
    if (priority !== undefined) {
      if (!NOTICE_PRIORITIES.includes(String(priority))) return res.status(400).json({ error: 'Invalid priority.' });
      data.priority = String(priority);
    }
    if (isPinned !== undefined) data.is_pinned = !!isPinned;
    if (isImportant !== undefined) data.is_important = !!isImportant;
    if (expiresAt !== undefined) data.expires_at = parseDate(expiresAt);

    // Re-flag as unread ONLY on genuine CONTENT changes (title/body/category/priority).
    // updated_at is the unread clock; @updatedAt was removed so it is bumped here — a
    // pin / important / expiry-only toggle must NOT re-notify the whole company. Compare
    // by VALUE against the stored row (not mere field presence): the edit form always
    // resends title/body/category/priority, so a presence check re-notified everyone on
    // an expiry-only or no-op "Save Changes".
    const contentChanged =
      (data.title !== undefined && data.title !== existing.title)
      || (data.body !== undefined && data.body !== existing.body)
      || (data.category_id !== undefined && data.category_id !== existing.category_id)
      || (data.priority !== undefined && data.priority !== existing.priority);
    if (contentChanged) {
      data.updated_at = new Date();
    }

    // Audience change (only when the client sends audienceType): replace targets.
    let audienceChanged = false;
    if (req.body.audienceType !== undefined) {
      const audience = parseAudience(req.body);
      if ('error' in audience) return res.status(400).json({ error: audience.error });
      data.audience_type = audience.audienceType;
      // Atomic swap: update + clear-old + write-new can't half-apply.
      await prisma.$transaction([
        prisma.notices.update({ where: { id }, data }),
        prisma.notice_targets.deleteMany({ where: { notice_id: id } }),
        ...(audience.audienceType === 'departments' && audience.departments.length
          ? [prisma.notice_targets.createMany({
            data: audience.departments.map((d) => ({ notice_id: id, target_type: 'department', target_value: d })),
          })]
          : []),
      ]);
      audienceChanged = true;
    }

    const updated = audienceChanged
      ? await prisma.notices.findUnique({ where: { id }, include: NOTICE_INCLUDE })
      : await prisma.notices.update({ where: { id }, data, include: NOTICE_INCLUDE });
    // A content edit re-flags recipients as unread; an audience change alters who sees it.
    if (contentChanged || audienceChanged) emitNoticeChanged('updated');
    return res.json(serializeNotice(updated, false));
  } catch (error) {
    console.error('Error updating notice:', error);
    return res.status(500).json({ error: 'Failed to update notice' });
  }
};

/** DELETE /notices/:id — remove a notice (needs notice.manage). Reads cascade. */
export const deleteNotice = async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid notice id' });
    const existing = await prisma.notices.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: 'Notice not found' });
    if (!isNoticeOwnerOrAdmin(req, existing.published_by)) {
      return res.status(403).json({ error: 'You can only delete notices you published.' });
    }
    await prisma.notices.delete({ where: { id } });
    emitNoticeChanged('deleted');
    return res.json({ success: true });
  } catch (error) {
    console.error('Error deleting notice:', error);
    return res.status(500).json({ error: 'Failed to delete notice' });
  }
};

/** POST /notices/:id/publish — draft/archived → published (owner or admin). */
export const publishNotice = async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid notice id' });
    const notice = await prisma.notices.findUnique({ where: { id }, select: { published_by: true, status: true } });
    if (!notice) return res.status(404).json({ error: 'Notice not found' });
    if (!isNoticeOwnerOrAdmin(req, notice.published_by)) {
      return res.status(403).json({ error: 'You can only publish notices you own.' });
    }
    if (notice.status === 'published') {
      const cur = await prisma.notices.findUnique({ where: { id }, include: NOTICE_INCLUDE });
      return res.json(serializeNotice(cur, false));
    }
    // Publishing makes it freshly visible: stamp published_at + updated_at = now so
    // it appears as new and is UNREAD for every recipient (read tracking begins).
    const now = new Date();
    const updated = await prisma.notices.update({
      where: { id }, data: { status: 'published', published_at: now, updated_at: now }, include: NOTICE_INCLUDE,
    });
    emitNoticeChanged('published');
    return res.json(serializeNotice(updated, false));
  } catch (error) {
    console.error('Error publishing notice:', error);
    return res.status(500).json({ error: 'Failed to publish notice' });
  }
};

/** POST /notices/:id/archive — published → archived (owner or admin). Preserves reads. */
export const archiveNotice = async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid notice id' });
    const notice = await prisma.notices.findUnique({ where: { id }, select: { published_by: true, status: true } });
    if (!notice) return res.status(404).json({ error: 'Notice not found' });
    if (!isNoticeOwnerOrAdmin(req, notice.published_by)) {
      return res.status(403).json({ error: 'You can only archive notices you own.' });
    }
    // Only a PUBLISHED notice can be archived (expired is still status=published, so it
    // stays archivable). A draft is never broadcast — archiving one would leak it into
    // the audience-visible archived scope; delete a draft instead.
    if (notice.status !== 'published') {
      return res.status(400).json({ error: 'Only a published notice can be archived.' });
    }
    // Archive keeps the row (reads + attachments preserved) — only hides it from lists.
    const updated = await prisma.notices.update({ where: { id }, data: { status: 'archived' }, include: NOTICE_INCLUDE });
    emitNoticeChanged('archived');
    return res.json(serializeNotice(updated, false));
  } catch (error) {
    console.error('Error archiving notice:', error);
    return res.status(500).json({ error: 'Failed to archive notice' });
  }
};

/** POST /notices/:id/read — mark a notice read for the current user (idempotent). */
export const markNoticeRead = async (req: Request, res: Response) => {
  try {
    const userId = uid(req);
    const id = Number(req.params.id);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid notice id' });
    // Read scope mirrors visibility: 404 if the notice isn't in the caller's audience
    // (this also covers a deleted id, avoiding an FK-violation 500).
    if (!(await noticeVisibleTo(req, id))) return res.status(404).json({ error: 'Notice not found' });
    await prisma.notice_reads.upsert({
      where: { notice_id_user_id: { notice_id: id, user_id: userId } },
      update: { last_read_at: new Date() },
      create: { notice_id: id, user_id: userId },
    });
    return res.json({ success: true });
  } catch (error) {
    console.error('Error marking notice read:', error);
    return res.status(500).json({ error: 'Failed to mark notice read' });
  }
};

/**
 * POST /notices/:id/acknowledge — explicit "I have read this" (separate from open).
 * Idempotent + PERMANENT: the first acknowledgement timestamp is never overwritten.
 */
export const acknowledgeNotice = async (req: Request, res: Response) => {
  try {
    const userId = uid(req);
    const id = Number(req.params.id);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid notice id' });
    // Acknowledge scope mirrors visibility (can't acknowledge a notice not for you).
    if (!(await noticeVisibleTo(req, id))) return res.status(404).json({ error: 'Notice not found' });

    const now = new Date();
    // Ensure the read row exists — does NOT touch acknowledged_at.
    await prisma.notice_reads.upsert({
      where: { notice_id_user_id: { notice_id: id, user_id: userId } },
      update: { last_read_at: now },
      create: { notice_id: id, user_id: userId, last_read_at: now },
    });
    // Atomic + PERMANENT: stamp acknowledged_at ONLY while still NULL, so a concurrent
    // double-submit can never overwrite the FIRST acknowledgement's timestamp.
    await prisma.notice_reads.updateMany({
      where: { notice_id: id, user_id: userId, acknowledged_at: null },
      data: { acknowledged_at: now },
    });
    const row = await prisma.notice_reads.findUnique({
      where: { notice_id_user_id: { notice_id: id, user_id: userId } },
      select: { acknowledged_at: true },
    });
    return res.json({ success: true, acknowledgedAt: row?.acknowledged_at ?? null });
  } catch (error) {
    console.error('Error acknowledging notice:', error);
    return res.status(500).json({ error: 'Failed to acknowledge notice' });
  }
};

/**
 * GET /notices/:id/acknowledgements — management READ-TRACKING dashboard (needs
 * notice.manage). Recipients = the notice's audience (all active users for company,
 * or users in the targeted departments).
 *
 * "Read" here = the auto-tracked read receipt (opened the CURRENT version): a
 * notice_reads row whose last_read_at >= the notice's updated_at. This is the exact
 * inverse of each user's per-user `unread` flag — one consistent definition of read
 * across the module (a user is "pending" here iff their notice shows unread). The
 * explicit acknowledgement ("I Have Read This Notice") is carried alongside as a
 * separate, stronger signal (acknowledged / acknowledgedAt per recipient).
 */
export const getNoticeAcknowledgements = async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid notice id' });
    const notice = await prisma.notices.findUnique({
      where: { id },
      select: { id: true, audience_type: true, updated_at: true, published_by: true, targets: { select: { target_type: true, target_value: true } } },
    });
    if (!notice) return res.status(404).json({ error: 'Notice not found' });
    // Owner-scoped, exactly like update/delete/publish/archive: a manager sees the read
    // report only for notices THEY published; Founder/SuperAdmin sees any. The route's
    // notice.manage gate is coarse — without this, any manager could pull another owner's
    // full recipient roster (incl. an unpublished draft's) by id (hidden-button IDOR).
    if (!isNoticeOwnerOrAdmin(req, notice.published_by)) {
      return res.status(403).json({ error: 'You can only view read reports for notices you published.' });
    }

    // Recipient ROSTER (name + department), resolved with the SAME active-user rule for
    // BOTH audiences so totals/read% share one definition: company → every active user;
    // departments → active users in the targeted depts (a deactivated user in a targeted
    // dept must not inflate the denominator, matching the company branch).
    const activeStatus = { OR: [{ status: 'active' }, { status: null }] };
    let users: { id: number; name: string; employee: { department: string | null } | null }[];
    if (notice.audience_type === 'departments') {
      const depts = notice.targets.filter((t) => t.target_type === 'department').map((t) => t.target_value);
      const emps = depts.length
        ? await prisma.employees.findMany({ where: { department: { in: depts }, user_id: { not: null } }, select: { user_id: true } })
        : [];
      const empUserIds = [...new Set(emps.map((e) => e.user_id).filter((x): x is number => x != null))];
      users = empUserIds.length
        ? await prisma.users.findMany({
          where: { AND: [{ id: { in: empUserIds } }, activeStatus] },
          select: { id: true, name: true, employee: { select: { department: true } } },
        })
        : [];
    } else {
      users = await prisma.users.findMany({
        where: activeStatus,
        select: { id: true, name: true, employee: { select: { department: true } } },
      });
    }
    const recipientIds = users.map((u) => u.id);

    // Read cursors among the recipients → map userId → { last_read_at, acknowledged_at }.
    const reads = recipientIds.length
      ? await prisma.notice_reads.findMany({
        where: { notice_id: id, user_id: { in: recipientIds } },
        select: { user_id: true, last_read_at: true, acknowledged_at: true },
      })
      : [];
    const readMap = new Map<number, { last_read_at: Date | null; acknowledged_at: Date | null }>();
    for (const r of reads) readMap.set(r.user_id, { last_read_at: r.last_read_at, acknowledged_at: r.acknowledged_at });

    const updatedAt = new Date(notice.updated_at).getTime();
    const recipients = users.map((u) => {
      const r = readMap.get(u.id);
      const last = r?.last_read_at ? new Date(r.last_read_at) : null;
      // Read the CURRENT version — mirrors the per-user unread rule exactly.
      const hasRead = !!last && last.getTime() >= updatedAt;
      return {
        userId: u.id,
        name: u.name,
        department: u.employee?.department ?? null,
        status: hasRead ? 'read' : 'pending',
        readTime: hasRead ? (r!.last_read_at as Date) : null,
        acknowledged: !!r?.acknowledged_at,
        acknowledgedAt: r?.acknowledged_at ?? null,
      };
    }).sort((a, b) => a.name.localeCompare(b.name));

    const totalRecipients = recipientIds.length;
    const totalRead = recipients.filter((x) => x.status === 'read').length;
    const totalAcknowledged = recipients.filter((x) => x.acknowledged).length;
    return res.json({
      audienceType: notice.audience_type,
      departments: notice.targets.filter((t) => t.target_type === 'department').map((t) => t.target_value),
      totalRecipients,
      totalRead,
      totalUnread: Math.max(0, totalRecipients - totalRead),
      totalAcknowledged,
      readPercentage: totalRecipients ? Math.round((totalRead / totalRecipients) * 100) : 0,
      recipients,
    });
  } catch (error) {
    console.error('Error fetching notice acknowledgements:', error);
    return res.status(500).json({ error: 'Failed to fetch acknowledgements' });
  }
};

/**
 * GET /notices/audience/departments — distinct department names from HR employee
 * records. This IS the department "master" (no separate table), so a department HR
 * adds to any employee automatically becomes targetable with no code change.
 */
export const getAudienceDepartments = async (_req: Request, res: Response) => {
  try {
    const emps = await prisma.employees.findMany({ select: { department: true } });
    const departments = [...new Set(emps.map((e) => e.department).filter(Boolean))].sort((a, b) => a.localeCompare(b));
    return res.json(departments);
  } catch (error) {
    console.error('Error fetching audience departments:', error);
    return res.status(500).json({ error: 'Failed to fetch departments' });
  }
};
