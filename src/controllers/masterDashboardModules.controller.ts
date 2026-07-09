import { Request, Response } from 'express';
import prisma from '../config/db.js';
import { isGlobalAdmin } from '../utils/roles.js';
import { targetService } from '../services/target.service.js';

/**
 * Master Dashboard — per-module organization-wide endpoints.
 *
 * These power the standalone SuperAdmin modules (`/master-dashboard/{projects,
 * tickets,sales,meetings,audit}`). Every figure is ORGANIZATION-WIDE and live:
 * counts/aggregates span the entire ERP and are never scoped to a single
 * project, board, sprint, owner, or the logged-in user. No mock, demo, or
 * hardcoded values — empty datasets resolve to 0 / [] only.
 *
 * Implementation discipline (matches masterDashboard.controller.ts):
 *  - Distributions are built in JS over lightweight single-column `findMany`
 *    selects, NOT Prisma `groupBy` — `groupBy`'s generic return types are so
 *    expensive that a handful of them OOMs the TypeScript compiler in this repo.
 *  - Queries run in small parallel waves to keep each Promise.all tuple cheap
 *    to type-check.
 *  - Performance discipline: KPI counts and chart distributions come from
 *    cheap `count()` / single-or-two-column `findMany` scans (accurate
 *    org-wide even at scale). Heavy detail lists (full rows + relations) are
 *    BOUNDED with `take`, and their relational fan-out is restricted to the
 *    rows actually displayed. Trend windows are date-bounded.
 *
 * Terminology: in this ERP "Tickets" are Blockers and "Bugs" are the bug
 * tracker — distinct entities, reported separately.
 */

// ── Status vocabularies (case-insensitive against free-text VarChar columns) ──
const PROJECT_ACTIVE = ['active', 'in_progress', 'in-progress', 'ongoing'];
const PROJECT_COMPLETED = ['completed', 'complete', 'done', 'closed'];
const PROJECT_ONHOLD = ['on-hold', 'on_hold', 'onhold', 'paused', 'hold'];
const PROJECT_CANCELLED = ['cancelled', 'canceled'];
const PROJECT_PLANNING = ['planning', 'planned', 'new', 'draft', 'not started', 'not_started', 'todo', 'backlog'];

const TICKET_RESOLVED = ['resolved', 'closed', 'done', 'completed'];
const CRITICAL_LEVELS = ['critical', 'urgent', 'high'];

const BUG_OPEN = ['open', 'new', 'in_progress', 'in-progress', 'reopened'];
const BUG_RESOLVED = ['resolved', 'closed', 'done', 'fixed'];

const TASK_DONE = ['done', 'completed', 'complete', 'closed', 'resolved'];

// Hard cap on heavy detail lists so the dashboard stays performant with
// thousands of records. KPI counts + distributions remain org-wide accurate;
// only the rendered detail list is bounded (most recent first).
const LIST_LIMIT = 500;

/**
 * SuperAdmin/Admin gate. Returns false (and sends 403) when the caller is not
 * allowed; handles every spelling of the role that exists in this system.
 */
function requireSuperAdmin(req: Request, res: Response): boolean {
  // isGlobalAdmin normalizes every spelling of the role (case, spaces,
  // underscores, hyphens) so 'Super Admin' / 'super_admin' / 'Admin' all pass.
  if (!isGlobalAdmin((req as any).userRole)) {
    res.status(403).json({ error: 'Forbidden. SuperAdmin access required.' });
    return false;
  }
  return true;
}

/** Build a sorted [{ label, value }] frequency distribution (JS grouping). */
function distribution(
  rows: Array<Record<string, any>>,
  key: string,
): Array<{ label: string; value: number }> {
  const counts = new Map<string, number>();
  for (const r of rows) {
    const raw = r[key];
    const label = (raw === null || raw === undefined || raw === '' ? 'Unknown' : String(raw));
    counts.set(label, (counts.get(label) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([label, value]) => ({ label, value }))
    .filter((d) => d.value > 0)
    .sort((a, b) => b.value - a.value);
}

const matches = (value: string | null | undefined, set: string[]) =>
  !!value && set.includes(value.toLowerCase());

/**
 * Whether a kanban task counts as "done" — mirrors the Development app's logic
 * (project.controller.getProjectSprintAnalytics). A task's `status` is usually
 * a kanban COLUMN id, not a literal word, so a plain status-vs-vocabulary
 * compare misses almost everything. A task is done when its status is a literal
 * done word OR it sits in a column whose label reads Done/Complete.
 */
function taskIsDone(
  status: string | null | undefined,
  columns: Array<{ id: string; label: string }>,
): boolean {
  if (matches(status, TASK_DONE)) return true;
  const col = columns.find((c) => c.id === status);
  return !!col && /done|complete/.test(col.label.toLowerCase());
}

/** Last `n` month buckets, oldest → newest, keyed YYYY-MM. */
function monthBuckets(n: number, now: Date) {
  const buckets: Array<{ key: string; label: string }> = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    buckets.push({
      key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`,
      label: d.toLocaleString('en-US', { month: 'short' }),
    });
  }
  return buckets;
}

const monthKeyOf = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;

// ── Ticket priority buckets + "pending reply" status set ────────────────────
const PRIORITY_CRITICAL = ['critical', 'urgent', 'blocker', 'p0', 'p1', 'sev1'];
const PRIORITY_HIGH = ['high', 'major', 'p2', 'sev2'];
const PRIORITY_MEDIUM = ['medium', 'normal', 'moderate', 'p3', 'sev3'];
const PRIORITY_LOW = ['low', 'minor', 'trivial', 'p4', 'sev4'];
const PENDING_REPLY = [
  'pending', 'waiting', 'awaiting', 'awaiting_response', 'awaiting-response', 'awaiting response',
  'need_info', 'needs_info', 'needs info', 'on_hold', 'on-hold', 'on hold', 'blocked', 'customer',
];

/** Local-date key YYYY-MM-DD. */
const dayKeyOf = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** Last `n` day buckets, oldest → newest (local days), keyed YYYY-MM-DD. */
function dayBuckets(n: number, now: Date) {
  const base = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const buckets: Array<{ key: string; label: string }> = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(base);
    d.setDate(base.getDate() - i);
    buckets.push({ key: dayKeyOf(d), label: d.toLocaleString('en-US', { month: 'short', day: 'numeric' }) });
  }
  return buckets;
}

const isEscalated = (level: string | null | undefined) =>
  !!level && level.toLowerCase() !== 'none' && level.trim() !== '';

/* ════════════════════════════ PROJECTS ════════════════════════════════════ */

export const getMasterProjects = async (req: Request, res: Response) => {
  if (!requireSuperAdmin(req, res)) return;
  try {
    const today = new Date().toISOString().split('T')[0];

    // Wave 1 — org-wide lightweight scans (no joins, no groupBy) that power the
    // status distribution, PM workload, AND the 10 live status-card counts.
    // `statusOwnerRows` carries id + status + is_archived + owner_id so a single
    // scan serves every org-wide aggregate.
    const [statusOwnerRows, boardEndRows, userRows] = await Promise.all([
      prisma.projects.findMany({ select: { id: true, status: true, is_archived: true, owner_id: true, category: true } }),
      prisma.kanban_boards.findMany({ select: { projectId: true, endDate: true } }),
      prisma.users.findMany({ select: { id: true, name: true } }),
    ]);

    // Latest sprint end per project (org-wide) — the project's live Due Date.
    const sprintEndByProject = new Map<string, Date>();
    for (const b of boardEndRows) {
      if (!b.projectId || !b.endDate) continue;
      const prev = sprintEndByProject.get(b.projectId);
      if (!prev || b.endDate.getTime() > prev.getTime()) sprintEndByProject.set(b.projectId, b.endDate);
    }

    // 10 live status counts — this tally MIRRORS the table's derivedStatus so the
    // cards and the per-row badges always agree. The 8 health buckets are
    // mutually exclusive (archived › completed › cancelled › on-hold › delayed ›
    // at-risk › planning › on-track) and sum to `total`; `active` is the raw
    // "being worked on" count and intentionally overlaps the schedule buckets.
    const now = new Date();
    const todayUTC = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    const daysToEnd = (end: Date) =>
      Math.round((Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate()) - todayUTC) / 86400000);

    let active = 0, onTrack = 0, atRisk = 0, delayed = 0, onHold = 0,
      planning = 0, completed = 0, archived = 0, cancelled = 0;
    for (const p of statusOwnerRows) {
      const s = (p.status || '').toLowerCase();
      if (PROJECT_ACTIVE.includes(s)) active++;
      if (p.is_archived) { archived++; continue; }
      if (PROJECT_COMPLETED.includes(s)) { completed++; continue; }
      if (PROJECT_CANCELLED.includes(s)) { cancelled++; continue; }
      if (PROJECT_ONHOLD.includes(s)) { onHold++; continue; }
      const end = sprintEndByProject.get(p.id);
      if (end) {
        const d = daysToEnd(end);
        if (d < 0) { delayed++; continue; }
        if (d <= 7) { atRisk++; continue; }
      }
      if (PROJECT_PLANNING.includes(s)) { planning++; continue; }
      onTrack++;
    }
    const total = statusOwnerRows.length;

    const userName = new Map(userRows.map((u) => [u.id, u.name]));

    // PM workload (org-wide) — top owners by project count, names resolved
    // from the user map (avoids a per-row join).
    const pmCount = new Map<string, number>();
    for (const r of statusOwnerRows) {
      if (r.owner_id == null) continue;
      const name = userName.get(r.owner_id) || 'Unknown';
      pmCount.set(name, (pmCount.get(name) || 0) + 1);
    }
    const pmWorkload = [...pmCount.entries()]
      .map(([label, value]) => ({ label, value }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 6);

    // Projects-by-category (org-wide) — uncategorized projects roll up to a single
    // honest "Uncategorized" bucket so the chart always sums to the total.
    const categoryCount = new Map<string, number>();
    for (const r of statusOwnerRows) {
      const label = r.category && String(r.category).trim() ? String(r.category).trim() : 'Uncategorized';
      categoryCount.set(label, (categoryCount.get(label) || 0) + 1);
    }
    const categoryDistribution = [...categoryCount.entries()]
      .map(([label, value]) => ({ label, value }))
      .sort((a, b) => b.value - a.value);

    // Wave 2 — bounded detail list (most recent) + project activity feed.
    const [listRows, activityRows] = await Promise.all([
      prisma.projects.findMany({
        select: {
          id: true,
          name: true,
          status: true,
          category: true,
          is_archived: true,
          startDate: true,
          createdAt: true,
          owner: { select: { id: true, name: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: LIST_LIMIT,
      }),
      prisma.activity_logs.findMany({
        where: { project_id: { not: null } },
        orderBy: { created_at: 'desc' },
        take: 15,
        include: { actor: { select: { name: true } }, project: { select: { name: true } } },
      }),
    ]);

    const listIds = listRows.map((p) => p.id);

    // Wave 3 — relational fan-out, bounded to the displayed projects only.
    const [memberRows, blockerRows, boardRows] = await Promise.all([
      prisma.project_members.findMany({
        where: { project_id: { in: listIds } },
        select: { project_id: true, user: { select: { id: true, name: true } } },
      }),
      prisma.blocker.findMany({
        where: { projectId: { in: listIds } },
        select: { projectId: true, status: true },
      }),
      prisma.kanban_boards.findMany({
        where: { projectId: { in: listIds } },
        select: {
          projectId: true,
          // Columns are needed to resolve a task's done-state: a task's `status`
          // is typically a column id, so done = the column it lives in is "Done".
          columns: { select: { id: true, label: true } },
          tasks: { select: { status: true, storyPoints: true } },
        },
      }),
    ]);

    const memberCount = new Map<string, number>();
    // First few member names per project drive the avatar stack (initials);
    // `users` has no photo column, so avatars are initials only.
    const memberNames = new Map<string, string[]>();
    for (const m of memberRows) {
      if (!m.project_id) continue;
      memberCount.set(m.project_id, (memberCount.get(m.project_id) || 0) + 1);
      const name = m.user?.name;
      if (name) {
        const arr = memberNames.get(m.project_id) || [];
        if (arr.length < 5) arr.push(name);
        memberNames.set(m.project_id, arr);
      }
    }

    const blockerCount = new Map<string, number>();
    const openBlockerCount = new Map<string, number>();
    for (const b of blockerRows) {
      const k = b.projectId;
      if (!k) continue;
      blockerCount.set(k, (blockerCount.get(k) || 0) + 1);
      if (!matches(b.status, TICKET_RESOLVED)) {
        openBlockerCount.set(k, (openBlockerCount.get(k) || 0) + 1);
      }
    }

    // Point-based project tracking: sum story points across every task in the
    // project's sprints; "completed" points come from done tasks only.
    const pointsTotal = new Map<string, number>();
    const pointsDone = new Map<string, number>();
    for (const board of boardRows) {
      const k = board.projectId;
      if (!k) continue;
      for (const t of board.tasks) {
        const pts = t.storyPoints || 0;
        pointsTotal.set(k, (pointsTotal.get(k) || 0) + pts);
        if (taskIsDone(t.status, board.columns)) pointsDone.set(k, (pointsDone.get(k) || 0) + pts);
      }
    }

    const round1 = (n: number) => Math.round(n * 10) / 10;
    const projects = listRows.map((p) => {
      const isCompleted = matches(p.status, PROJECT_COMPLETED);
      // Point-based progress = completed story points ÷ total story points × 100
      // (0 when the project has no points — never a fabricated figure, and never
      // a division-by-zero).
      const totalPoints = round1(pointsTotal.get(p.id) || 0);
      const completedPoints = round1(pointsDone.get(p.id) || 0);
      const remainingPoints = Math.max(round1(totalPoints - completedPoints), 0);
      const progress = totalPoints > 0 ? Math.min(100, Math.round((completedPoints / totalPoints) * 100)) : 0;
      // Due date is the latest sprint's end date (null → "No Due Date"); never
      // the project's own raw endDate column.
      const sprintEnd = sprintEndByProject.get(p.id) || null;
      const endDate = sprintEnd ? sprintEnd.toISOString() : null;
      const overdue = !isCompleted && !!endDate && endDate.split('T')[0] < today;
      return {
        id: p.id,
        name: p.name,
        status: p.status,
        isArchived: !!p.is_archived,
        startDate: p.startDate,
        endDate,
        createdAt: p.createdAt,
        owner: p.owner ? { id: p.owner.id, name: p.owner.name } : null,
        memberCount: memberCount.get(p.id) || 0,
        members: memberNames.get(p.id) || [],
        // Client has no column on `projects` yet — surfaced as null so the table
        // renders an honest placeholder and auto-fills if ever added.
        client: null as string | null,
        category: p.category || null,
        blockerCount: blockerCount.get(p.id) || 0,
        openBlockerCount: openBlockerCount.get(p.id) || 0,
        totalPoints,
        completedPoints,
        remainingPoints,
        progress,
        overdue,
      };
    });

    return res.status(200).json({
      success: true,
      data: {
        stats: { total, active, onTrack, atRisk, delayed, onHold, planning, completed, archived, cancelled },
        charts: {
          statusDistribution: distribution(statusOwnerRows, 'status'),
          pmWorkload,
          categoryDistribution,
        },
        projects,
        listLimit: LIST_LIMIT,
        activities: activityRows.map((a) => ({
          id: a.id,
          actor: a.actor?.name || 'System',
          type: a.type,
          description: a.description,
          created_at: a.created_at,
          project: a.project?.name || null,
        })),
      },
    });
  } catch (error) {
    console.error('Error fetching master projects:', error);
    return res.status(500).json({ error: 'Failed to fetch organization projects' });
  }
};

/* ════════════════════════════ TICKETS ═════════════════════════════════════ */

// Resolution-SLA threshold (hours). This is a business rule, not a stored
// field (the Blocker table has no SLA column) — "within SLA" = resolved within
// this many hours of creation, measured against live resolvedAt/createdAt.
const SLA_HOURS = 72;

// Status vocabularies (case-insensitive; status is free-text VarChar).
const STATUS_OPEN = ['open', 'new', 'reopened'];
const STATUS_INPROGRESS = ['in progress', 'in_progress', 'in-progress', 'inprogress', 'ongoing', 'active', 'working', 'investigating'];
const STATUS_RESOLVED = ['resolved', 'done', 'fixed'];
const STATUS_CLOSED = ['closed', 'completed'];

export const getMasterTickets = async (req: Request, res: Response) => {
  if (!requireSuperAdmin(req, res)) return;
  try {
    const now = new Date();
    const DAY = 86400000;
    const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startYesterday = new Date(startToday.getTime() - DAY);
    const weekStart = new Date(startToday.getTime() - 6 * DAY);       // last 7 days incl today
    const prevWeekStart = new Date(startToday.getTime() - 13 * DAY);  // the 7 days before that

    // One lightweight org-wide scan powers every KPI / chart / agent metric
    // (JS aggregation — avoids dozens of count() round-trips and groupBy).
    const [coreRows, listRows, discussionRows, userRows, activityRows] = await Promise.all([
      prisma.blocker.findMany({
        select: {
          id: true, status: true, severity: true, escalationLevel: true,
          helpNeededFromId: true, loggedById: true, createdAt: true, resolvedAt: true, tags: true,
        },
      }),
      prisma.blocker.findMany({
        orderBy: { createdAt: 'desc' },
        take: LIST_LIMIT,
        select: {
          id: true, title: true, status: true, severity: true, escalationLevel: true, tags: true,
          createdAt: true, updatedAt: true,
          project: { select: { id: true, name: true } },
          helpNeededFrom: { select: { id: true, name: true } },
          loggedBy: { select: { id: true, name: true } },
        },
      }),
      prisma.blocker_discussions.findMany({ select: { blocker_id: true, created_at: true } }),
      prisma.users.findMany({ select: { id: true, name: true } }),
      prisma.activity_logs.findMany({
        where: { blocker_id: { not: null } },
        orderBy: { created_at: 'desc' },
        take: 20,
        include: { actor: { select: { name: true } } },
      }),
    ]);

    const userName = new Map(userRows.map((u) => [u.id, u.name]));
    const lc = (s: string | null | undefined) => (s || '').toLowerCase();

    // KPI buckets + flow windows
    let open = 0, inProgress = 0, resolved = 0, closed = 0, pendingReply = 0, critical = 0, escalated = 0;
    let createdToday = 0, createdYesterday = 0, createdThisWeek = 0, createdLastWeek = 0;
    let resolvedToday = 0, resolvedYesterday = 0, resolvedThisWeek = 0, resolvedLastWeek = 0;
    let resTotalMs = 0, resCount = 0;

    const prio = { Critical: 0, High: 0, Medium: 0, Low: 0 };
    const statusCounts = new Map<string, number>();
    const categoryCounts = new Map<string, number>();
    const createdAtById = new Map<number, Date>();

    type Agent = { id: number; assigned: number; resolved: number; escalated: number; resMs: number; resCount: number };
    const agentMap = new Map<number, Agent>();
    const reporterCounts = new Map<number, number>();

    const dBuckets = dayBuckets(90, now);
    const trendMap = new Map(dBuckets.map((b) => [b.key, { label: b.label, date: b.key, opened: 0, resolved: 0, escalated: 0 }]));

    // 6 contiguous rolling 7-day windows ending today (W6 = most recent).
    // `end` is the exclusive upper bound: for the most recent week it is
    // tomorrow-midnight so the window includes all of today (resolvedAt is never
    // future) — consistent with the daily trend, which also includes today.
    const weeks = Array.from({ length: 6 }, (_, i) => {
      const weeksAgo = 5 - i;
      const end = new Date(startToday.getTime() + DAY - weeksAgo * 7 * DAY);
      const start = new Date(end.getTime() - 7 * DAY);
      return { label: `W${i + 1}`, start, end, resolved: 0, withinSla: 0 };
    });

    for (const r of coreRows) {
      const s = lc(r.status);
      const sev = lc(r.severity);
      const isRes = STATUS_RESOLVED.includes(s);
      const isClosed = STATUS_CLOSED.includes(s);
      const active = !isRes && !isClosed;

      if (STATUS_OPEN.includes(s)) open++;
      if (STATUS_INPROGRESS.includes(s)) inProgress++;
      if (isRes) resolved++;
      if (isClosed) closed++;
      if (PENDING_REPLY.includes(s)) pendingReply++;
      if (active && PRIORITY_CRITICAL.includes(sev)) critical++;
      if (active && isEscalated(r.escalationLevel)) escalated++;

      statusCounts.set(r.status || 'Unknown', (statusCounts.get(r.status || 'Unknown') || 0) + 1);

      if (PRIORITY_CRITICAL.includes(sev)) prio.Critical++;
      else if (PRIORITY_HIGH.includes(sev)) prio.High++;
      else if (PRIORITY_MEDIUM.includes(sev)) prio.Medium++;
      else if (PRIORITY_LOW.includes(sev)) prio.Low++;

      // Category from tags (no structured category column exists).
      if (r.tags && r.tags.length) {
        for (const tag of r.tags) {
          const t = (tag || '').trim() || 'Uncategorized';
          categoryCounts.set(t, (categoryCounts.get(t) || 0) + 1);
        }
      } else {
        categoryCounts.set('Uncategorized', (categoryCounts.get('Uncategorized') || 0) + 1);
      }

      if (r.createdAt) {
        createdAtById.set(r.id, r.createdAt);
        if (r.createdAt >= startToday) createdToday++;
        else if (r.createdAt >= startYesterday) createdYesterday++;
        if (r.createdAt >= weekStart) createdThisWeek++;
        else if (r.createdAt >= prevWeekStart) createdLastWeek++;
        const c = trendMap.get(dayKeyOf(r.createdAt));
        if (c) { c.opened++; if (isEscalated(r.escalationLevel)) c.escalated++; }
      }

      if (r.resolvedAt) {
        if (r.resolvedAt >= startToday) resolvedToday++;
        else if (r.resolvedAt >= startYesterday) resolvedYesterday++;
        if (r.resolvedAt >= weekStart) resolvedThisWeek++;
        else if (r.resolvedAt >= prevWeekStart) resolvedLastWeek++;
        const c = trendMap.get(dayKeyOf(r.resolvedAt));
        if (c) c.resolved++;
        if (r.createdAt) {
          const ms = r.resolvedAt.getTime() - r.createdAt.getTime();
          if (ms >= 0) { resTotalMs += ms; resCount++; }
          for (const w of weeks) {
            if (r.resolvedAt >= w.start && r.resolvedAt < w.end) {
              w.resolved++;
              if (ms >= 0 && ms <= SLA_HOURS * 3600000) w.withinSla++;
              break;
            }
          }
        }
      }

      if (r.helpNeededFromId != null) {
        let a = agentMap.get(r.helpNeededFromId);
        if (!a) { a = { id: r.helpNeededFromId, assigned: 0, resolved: 0, escalated: 0, resMs: 0, resCount: 0 }; agentMap.set(r.helpNeededFromId, a); }
        a.assigned++;
        if (isRes || isClosed) {
          a.resolved++;
          if (r.resolvedAt && r.createdAt) {
            const ms = r.resolvedAt.getTime() - r.createdAt.getTime();
            if (ms >= 0) { a.resMs += ms; a.resCount++; }
          }
        }
        if (isEscalated(r.escalationLevel)) a.escalated++;
      }

      if (r.loggedById != null) reporterCounts.set(r.loggedById, (reporterCounts.get(r.loggedById) || 0) + 1);
    }

    // Avg first-response time from the earliest discussion per ticket.
    const earliest = new Map<number, Date>();
    for (const d of discussionRows) {
      const cur = earliest.get(d.blocker_id);
      if (!cur || d.created_at < cur) earliest.set(d.blocker_id, d.created_at);
    }
    let respTotalMs = 0, respCount = 0;
    for (const [bid, firstAt] of earliest) {
      const created = createdAtById.get(bid);
      if (created) { const ms = firstAt.getTime() - created.getTime(); if (ms >= 0) { respTotalMs += ms; respCount++; } }
    }

    const round1 = (n: number) => Math.round(n * 10) / 10;
    const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 100) : 0);
    const deltaPct = (cur: number, prev: number) => (prev > 0 ? Math.round(((cur - prev) / prev) * 100) : cur > 0 ? 100 : 0);

    const avgResolutionHours = resCount > 0 ? round1(resTotalMs / resCount / 3600000) : null;
    const avgResponseHours = respCount > 0 ? round1(respTotalMs / respCount / 3600000) : null;

    const agents = [...agentMap.values()]
      .map((a) => ({
        id: a.id,
        name: userName.get(a.id) || `User ${a.id}`,
        assigned: a.assigned,
        resolved: a.resolved,
        escalated: a.escalated,
        avgResolutionHours: a.resCount > 0 ? round1(a.resMs / a.resCount / 3600000) : null,
        resolutionRate: a.assigned > 0 ? Math.round((a.resolved / a.assigned) * 100) : 0,
        csat: null as number | null,
      }))
      .sort((x, y) => y.assigned - x.assigned)
      .slice(0, 15);

    const workload = agents.slice(0, 8).map((a) => ({ label: a.name, value: a.assigned }));
    const topReporters = [...reporterCounts.entries()]
      .map(([id, value]) => ({ label: userName.get(id) || `User ${id}`, value }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 5);
    const categoryDistribution = [...categoryCounts.entries()]
      .map(([label, value]) => ({ label, value }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 8);
    const statusDistribution = [...statusCounts.entries()]
      .map(([label, value]) => ({ label, value }))
      .filter((d) => d.value > 0)
      .sort((a, b) => b.value - a.value);
    const priorityDistribution = [
      { label: 'Critical', value: prio.Critical },
      { label: 'High', value: prio.High },
      { label: 'Medium', value: prio.Medium },
      { label: 'Low', value: prio.Low },
    ];
    const weeklySla = weeks.map((w) => ({
      label: w.label,
      resolved: w.resolved,
      withinSla: w.withinSla,
      compliancePct: w.resolved > 0 ? Math.round((w.withinSla / w.resolved) * 100) : 0,
    }));

    const total = coreRows.length;
    const activeCount = total - resolved - closed;

    const tickets = listRows.map((t) => ({
      id: t.id,
      title: t.title,
      status: t.status,
      severity: t.severity,
      escalationLevel: t.escalationLevel,
      category: t.tags && t.tags.length ? t.tags[0] : 'Uncategorized',
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
      project: t.project ? { id: t.project.id, name: t.project.name } : null,
      assignee: t.helpNeededFrom ? { id: t.helpNeededFrom.id, name: t.helpNeededFrom.name } : null,
      reporter: t.loggedBy ? { id: t.loggedBy.id, name: t.loggedBy.name } : null,
      ageDays: t.createdAt ? Math.floor((now.getTime() - t.createdAt.getTime()) / DAY) : 0,
    }));

    return res.status(200).json({
      success: true,
      data: {
        stats: { total, open, inProgress, resolved, closed, pendingReply, critical, escalated, newToday: createdToday, resolvedToday },
        indicators: {
          openNetToday: createdToday - resolvedToday,
          criticalPctOfActive: pct(critical, activeCount),
          escalatedPctOfActive: pct(escalated, activeCount),
          pendingPctOfActive: pct(pendingReply, activeCount),
          createdToday, createdYesterday, resolvedToday, resolvedYesterday,
          createdThisWeek, createdLastWeek, resolvedThisWeek, resolvedLastWeek,
          createdTodayVsYesterdayPct: deltaPct(createdToday, createdYesterday),
          resolvedTodayVsYesterdayPct: deltaPct(resolvedToday, resolvedYesterday),
          createdWeekVsLastPct: deltaPct(createdThisWeek, createdLastWeek),
          resolvedWeekVsLastPct: deltaPct(resolvedThisWeek, resolvedLastWeek),
          avgResolutionHours, avgResponseHours,
        },
        charts: { statusDistribution, priorityDistribution, categoryDistribution, resolutionTrend: [...trendMap.values()], weeklySla },
        agents,
        workload,
        topReporters,
        tickets,
        activities: activityRows.map((a) => ({
          id: a.id,
          actor: a.actor?.name || 'System',
          type: a.type,
          description: a.description,
          created_at: a.created_at,
        })),
        slaHours: SLA_HOURS,
      },
    });
  } catch (error) {
    console.error('Error fetching master tickets:', error);
    return res.status(500).json({ error: 'Failed to fetch organization tickets' });
  }
};

/**
 * Single ticket (Blocker) detail for the SuperAdmin drill-in page —
 * info + description + comments (discussions) + attachments + activity timeline.
 */
export const getMasterTicketDetail = async (req: Request, res: Response) => {
  if (!requireSuperAdmin(req, res)) return;
  const id = parseInt(String(req.params.id), 10);
  if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid ticket id' });
  try {
    const blocker = await prisma.blocker.findUnique({
      where: { id },
      include: {
        project: { select: { id: true, name: true } },
        loggedBy: { select: { id: true, name: true, email: true } },
        helpNeededFrom: { select: { id: true, name: true, email: true } },
        resolvedBy: { select: { id: true, name: true, email: true } },
      },
    });
    if (!blocker) return res.status(404).json({ error: 'Ticket not found' });

    const [comments, attachments, activity] = await Promise.all([
      prisma.blocker_discussions.findMany({
        where: { blocker_id: id },
        orderBy: { created_at: 'asc' },
        include: { sender: { select: { id: true, name: true, email: true } } },
      }),
      prisma.blocker_attachments.findMany({
        where: { blocker_id: id },
        orderBy: { uploaded_at: 'desc' },
        include: { uploader: { select: { id: true, name: true } } },
      }),
      prisma.activity_logs.findMany({
        where: { blocker_id: id },
        orderBy: { created_at: 'desc' },
        take: 50,
        include: { actor: { select: { name: true } } },
      }),
    ]);

    const now = new Date();
    const resolutionHours = blocker.resolvedAt && blocker.createdAt
      ? Math.round(((blocker.resolvedAt.getTime() - blocker.createdAt.getTime()) / 3600000) * 10) / 10
      : null;

    return res.status(200).json({
      success: true,
      data: {
        ticket: {
          id: blocker.id,
          title: blocker.title,
          description: blocker.description,
          status: blocker.status,
          severity: blocker.severity,
          escalationLevel: blocker.escalationLevel,
          tags: blocker.tags,
          notes: blocker.notes,
          createdAt: blocker.createdAt,
          updatedAt: blocker.updatedAt,
          resolvedAt: blocker.resolvedAt,
          ageDays: blocker.createdAt ? Math.floor((now.getTime() - blocker.createdAt.getTime()) / 86400000) : 0,
          resolutionHours,
          project: blocker.project ? { id: blocker.project.id, name: blocker.project.name } : null,
          reporter: blocker.loggedBy ? { id: blocker.loggedBy.id, name: blocker.loggedBy.name, email: blocker.loggedBy.email } : null,
          assignee: blocker.helpNeededFrom ? { id: blocker.helpNeededFrom.id, name: blocker.helpNeededFrom.name, email: blocker.helpNeededFrom.email } : null,
          resolvedBy: blocker.resolvedBy ? { id: blocker.resolvedBy.id, name: blocker.resolvedBy.name, email: blocker.resolvedBy.email } : null,
        },
        comments: comments.map((c) => ({
          id: c.id,
          author: c.sender?.name || 'Unknown',
          authorEmail: c.sender?.email || null,
          message: c.message,
          created_at: c.created_at,
        })),
        attachments: attachments.map((a) => ({
          id: a.id,
          fileName: a.file_name,
          fileUrl: a.file_url,
          fileSize: a.file_size,
          description: a.description,
          uploadedBy: a.uploader?.name || 'Unknown',
          uploadedAt: a.uploaded_at,
        })),
        activity: activity.map((a) => ({
          id: a.id,
          actor: a.actor?.name || 'System',
          type: a.type,
          description: a.description,
          created_at: a.created_at,
        })),
      },
    });
  } catch (error) {
    console.error('Error fetching ticket detail:', error);
    return res.status(500).json({ error: 'Failed to fetch ticket detail' });
  }
};

/* ════════════════════════════ SALES ═══════════════════════════════════════ */

export const getMasterSales = async (req: Request, res: Response) => {
  if (!requireSuperAdmin(req, res)) return;
  try {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const trendStart = new Date(now.getFullYear(), now.getMonth() - 5, 1);

    const [
      totalLeads,
      newLeads,
      convertedLeads,
      totalDeals,
      wonAgg,
      openAgg,
      lostDeals,
      totalOpportunities,
    ] = await Promise.all([
      prisma.lead.count(),
      prisma.lead.count({ where: { createdAt: { gte: monthStart } } }),
      prisma.deal.count({ where: { leadId: { not: null } } }),
      prisma.deal.count(),
      prisma.deal.aggregate({ _sum: { amount: true }, _count: { _all: true }, where: { status: 'won' } }),
      prisma.deal.aggregate({ _sum: { amount: true }, _count: { _all: true }, where: { status: 'open' } }),
      prisma.deal.count({ where: { status: 'lost' } }),
      prisma.opportunity.count(),
    ]);

    // Purpose-scoped, lightweight deal queries (no single unbounded full scan):
    //  - stageRows: 2 cols over all deals → stage distribution.
    //  - openDealRows: open subset only → weighted forecast.
    //  - wonTrendRows: won deals in the last 6 months only → revenue trend.
    const [stageRows, openDealRows, wonTrendRows, leadSourceRows, leadStageRows, activityRows, topDealRows] =
      await Promise.all([
        prisma.deal.findMany({ select: { stage: true, amount: true } }),
        prisma.deal.findMany({ where: { status: 'open' }, select: { amount: true, probability: true } }),
        prisma.deal.findMany({
          where: { status: 'won', OR: [{ closedAt: { gte: trendStart } }, { closedAt: null, updatedAt: { gte: trendStart } }] },
          select: { amount: true, closedAt: true, updatedAt: true },
        }),
        prisma.lead.findMany({ select: { source: true, status: true } }),
        // Lead-stage distribution mirrors the Leads Pipeline board: exclude leads
        // taken off-board by an action (converted → Deal, disqualified) so a
        // stage's count never inflates past what the board/funnel show.
        prisma.lead.findMany({ where: { status: { notIn: ['converted', 'disqualified'] } }, select: { stage: true } }),
        prisma.activity_logs.findMany({
          where: { OR: [{ lead_id: { not: null } }, { deal_id: { not: null } }] },
          orderBy: { created_at: 'desc' },
          take: 15,
          include: {
            actor: { select: { name: true } },
            deal: { select: { title: true } },
            lead: { select: { title: true } },
          },
        }),
        prisma.deal.findMany({
          where: { status: 'open' },
          orderBy: { amount: 'desc' },
          take: 8,
          select: {
            id: true,
            title: true,
            amount: true,
            stage: true,
            status: true,
            probability: true,
            owner: { select: { id: true, name: true } },
          },
        }),
      ]);

    const revenue = wonAgg._sum.amount || 0;
    const wonDeals = wonAgg._count._all;
    const pipelineValue = openAgg._sum.amount || 0;
    const openDeals = openAgg._count._all;
    const conversionRate = totalLeads > 0 ? Math.round((convertedLeads / totalLeads) * 100) : 0;
    const avgDealSize = wonDeals > 0 ? Math.round(revenue / wonDeals) : 0;

    // Weighted forecast over open deals (amount × probability).
    let forecast = 0;
    for (const d of openDealRows) forecast += (d.amount || 0) * ((d.probability ?? 0) / 100);
    forecast = Math.round(forecast);

    // Deal-stage distribution (count + value).
    const stageMap = new Map<string, { value: number; amount: number }>();
    for (const d of stageRows) {
      const label = d.stage ?? 'Unknown';
      const cur = stageMap.get(label) || { value: 0, amount: 0 };
      cur.value += 1;
      cur.amount += d.amount || 0;
      stageMap.set(label, cur);
    }
    const dealStage = [...stageMap.entries()]
      .map(([label, v]) => ({ label, value: v.value, amount: v.amount }))
      .filter((d) => d.value > 0)
      .sort((a, b) => b.value - a.value);

    // Revenue trend — won-deal value bucketed into the last 6 months.
    const buckets = monthBuckets(6, now);
    const revMap = new Map(buckets.map((b) => [b.key, { label: b.label, revenue: 0 }]));
    for (const d of wonTrendRows) {
      const dt = d.closedAt || d.updatedAt;
      if (!dt) continue;
      const bucket = revMap.get(monthKeyOf(dt));
      if (bucket) bucket.revenue += d.amount || 0;
    }

    const dealStatus = [
      { label: 'Open', value: openDeals },
      { label: 'Won', value: wonDeals },
      { label: 'Lost', value: lostDeals },
    ].filter((d) => d.value > 0);

    // ── Team Leaderboard (org-wide) ──────────────────────────────────────────
    // Per-owner revenue target vs LIVE closed revenue, computed with the SAME
    // target engine (targetService) the Sales Target module uses — so achievement
    // never drifts (single source of truth). Limited to currently-ACTIVE revenue
    // targets so the board reflects current-period performance.
    const [revenueTargetRows, wonDealSourceRows] = await Promise.all([
      prisma.salesTarget.findMany({
        where: { type: 'revenue' },
        select: { ownerId: true, period: true, periodType: true, targetAmount: true },
      }),
      prisma.deal.findMany({ where: { status: 'won' }, select: { amount: true, lead: { select: { source: true } } } }),
    ]);

    const lbAgg = new Map<number, { target: number; closed: number }>();
    for (const t of revenueTargetRows) {
      const win = targetService.periodWindow(t.period, t.periodType as any);
      if (!(win.start <= now && now < win.end)) continue; // active period only
      const achieved = await targetService.computeActual(t.ownerId, 'revenue', win);
      const row = lbAgg.get(t.ownerId) ?? { target: 0, closed: 0 };
      row.target += t.targetAmount;
      row.closed += achieved;
      lbAgg.set(t.ownerId, row);
    }
    const lbOwnerIds = [...lbAgg.keys()];
    const lbOwners = lbOwnerIds.length
      ? await prisma.users.findMany({ where: { id: { in: lbOwnerIds } }, select: { id: true, name: true } })
      : [];
    const lbName = new Map(lbOwners.map((o) => [o.id, o.name]));
    const leaderboard = [...lbAgg.entries()]
      .map(([ownerId, v]) => ({
        ownerId,
        name: lbName.get(ownerId) ?? `User #${ownerId}`,
        target: v.target,
        closedRevenue: v.closed,
        achievementPct: v.target > 0 ? Math.round((v.closed / v.target) * 100) : 0,
      }))
      .sort((a, b) => b.achievementPct - a.achievementPct || b.closedRevenue - a.closedRevenue)
      .slice(0, 10);

    // ── Lead Source Analytics (org-wide) ─────────────────────────────────────
    // Count + conversion% (won/converted leads) + revenue (won-deal value whose
    // lead came from that source). Groups by whatever source values exist, so a
    // newly added Lead Source appears automatically with no code change.
    const WON_LEAD_STATUSES = ['won', 'converted'];
    const srcAgg = new Map<string, { count: number; won: number; revenue: number }>();
    for (const l of leadSourceRows) {
      const key = (l.source || 'manual').toLowerCase();
      const cur = srcAgg.get(key) ?? { count: 0, won: 0, revenue: 0 };
      cur.count += 1;
      if (WON_LEAD_STATUSES.includes((l.status || '').toLowerCase())) cur.won += 1;
      srcAgg.set(key, cur);
    }
    for (const d of wonDealSourceRows) {
      const key = (d.lead?.source || '').toLowerCase();
      if (!key) continue;
      const cur = srcAgg.get(key) ?? { count: 0, won: 0, revenue: 0 };
      cur.revenue += d.amount || 0;
      srcAgg.set(key, cur);
    }
    const leadSourceAnalytics = [...srcAgg.entries()]
      .map(([source, v]) => ({
        source,
        count: v.count,
        conversionRate: v.count > 0 ? Math.round((v.won / v.count) * 1000) / 10 : 0,
        revenue: v.revenue,
      }))
      .sort((a, b) => b.count - a.count);

    return res.status(200).json({
      success: true,
      data: {
        stats: {
          totalLeads,
          newLeads,
          convertedLeads,
          conversionRate,
          totalOpportunities,
          totalDeals,
          openDeals,
          wonDeals,
          lostDeals,
          revenue,
          pipelineValue,
          forecast,
          avgDealSize,
        },
        charts: {
          dealStage,
          leadSource: distribution(leadSourceRows, 'source'),
          leadStage: distribution(leadStageRows, 'stage'),
          dealStatus,
          revenueTrend: [...revMap.values()],
        },
        topDeals: topDealRows.map((d) => ({
          id: d.id,
          title: d.title,
          amount: d.amount,
          stage: d.stage,
          status: d.status,
          probability: d.probability,
          owner: d.owner ? { id: d.owner.id, name: d.owner.name } : null,
        })),
        activities: activityRows.map((a) => ({
          id: a.id,
          actor: a.actor?.name || 'System',
          type: a.type,
          description: a.description,
          created_at: a.created_at,
        })),
        leaderboard,
        leadSourceAnalytics,
      },
    });
  } catch (error) {
    console.error('Error fetching master sales:', error);
    return res.status(500).json({ error: 'Failed to fetch organization sales data' });
  }
};

/* ════════════════════════════ HR ═══════════════════════════════════════════ */

/**
 * Organization-wide HR snapshot for the SuperAdmin HR dashboard
 * (`/master-dashboard/hr`). Every figure is LIVE from the HR tables (employees,
 * attendance, leaves, candidates, payroll, performance_appraisals) — the same
 * single source of truth the HR module controllers use. Empty datasets resolve
 * to 0 / [] (no mock values). Raw SQL mirrors the HR controllers' style and
 * keeps aggregate types cheap for tsc (no Prisma groupBy).
 *
 * NOTE on the "Late Today" figure: it powers the dashboard's Clock KPI card
 * (labelled "TRAVEL TIME" in the approved UI); there is no travel-time source in
 * the schema, so the closest live attendance metric is used.
 */
export const getMasterHR = async (req: Request, res: Response) => {
  if (!requireSuperAdmin(req, res)) return;
  try {
    const today = new Date().toISOString().split('T')[0];

    // Wave 1 — cheap KPI aggregates (counts / sums), all org-wide.
    const [
      totalRows, presentRows, lateRows, leaveRows,
      joinersRows, payrollMonthRows, interviewRows, openRoleRows,
    ] = await Promise.all([
      prisma.$queryRawUnsafe<any[]>(`SELECT COUNT(*) AS c FROM employees;`),
      prisma.$queryRawUnsafe<any[]>(`SELECT COUNT(*) AS c FROM attendance WHERE date = $1::date AND status = 'present';`, today),
      prisma.$queryRawUnsafe<any[]>(`SELECT COUNT(*) AS c FROM attendance WHERE date = $1::date AND status = 'late';`, today),
      prisma.$queryRawUnsafe<any[]>(`SELECT COUNT(DISTINCT employee_id) AS c FROM attendance WHERE date = $1::date AND status IN ('leave_full_day', 'leave_half_day');`, today),
      prisma.$queryRawUnsafe<any[]>(`SELECT COUNT(*) AS c FROM employees WHERE DATE_TRUNC('month', join_date) = DATE_TRUNC('month', CURRENT_DATE);`),
      prisma.$queryRawUnsafe<any[]>(`SELECT COALESCE(SUM(net_salary), 0) AS total FROM payroll WHERE DATE_TRUNC('month', created_at) = DATE_TRUNC('month', CURRENT_DATE);`),
      prisma.$queryRawUnsafe<any[]>(`SELECT COUNT(*) AS c FROM candidates WHERE stage = 'Interview';`),
      prisma.$queryRawUnsafe<any[]>(`SELECT COUNT(DISTINCT position) AS c FROM candidates WHERE stage NOT IN ('Hired', 'Rejected');`),
    ]);

    const totalEmployees = Number(totalRows[0]?.c || 0);
    const presentToday = Number(presentRows[0]?.c || 0);
    const lateToday = Number(lateRows[0]?.c || 0);
    const onLeave = Number(leaveRows[0]?.c || 0);
    const newJoiners = Number(joinersRows[0]?.c || 0);
    const payrollMonthTotal = Number(payrollMonthRows[0]?.total || 0);
    const pendingInterviews = Number(interviewRows[0]?.c || 0);
    const openRoles = Number(openRoleRows[0]?.c || 0);
    const absent = Math.max(0, totalEmployees - presentToday - lateToday - onLeave);

    // Wave 2 — detail lists (bounded) + distributions.
    const [employeeRows, leaveReqRows, pipelineRows, payrollTrendRows] = await Promise.all([
      // Employees + their live average appraisal rating (final_rating, 0–5;
      // 0/NULL ratings excluded so unrated employees read as 0, not a low avg).
      prisma.$queryRawUnsafe<any[]>(
        `SELECT e.id, u.name, e.department, e.designation, e.join_date, e.salary, e.employment_status,
                COALESCE(AVG(pa.final_rating) FILTER (WHERE pa.final_rating IS NOT NULL AND pa.final_rating > 0), 0) AS rating
         FROM employees e
         LEFT JOIN users u ON e.user_id = u.id
         LEFT JOIN performance_appraisals pa ON pa.employee_id = e.id
         GROUP BY e.id, u.name
         ORDER BY e.join_date DESC NULLS LAST, e.id DESC
         LIMIT $1;`,
        LIST_LIMIT,
      ),
      // Recent leave requests (leaves table). May be empty → renders empty state.
      prisma.$queryRawUnsafe<any[]>(
        `SELECT l.id, u.name, l.leave_type, l.start_date, l.end_date, l.status
         FROM leaves l
         JOIN employees e ON l.employee_id = e.id
         LEFT JOIN users u ON e.user_id = u.id
         ORDER BY l.created_at DESC
         LIMIT 6;`,
      ),
      prisma.$queryRawUnsafe<any[]>(`SELECT stage, COUNT(*) AS c FROM candidates GROUP BY stage;`),
      // Payroll net-salary totals for the last 6 calendar months (by created_at).
      prisma.$queryRawUnsafe<any[]>(
        `SELECT DATE_TRUNC('month', created_at) AS bucket,
                TO_CHAR(DATE_TRUNC('month', created_at), 'Mon') AS month,
                COALESCE(SUM(net_salary), 0) AS total
         FROM payroll
         WHERE created_at >= DATE_TRUNC('month', CURRENT_DATE) - INTERVAL '5 months'
         GROUP BY bucket
         ORDER BY bucket ASC;`,
      ),
    ]);

    const employees = employeeRows.map((e) => ({
      id: Number(e.id),
      name: e.name || 'Unknown',
      department: e.department || '—',
      designation: e.designation || '—',
      joinDate: e.join_date,
      salary: e.salary != null ? Number(e.salary) : null,
      status: e.employment_status || 'active',
      rating: Math.round((Number(e.rating) || 0) * 10) / 10,
    }));

    const leaveRequests = leaveReqRows.map((l) => ({
      id: Number(l.id),
      name: l.name || 'Employee',
      leaveType: l.leave_type,
      startDate: l.start_date,
      endDate: l.end_date,
      status: l.status,
    }));

    // Recruitment pipeline in fixed board order; missing stages → 0.
    const stageCounts: Record<string, number> = {};
    for (const r of pipelineRows) stageCounts[String(r.stage)] = Number(r.c || 0);
    const PIPELINE_STAGES = ['Applied', 'Screening', 'Interview', 'Offer', 'Hired'];
    const recruitmentPipeline = PIPELINE_STAGES.map((stage) => ({ stage, count: stageCounts[stage] || 0 }));

    // Payroll trend in ₹ lakh (2dp) for the months that have records.
    const payrollTrend = payrollTrendRows.map((p) => ({
      month: String(p.month),
      amount: Math.round((Number(p.total || 0) / 100000) * 100) / 100,
    }));

    // Recent joiners = 3 most-recently-joined (employees already sorted desc).
    const recentJoiners = employees.slice(0, 3).map((e) => ({
      name: e.name,
      designation: e.designation,
      joinDate: e.joinDate,
    }));

    const currentMonthLabel = new Date().toLocaleString('en-US', { month: 'short', year: 'numeric' });

    return res.status(200).json({
      success: true,
      data: {
        stats: {
          totalEmployees,
          lateToday,
          onLeave,
          openRoles,
          newJoiners,
          pendingInterviews,
          payrollMonthTotal,
        },
        attendance: { present: presentToday, late: lateToday, leave: onLeave, absent, total: totalEmployees },
        employees,
        leaveRequests,
        recruitmentPipeline,
        recentJoiners,
        payroll: {
          trend: payrollTrend,
          currentMonthLabel,
          currentMonthTotal: payrollMonthTotal,
        },
      },
    });
  } catch (error) {
    console.error('Error fetching master HR:', error);
    return res.status(500).json({ error: 'Failed to fetch organization HR data' });
  }
};

/* ── HR tab endpoints (server-side filtered + searched) ──────────────────────
 * One endpoint per master HR tab. Each accepts filter/search query params and
 * returns the tab's KPIs/analytics + a bounded, filtered record list — the same
 * HR tables as SSOT, org-wide, SuperAdmin-gated. `q` is case-insensitive (ILIKE).
 * A tiny positional-arg builder keeps the dynamic WHERE injection-safe.
 */

const strParam = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const isSet = (v: string): boolean => v !== '' && v.toLowerCase() !== 'all';

/** GET /master-dashboard/hr/attendance?department&status&from&to&q */
export const getMasterHRAttendance = async (req: Request, res: Response) => {
  if (!requireSuperAdmin(req, res)) return;
  try {
    const department = strParam(req.query.department);
    const statusF = strParam(req.query.status);
    const from = strParam(req.query.from);
    const to = strParam(req.query.to);
    const q = strParam(req.query.q);

    // Shared filters (everything EXCEPT status — the status breakdown cards must
    // still show every status within the selected dept/date/search scope).
    const baseArgs: any[] = [];
    const baseP = (v: any) => { baseArgs.push(v); return `$${baseArgs.length}`; };
    const baseClauses: string[] = [];
    if (isSet(department)) baseClauses.push(`e.department = ${baseP(department)}`);
    if (from) baseClauses.push(`a.date >= ${baseP(from)}::date`);
    if (to) baseClauses.push(`a.date <= ${baseP(to)}::date`);
    if (q) baseClauses.push(`(u.name ILIKE ${baseP(`%${q}%`)} OR e.employee_code ILIKE ${baseP(`%${q}%`)})`);
    const baseWhere = baseClauses.length ? `WHERE ${baseClauses.join(' AND ')}` : '';

    // Status breakdown for KPI cards (base filters only).
    const summaryRows = await prisma.$queryRawUnsafe<any[]>(
      `SELECT a.status, COUNT(*) AS c
       FROM attendance a
       JOIN employees e ON a.employee_id = e.id
       LEFT JOIN users u ON e.user_id = u.id
       ${baseWhere}
       GROUP BY a.status;`,
      ...baseArgs,
    );
    const sc: Record<string, number> = {};
    for (const r of summaryRows) sc[String(r.status)] = Number(r.c || 0);
    const leaveCount = (sc['leave_full_day'] || 0) + (sc['leave_half_day'] || 0);
    const summary = {
      present: sc['present'] || 0,
      late: (sc['late'] || 0) + (sc['late_after_lunch'] || 0),
      leave: leaveCount,
      absent: sc['absent'] || 0,
      total: Object.values(sc).reduce((s, n) => s + n, 0),
    };

    // Record list (adds the status filter on top of the base filters).
    const args = [...baseArgs];
    const p = (v: any) => { args.push(v); return `$${args.length}`; };
    const clauses = [...baseClauses];
    if (isSet(statusF)) {
      // Mirror the KPI card grouping: "leave" = both leave types, "late" also
      // includes late-after-lunch, so a filtered list matches its status card.
      if (statusF === 'leave') clauses.push(`a.status IN ('leave_full_day', 'leave_half_day')`);
      else if (statusF === 'late') clauses.push(`a.status IN ('late', 'late_after_lunch')`);
      else clauses.push(`a.status = ${p(statusF)}`);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = await prisma.$queryRawUnsafe<any[]>(
      `SELECT a.id, a.date, a.check_in, a.check_out, a.work_hours, a.status, a.leave_type,
              e.employee_code, e.department, e.designation, u.name
       FROM attendance a
       JOIN employees e ON a.employee_id = e.id
       LEFT JOIN users u ON e.user_id = u.id
       ${where}
       ORDER BY a.date DESC, a.id DESC
       LIMIT ${LIST_LIMIT};`,
      ...args,
    );
    const records = rows.map((a) => ({
      id: Number(a.id),
      date: a.date,
      name: a.name || 'Unknown',
      employeeCode: a.employee_code,
      department: a.department || '—',
      designation: a.designation || '—',
      checkIn: a.check_in,
      checkOut: a.check_out,
      workHours: a.work_hours != null ? Number(a.work_hours) : null,
      status: a.status,
      leaveType: a.leave_type,
    }));

    return res.status(200).json({ success: true, data: { summary, records } });
  } catch (error) {
    console.error('Error fetching master HR attendance:', error);
    return res.status(500).json({ error: 'Failed to fetch HR attendance' });
  }
};

/** GET /master-dashboard/hr/leave?status&type&from&to&q */
export const getMasterHRLeave = async (req: Request, res: Response) => {
  if (!requireSuperAdmin(req, res)) return;
  try {
    const statusF = strParam(req.query.status);
    const type = strParam(req.query.type);
    const from = strParam(req.query.from);
    const to = strParam(req.query.to);
    const q = strParam(req.query.q);

    const baseArgs: any[] = [];
    const baseP = (v: any) => { baseArgs.push(v); return `$${baseArgs.length}`; };
    const baseClauses: string[] = [];
    if (isSet(type)) baseClauses.push(`LOWER(l.leave_type) = LOWER(${baseP(type)})`);
    if (from) baseClauses.push(`l.start_date >= ${baseP(from)}::date`);
    if (to) baseClauses.push(`l.end_date <= ${baseP(to)}::date`);
    if (q) baseClauses.push(`(u.name ILIKE ${baseP(`%${q}%`)} OR l.leave_type ILIKE ${baseP(`%${q}%`)})`);
    const baseWhere = baseClauses.length ? `WHERE ${baseClauses.join(' AND ')}` : '';

    const countRows = await prisma.$queryRawUnsafe<any[]>(
      `SELECT LOWER(l.status) AS status, COUNT(*) AS c
       FROM leaves l
       JOIN employees e ON l.employee_id = e.id
       LEFT JOIN users u ON e.user_id = u.id
       ${baseWhere}
       GROUP BY LOWER(l.status);`,
      ...baseArgs,
    );
    const lc: Record<string, number> = {};
    for (const r of countRows) lc[String(r.status)] = Number(r.c || 0);
    const counts = {
      pending: lc['pending'] || 0,
      approved: lc['approved'] || 0,
      rejected: lc['rejected'] || 0,
      total: Object.values(lc).reduce((s, n) => s + n, 0),
    };

    const args = [...baseArgs];
    const p = (v: any) => { args.push(v); return `$${args.length}`; };
    const clauses = [...baseClauses];
    if (isSet(statusF)) clauses.push(`LOWER(l.status) = LOWER(${p(statusF)})`);
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = await prisma.$queryRawUnsafe<any[]>(
      `SELECT l.id, u.name, e.employee_code, e.department, l.leave_type, l.start_date,
              l.end_date, l.days, l.status, l.reason, l.approved_by_name
       FROM leaves l
       JOIN employees e ON l.employee_id = e.id
       LEFT JOIN users u ON e.user_id = u.id
       ${where}
       ORDER BY l.created_at DESC
       LIMIT ${LIST_LIMIT};`,
      ...args,
    );
    const records = rows.map((l) => ({
      id: Number(l.id),
      name: l.name || 'Employee',
      employeeCode: l.employee_code,
      department: l.department || '—',
      leaveType: l.leave_type,
      startDate: l.start_date,
      endDate: l.end_date,
      days: l.days != null ? Number(l.days) : null,
      status: l.status,
      reason: l.reason,
      approvedByName: l.approved_by_name,
    }));

    return res.status(200).json({ success: true, data: { counts, records } });
  } catch (error) {
    console.error('Error fetching master HR leave:', error);
    return res.status(500).json({ error: 'Failed to fetch HR leave' });
  }
};

/** GET /master-dashboard/hr/recruitment?stage&q */
export const getMasterHRRecruitment = async (req: Request, res: Response) => {
  if (!requireSuperAdmin(req, res)) return;
  try {
    const stage = strParam(req.query.stage);
    const q = strParam(req.query.q);

    const baseArgs: any[] = [];
    const baseP = (v: any) => { baseArgs.push(v); return `$${baseArgs.length}`; };
    const baseClauses: string[] = [];
    if (q) baseClauses.push(`(full_name ILIKE ${baseP(`%${q}%`)} OR position ILIKE ${baseP(`%${q}%`)})`);
    const baseWhere = baseClauses.length ? `WHERE ${baseClauses.join(' AND ')}` : '';

    const pipeRows = await prisma.$queryRawUnsafe<any[]>(
      `SELECT stage, COUNT(*) AS c FROM candidates ${baseWhere} GROUP BY stage;`,
      ...baseArgs,
    );
    const stageCounts: Record<string, number> = {};
    for (const r of pipeRows) stageCounts[String(r.stage)] = Number(r.c || 0);
    const PIPELINE_STAGES = ['Applied', 'Screening', 'Interview', 'Offer', 'Hired'];
    const pipeline = PIPELINE_STAGES.map((s) => ({ stage: s, count: stageCounts[s] || 0 }));
    // Honour the same base (search) filter as the sibling counts for consistency.
    const openWhere = baseClauses.length ? ` AND ${baseClauses.join(' AND ')}` : '';
    const openRows = await prisma.$queryRawUnsafe<any[]>(
      `SELECT COUNT(DISTINCT position) AS c FROM candidates WHERE stage NOT IN ('Hired', 'Rejected')${openWhere};`,
      ...baseArgs,
    );
    const counts = {
      openPositions: Number(openRows[0]?.c || 0),
      applicants: Object.values(stageCounts).reduce((s, n) => s + n, 0),
      interview: stageCounts['Interview'] || 0,
      selected: stageCounts['Hired'] || 0,
      rejected: stageCounts['Rejected'] || 0,
    };

    const args = [...baseArgs];
    const p = (v: any) => { args.push(v); return `$${args.length}`; };
    const clauses = [...baseClauses];
    if (isSet(stage)) clauses.push(`stage = ${p(stage)}`);
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = await prisma.$queryRawUnsafe<any[]>(
      `SELECT id, full_name, email, phone, position, stage, experience, expected_ctc, interview_date
       FROM candidates
       ${where}
       ORDER BY created_at DESC
       LIMIT ${LIST_LIMIT};`,
      ...args,
    );
    const records = rows.map((c) => ({
      id: Number(c.id),
      fullName: c.full_name,
      email: c.email,
      phone: c.phone,
      position: c.position,
      stage: c.stage,
      experience: c.experience,
      expectedCtc: c.expected_ctc != null ? Number(c.expected_ctc) : null,
      interviewDate: c.interview_date,
    }));

    return res.status(200).json({ success: true, data: { pipeline, counts, records } });
  } catch (error) {
    console.error('Error fetching master HR recruitment:', error);
    return res.status(500).json({ error: 'Failed to fetch HR recruitment' });
  }
};

/** GET /master-dashboard/hr/payroll?status&month&q */
export const getMasterHRPayroll = async (req: Request, res: Response) => {
  if (!requireSuperAdmin(req, res)) return;
  try {
    const statusF = strParam(req.query.status);
    const month = strParam(req.query.month);
    const q = strParam(req.query.q);

    const baseArgs: any[] = [];
    const baseP = (v: any) => { baseArgs.push(v); return `$${baseArgs.length}`; };
    const baseClauses: string[] = [];
    if (isSet(month)) baseClauses.push(`p.month ILIKE ${baseP(`%${month}%`)}`);
    if (q) baseClauses.push(`u.name ILIKE ${baseP(`%${q}%`)}`);
    const baseWhere = baseClauses.length ? `WHERE ${baseClauses.join(' AND ')}` : '';

    const sumRows = await prisma.$queryRawUnsafe<any[]>(
      `SELECT LOWER(p.status) AS status, COUNT(*) AS c, COALESCE(SUM(p.net_salary), 0) AS total
       FROM payroll p
       JOIN employees e ON p.employee_id = e.id
       LEFT JOIN users u ON e.user_id = u.id
       ${baseWhere}
       GROUP BY LOWER(p.status);`,
      ...baseArgs,
    );
    let paidCount = 0, pendingCount = 0, totalPaid = 0, totalPending = 0;
    for (const r of sumRows) {
      if (r.status === 'paid') { paidCount = Number(r.c || 0); totalPaid = Number(r.total || 0); }
      else if (r.status === 'pending') { pendingCount = Number(r.c || 0); totalPending = Number(r.total || 0); }
    }
    const summary = { paidCount, pendingCount, totalPaid, totalPending, total: paidCount + pendingCount };

    // 6-month net-salary trend (by created_at), in ₹ lakh.
    const trendRows = await prisma.$queryRawUnsafe<any[]>(
      `SELECT DATE_TRUNC('month', created_at) AS bucket,
              TO_CHAR(DATE_TRUNC('month', created_at), 'Mon') AS month,
              COALESCE(SUM(net_salary), 0) AS total
       FROM payroll
       WHERE created_at >= DATE_TRUNC('month', CURRENT_DATE) - INTERVAL '5 months'
       GROUP BY bucket
       ORDER BY bucket ASC;`,
    );
    const trend = trendRows.map((t) => ({
      month: String(t.month),
      amount: Math.round((Number(t.total || 0) / 100000) * 100) / 100,
    }));

    const args = [...baseArgs];
    const p = (v: any) => { args.push(v); return `$${args.length}`; };
    const clauses = [...baseClauses];
    if (isSet(statusF)) clauses.push(`LOWER(p.status) = LOWER(${p(statusF)})`);
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = await prisma.$queryRawUnsafe<any[]>(
      `SELECT p.id, u.name, e.employee_code, e.designation, p.month, p.basic_salary,
              p.bonus, p.deduction, p.net_salary, p.status, p.created_at
       FROM payroll p
       JOIN employees e ON p.employee_id = e.id
       LEFT JOIN users u ON e.user_id = u.id
       ${where}
       ORDER BY p.created_at DESC
       LIMIT ${LIST_LIMIT};`,
      ...args,
    );
    const records = rows.map((r) => ({
      id: Number(r.id),
      name: r.name || 'Employee',
      employeeCode: r.employee_code,
      designation: r.designation || '—',
      month: r.month,
      basicSalary: r.basic_salary != null ? Number(r.basic_salary) : 0,
      bonus: r.bonus != null ? Number(r.bonus) : 0,
      deduction: r.deduction != null ? Number(r.deduction) : 0,
      netSalary: r.net_salary != null ? Number(r.net_salary) : 0,
      status: r.status,
    }));

    return res.status(200).json({ success: true, data: { summary, trend, records } });
  } catch (error) {
    console.error('Error fetching master HR payroll:', error);
    return res.status(500).json({ error: 'Failed to fetch HR payroll' });
  }
};

/** GET /master-dashboard/hr/performance?department&q */
export const getMasterHRPerformance = async (req: Request, res: Response) => {
  if (!requireSuperAdmin(req, res)) return;
  try {
    const department = strParam(req.query.department);
    const q = strParam(req.query.q);

    const args: any[] = [];
    const p = (v: any) => { args.push(v); return `$${args.length}`; };
    const clauses: string[] = [];
    if (isSet(department)) clauses.push(`e.department = ${p(department)}`);
    if (q) clauses.push(`(u.name ILIKE ${p(`%${q}%`)} OR e.department ILIKE ${p(`%${q}%`)})`);
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

    const rows = await prisma.$queryRawUnsafe<any[]>(
      `SELECT pa.id, u.name, e.employee_code, e.department, e.designation,
              pc.title AS cycle_title, pa.status, pa.final_rating
       FROM performance_appraisals pa
       JOIN employees e ON pa.employee_id = e.id
       LEFT JOIN users u ON e.user_id = u.id
       LEFT JOIN performance_cycles pc ON pa.cycle_id = pc.id
       ${where}
       ORDER BY pa.final_rating DESC NULLS LAST, pa.id DESC
       LIMIT ${LIST_LIMIT};`,
      ...args,
    );
    const records = rows.map((r) => ({
      id: Number(r.id),
      name: r.name || 'Employee',
      employeeCode: r.employee_code,
      department: r.department || '—',
      designation: r.designation || '—',
      cycleTitle: r.cycle_title || '—',
      status: r.status,
      rating: r.final_rating != null ? Math.round(Number(r.final_rating) * 10) / 10 : 0,
    }));

    // Stats + top performers (per-employee avg rating) + department averages —
    // computed org-wide from all rated appraisals (independent of the list filter).
    const empRows = await prisma.$queryRawUnsafe<any[]>(
      `SELECT u.name, e.department,
              AVG(pa.final_rating) FILTER (WHERE pa.final_rating IS NOT NULL AND pa.final_rating > 0) AS rating
       FROM employees e
       LEFT JOIN users u ON e.user_id = u.id
       JOIN performance_appraisals pa ON pa.employee_id = e.id
       GROUP BY e.id, u.name, e.department
       HAVING AVG(pa.final_rating) FILTER (WHERE pa.final_rating IS NOT NULL AND pa.final_rating > 0) IS NOT NULL
       ORDER BY rating DESC;`,
    );
    const rated = empRows.map((r) => ({ name: r.name || 'Employee', department: r.department || '—', rating: Math.round(Number(r.rating) * 10) / 10 }));
    const topPerformers = rated.slice(0, 5);
    const deptAgg: Record<string, { sum: number; n: number }> = {};
    for (const r of rated) {
      const d = r.department;
      if (!deptAgg[d]) deptAgg[d] = { sum: 0, n: 0 };
      deptAgg[d].sum += r.rating; deptAgg[d].n += 1;
    }
    const deptPerformance = Object.entries(deptAgg)
      .map(([department, v]) => ({ department, avgRating: Math.round((v.sum / v.n) * 10) / 10 }))
      .sort((a, b) => b.avgRating - a.avgRating);

    const statusRows = await prisma.$queryRawUnsafe<any[]>(
      `SELECT LOWER(status) AS status, COUNT(*) AS c FROM performance_appraisals GROUP BY LOWER(status);`,
    );
    let completed = 0, totalAppraisals = 0;
    for (const r of statusRows) {
      const c = Number(r.c || 0);
      totalAppraisals += c;
      if (String(r.status).includes('complete') || String(r.status).includes('approved')) completed += c;
    }
    const avgRating = rated.length ? Math.round((rated.reduce((s, r) => s + r.rating, 0) / rated.length) * 10) / 10 : 0;
    const stats = { avgRating, totalAppraisals, completed, pending: Math.max(0, totalAppraisals - completed), ratedEmployees: rated.length };

    return res.status(200).json({ success: true, data: { stats, topPerformers, deptPerformance, records } });
  } catch (error) {
    console.error('Error fetching master HR performance:', error);
    return res.status(500).json({ error: 'Failed to fetch HR performance' });
  }
};

/* ════════════════════════════ MEETINGS ════════════════════════════════════ */

/**
 * Live, clock-derived meeting status (mirrors the dev meeting controller's
 * deriveStatus) so the Founder list shows accurate UPCOMING/ONGOING/COMPLETED/
 * CANCELLED badges + a working status filter, regardless of the raw stored status.
 */
function deriveMeetingStatus(
  m: { status: string; meetingDate: Date | null; startTime: string | null; endTime: string | null },
  now: Date,
): 'UPCOMING' | 'ONGOING' | 'COMPLETED' | 'CANCELLED' {
  if (m.status === 'CANCELLED') return 'CANCELLED';
  if (!m.meetingDate) return m.status === 'COMPLETED' ? 'COMPLETED' : 'UPCOMING';
  const dateStr = new Date(m.meetingDate).toISOString().split('T')[0];
  const start = new Date(`${dateStr}T${(m.startTime || '00:00')}:00`);
  if (isNaN(start.getTime())) return m.status === 'COMPLETED' ? 'COMPLETED' : 'UPCOMING';
  const end = m.endTime ? new Date(`${dateStr}T${m.endTime}:00`) : null;
  if (now < start) return 'UPCOMING';
  if (end && now > end) return 'COMPLETED';
  return 'ONGOING';
}

export const getMasterMeetings = async (req: Request, res: Response) => {
  if (!requireSuperAdmin(req, res)) return;
  try {
    const now = new Date();

    const [total, scheduled, completed, cancelled, ongoing] = await Promise.all([
      prisma.meeting.count(),
      prisma.meeting.count({ where: { status: 'SCHEDULED' } }),
      prisma.meeting.count({ where: { status: 'COMPLETED' } }),
      prisma.meeting.count({ where: { status: 'CANCELLED' } }),
      prisma.meeting.count({ where: { status: 'ONGOING' } }),
    ]);

    const [rows, upcomingRows, recentRows, meetingListRows] = await Promise.all([
      prisma.meeting.findMany({
        select: { status: true, meetingType: true, meetingDate: true },
      }),
      prisma.meeting.findMany({
        where: { status: 'SCHEDULED', meetingDate: { gte: now } },
        orderBy: { meetingDate: 'asc' },
        take: 12,
        select: {
          id: true,
          title: true,
          module: true,
          meetingType: true,
          status: true,
          meetingDate: true,
          startTime: true,
          endTime: true,
          meetingLink: true,
          project: { select: { id: true, name: true } },
          organizer: { select: { id: true, name: true } },
        },
      }),
      // Recent meeting activity — derived from the most recently updated
      // meetings (activity_logs has no meeting FK), described by current status.
      prisma.meeting.findMany({
        orderBy: { updatedAt: 'desc' },
        take: 15,
        select: { id: true, title: true, status: true, updatedAt: true, organizer: { select: { name: true } } },
      }),
      // FULL meeting list — EVERY meeting across EVERY module (Development +
      // Sales + future) so the Founder has complete, unfiltered visibility.
      // Carries the stored Google Meet link, module, and linkage context per row.
      prisma.meeting.findMany({
        orderBy: { meetingDate: 'desc' },
        take: 500,
        select: {
          id: true,
          title: true,
          module: true,
          meetingType: true,
          status: true,
          meetingDate: true,
          startTime: true,
          endTime: true,
          meetingLink: true,
          description: true,
          attendees: true,
          createdAt: true,
          updatedAt: true,
          project: { select: { id: true, name: true } },
          organizer: { select: { id: true, name: true } },
          lead: { select: { title: true } },
          deal: { select: { title: true } },
          customer: { select: { name: true } },
          team: { select: { name: true } },
        },
      }),
    ]);

    // Resolve attendee user ids → names for the full list in ONE batched query
    // (no N+1), so the Founder detail drawer can show participant names.
    const attendeeIds = new Set<number>();
    for (const m of meetingListRows) for (const id of ((m.attendees as number[]) || [])) attendeeIds.add(id);
    const attendeeUsers = attendeeIds.size
      ? await prisma.users.findMany({ where: { id: { in: [...attendeeIds] } }, select: { id: true, name: true } })
      : [];
    const userNameById = new Map(attendeeUsers.map((u) => [u.id, u.name]));

    // Upcoming counts genuinely future-dated (status SCHEDULED in the past are stale).
    const upcoming = rows.filter(
      (m) => m.status === 'SCHEDULED' && m.meetingDate && m.meetingDate >= now,
    ).length;

    // Monthly trend over the last 6 months by meeting date.
    const buckets = monthBuckets(6, now);
    const trendMap = new Map(buckets.map((b) => [b.key, { label: b.label, value: 0 }]));
    for (const m of rows) {
      if (!m.meetingDate) continue;
      const bucket = trendMap.get(monthKeyOf(m.meetingDate));
      if (bucket) bucket.value += 1;
    }

    const typeDist = distribution(
      rows.map((m) => ({ meetingType: String(m.meetingType) })),
      'meetingType',
    ).map((d) => ({ ...d, label: d.label.replace(/_/g, ' ') }));

    const verb = (status: string) =>
      status === 'COMPLETED' ? 'completed the meeting'
        : status === 'CANCELLED' ? 'cancelled the meeting'
        : status === 'ONGOING' ? 'started the meeting'
        : 'scheduled the meeting';

    return res.status(200).json({
      success: true,
      data: {
        stats: { total, upcoming, scheduled, completed, cancelled, ongoing },
        charts: {
          statusDistribution: [
            { label: 'Scheduled', value: scheduled },
            { label: 'Completed', value: completed },
            { label: 'Cancelled', value: cancelled },
            { label: 'Ongoing', value: ongoing },
          ].filter((d) => d.value > 0),
          typeDistribution: typeDist,
          trend: [...trendMap.values()],
        },
        upcoming: upcomingRows.map((m) => ({
          id: m.id,
          title: m.title,
          module: m.module || 'development',
          meetingType: String(m.meetingType).replace(/_/g, ' '),
          status: m.status,
          meetingDate: m.meetingDate,
          startTime: m.startTime,
          endTime: m.endTime,
          meetingLink: m.meetingLink,
          project: m.project ? { id: m.project.id, name: m.project.name } : null,
          organizer: m.organizer ? { id: m.organizer.id, name: m.organizer.name } : null,
          context: m.project ? m.project.name : null,
        })),
        // Every meeting, every module — the Founder's complete list. Raw enum
        // meetingType (so the client's type labels/colours/filter match) + a
        // clock-derived status + the stored Google Meet link.
        meetings: meetingListRows.map((m) => ({
          id: m.id,
          title: m.title,
          module: m.module || 'development',
          meetingType: String(m.meetingType),
          status: deriveMeetingStatus(m, now),
          meetingDate: m.meetingDate,
          startTime: m.startTime,
          endTime: m.endTime,
          meetingLink: m.meetingLink,
          description: m.description ?? null,
          project: m.project ? { id: m.project.id, name: m.project.name } : null,
          organizer: m.organizer ? { id: m.organizer.id, name: m.organizer.name } : null,
          participants: ((m.attendees as number[]) || []).map((id) => ({ id, name: userNameById.get(id) || 'Unknown' })),
          context: m.project?.name || m.deal?.title || m.lead?.title || m.customer?.name || m.team?.name || null,
          createdAt: m.createdAt,
          updatedAt: m.updatedAt,
        })),
        activities: recentRows.map((m) => ({
          id: m.id,
          actor: m.organizer?.name || 'System',
          type: 'meeting',
          description: `${verb(String(m.status))} "${m.title}"`,
          created_at: m.updatedAt,
        })),
      },
    });
  } catch (error) {
    console.error('Error fetching master meetings:', error);
    return res.status(500).json({ error: 'Failed to fetch organization meetings' });
  }
};

/* ════════════════════════════ AUDIT / SYSTEM ══════════════════════════════ */

export const getMasterAudit = async (req: Request, res: Response) => {
  if (!requireSuperAdmin(req, res)) return;
  try {
    const [totalUsers, activeUsers, totalRoles, totalProjects, activities] = await Promise.all([
      prisma.users.count(),
      prisma.users.count({ where: { status: { equals: 'active', mode: 'insensitive' } } }),
      prisma.roles.count(),
      prisma.projects.count(),
      prisma.activity_logs.findMany({
        orderBy: { created_at: 'desc' },
        take: 50,
        include: {
          actor: { select: { name: true, email: true } },
          target: { select: { name: true } },
          project: { select: { name: true } },
        },
      }),
    ]);

    return res.status(200).json({
      success: true,
      data: {
        stats: {
          totalUsers,
          activeUsers,
          inactiveUsers: totalUsers - activeUsers,
          totalRoles,
          totalProjects,
        },
        activities: activities.map((a) => ({
          id: a.id,
          actor: a.actor?.name || 'System',
          actorEmail: a.actor?.email || null,
          target: a.target?.name || null,
          project: a.project?.name || null,
          type: a.type,
          description: a.description,
          created_at: a.created_at,
        })),
      },
    });
  } catch (error) {
    console.error('Error fetching master audit feed:', error);
    return res.status(500).json({ error: 'Failed to fetch organization audit feed' });
  }
};
