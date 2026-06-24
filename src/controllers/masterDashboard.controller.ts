import { Request, Response } from 'express';
import prisma from '../config/db.js';
import { isGlobalAdmin } from '../utils/roles.js';

/**
 * Master Dashboard analytics — the Founder / SuperAdmin executive overview.
 *
 * Every figure here is ORGANIZATION-WIDE: counts and aggregates span the entire
 * ERP and are never scoped to a single project, board, sprint, owner, or the
 * logged-in user. All numbers come from live database aggregation queries
 * (counts / sums / groupBy) — no mock, demo, or hardcoded values. Empty
 * datasets resolve to 0 (or []), never to fabricated figures.
 *
 * Terminology note: in this ERP "Tickets" are Blockers (sidebar Tickets →
 * /dashboard/blockers) and "Bugs" are the bug tracker — they are distinct
 * entities and are reported separately below.
 */

// Lowercased status sets used for case-insensitive matching against free-text
// status columns (projects/blockers/bugs store status as VarChar).
const PROJECT_ACTIVE = ['active', 'in_progress', 'in-progress', 'ongoing'];
const PROJECT_COMPLETED = ['completed', 'complete', 'done', 'closed'];
const PROJECT_ONHOLD = ['on-hold', 'on_hold', 'onhold', 'paused', 'hold'];
const PROJECT_CANCELLED = ['cancelled', 'canceled'];
const PROJECT_PLANNING = ['planning', 'planned', 'new', 'draft', 'not started', 'not_started', 'todo', 'backlog'];

const TICKET_RESOLVED = ['resolved', 'closed', 'done', 'completed'];
const CRITICAL_LEVELS = ['critical', 'urgent', 'high'];

const BUG_OPEN = ['open', 'new', 'in_progress', 'in-progress', 'reopened'];
const BUG_RESOLVED = ['resolved', 'closed', 'done', 'fixed'];

/**
 * Build a sorted [{ label, value }] frequency distribution from a list of rows.
 *
 * We deliberately group in JS over a lightweight single-column `findMany` select
 * rather than using Prisma's `groupBy`: `groupBy`'s generic return types are so
 * expensive to type-check that a handful of them OOMs the TypeScript compiler in
 * this project. Single-column selects keep both the query and the types cheap.
 */
function distribution(
  rows: Array<Record<string, any>>,
  key: string,
  fallbackLabel = 'Unknown',
): Array<{ label: string; value: number }> {
  const counts = new Map<string, number>();
  for (const r of rows) {
    const raw = r[key];
    const label = (raw === null || raw === undefined || raw === '' ? fallbackLabel : String(raw));
    counts.set(label, (counts.get(label) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([label, value]) => ({ label, value }))
    .filter((d) => d.value > 0)
    .sort((a, b) => b.value - a.value);
}

export const getMasterDashboardAnalytics = async (req: Request, res: Response) => {
  try {
    const userRole = (req as any).userRole;

    // SuperAdmin/Admin-only surface. The route is already behind `authenticate`;
    // this is defence-in-depth at the API layer. isGlobalAdmin normalizes every
    // spelling of the role (case, spaces, underscores, hyphens).
    if (!isGlobalAdmin(userRole)) {
      return res.status(403).json({ error: 'Forbidden. SuperAdmin access required.' });
    }

    const now = new Date();
    const today = now.toISOString().split('T')[0]; // YYYY-MM-DD for VarChar date columns

    // The "not done" guard reused for overdue-task detection.
    const TASK_NOT_DONE = {
      NOT: {
        OR: [
          { status: { equals: 'done', mode: 'insensitive' as const } },
          { status: { equals: 'completed', mode: 'insensitive' as const } },
          { status: { equals: 'closed', mode: 'insensitive' as const } },
          { status: { equals: 'resolved', mode: 'insensitive' as const } },
        ],
      },
    };

    // Two parallel waves. Counts/aggregates are grouped together (cheap, simple
    // return types); the heavier groupBy/findMany queries are isolated in a
    // second batch. This split keeps each Promise.all tuple small — Prisma's
    // groupBy generics are expensive to type-check and OOM the compiler when
    // dozens of heterogeneous queries are unified into one giant tuple.

    // ── Wave 1 — scalar counts & aggregates ──────────────────────────────────
    const [
      totalProjects,
      activeProjects,
      completedProjects,
      onHoldProjects,
      archivedProjects,
      delayedProjects,
      totalTickets,
      openTickets,
      criticalTickets,
      resolvedTickets,
      escalatedTickets,
      totalBugs,
      openBugs,
      criticalBugs,
      resolvedBugs,
      totalLeads,
      convertedLeads,
      totalOpportunities,
      totalDeals,
      wonAgg,
      openAgg,
      lostDeals,
      totalMeetings,
      upcomingMeetings,
      completedMeetings,
      cancelledMeetings,
      totalUsers,
      overdueTasks,
    ] = await Promise.all([
      // Projects
      prisma.projects.count(),
      prisma.projects.count({ where: { status: { in: PROJECT_ACTIVE, mode: 'insensitive' } } }),
      prisma.projects.count({ where: { status: { in: PROJECT_COMPLETED, mode: 'insensitive' } } }),
      prisma.projects.count({ where: { status: { in: PROJECT_ONHOLD, mode: 'insensitive' } } }),
      prisma.projects.count({ where: { is_archived: true } }),
      prisma.projects.count({
        where: {
          status: { notIn: PROJECT_COMPLETED, mode: 'insensitive' },
          endDate: { lt: today, not: null },
        },
      }),
      // Tickets / Blockers
      prisma.blocker.count(),
      prisma.blocker.count({ where: { status: { notIn: TICKET_RESOLVED, mode: 'insensitive' } } }),
      prisma.blocker.count({
        where: {
          status: { notIn: TICKET_RESOLVED, mode: 'insensitive' },
          severity: { in: CRITICAL_LEVELS, mode: 'insensitive' },
        },
      }),
      prisma.blocker.count({ where: { status: { in: TICKET_RESOLVED, mode: 'insensitive' } } }),
      prisma.blocker.count({
        where: {
          status: { notIn: TICKET_RESOLVED, mode: 'insensitive' },
          escalationLevel: { notIn: ['none', 'None', ''], mode: 'insensitive' },
        },
      }),
      // Bugs
      prisma.bugs.count(),
      prisma.bugs.count({ where: { status: { in: BUG_OPEN, mode: 'insensitive' } } }),
      prisma.bugs.count({
        where: {
          status: { in: BUG_OPEN, mode: 'insensitive' },
          priority: { in: CRITICAL_LEVELS, mode: 'insensitive' },
        },
      }),
      prisma.bugs.count({ where: { status: { in: BUG_RESOLVED, mode: 'insensitive' } } }),
      // Sales
      prisma.lead.count(),
      prisma.deal.count({ where: { leadId: { not: null } } }), // leads that became deals
      prisma.opportunity.count(),
      prisma.deal.count(),
      prisma.deal.aggregate({ _sum: { amount: true }, _count: { _all: true }, where: { status: 'won' } }),
      prisma.deal.aggregate({ _sum: { amount: true }, where: { status: 'open' } }),
      prisma.deal.count({ where: { status: 'lost' } }),
      // Meetings
      prisma.meeting.count(),
      prisma.meeting.count({ where: { status: 'SCHEDULED' } }),
      prisma.meeting.count({ where: { status: 'COMPLETED' } }),
      prisma.meeting.count({ where: { status: 'CANCELLED' } }),
      // People & tasks
      prisma.users.count(),
      prisma.kanban_tasks.count({ where: { dueDate: { lt: today }, ...TASK_NOT_DONE } }),
    ]);

    // ── Wave 2 — distributions & feeds via lightweight single-column selects ──
    // Each select pulls only the column(s) we group on, so the row payloads and
    // the inferred types both stay small. Grouping happens in JS (see
    // `distribution`).
    const [
      projectStatusRows,
      ticketRows,
      bugPriorityRows,
      dealRows,
      leadSourceRows,
      recentActivities,
      boardEndRows,
    ] = await Promise.all([
      // id + is_archived (beyond status) feed the derived project-status counts;
      // category feeds the Projects-by-Category chart.
      prisma.projects.findMany({ select: { id: true, status: true, is_archived: true, category: true } }),
      prisma.blocker.findMany({ select: { status: true, severity: true } }),
      prisma.bugs.findMany({ select: { priority: true } }),
      prisma.deal.findMany({ select: { stage: true, amount: true, status: true, closedAt: true, updatedAt: true } }),
      prisma.lead.findMany({ select: { source: true } }),
      prisma.activity_logs.findMany({
        orderBy: { created_at: 'desc' },
        take: 15,
        include: {
          actor: { select: { name: true, email: true } },
          project: { select: { name: true } },
          task: { select: { title: true } },
          deal: { select: { title: true } },
        },
      }),
      // Sprint (kanban board) end dates → each project's live Due Date.
      prisma.kanban_boards.findMany({ select: { projectId: true, endDate: true } }),
    ]);

    // Org-wide derived project-status counts (sprint-due-date based) so the
    // Department Summary "Projects" card matches the Projects-module badges.
    // Mutually exclusive: archived/completed/cancelled are excluded; then on-hold,
    // then schedule (delayed < today, at-risk ≤ 7 days), then planning, else
    // on-track. Day math is UTC to match the Projects page exactly.
    const sprintEndByProject = new Map<string, Date>();
    for (const b of boardEndRows) {
      if (!b.projectId || !b.endDate) continue;
      const prev = sprintEndByProject.get(b.projectId);
      if (!prev || b.endDate.getTime() > prev.getTime()) sprintEndByProject.set(b.projectId, b.endDate);
    }
    const todayUTC = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    const daysToEnd = (end: Date) =>
      Math.round((Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate()) - todayUTC) / 86400000);

    let onTrackProjects = 0, atRiskProjects = 0, delayedDerived = 0;
    for (const p of projectStatusRows) {
      const s = (p.status || '').toLowerCase();
      if (p.is_archived) continue;
      if (PROJECT_COMPLETED.includes(s)) continue;
      if (PROJECT_CANCELLED.includes(s)) continue;
      if (PROJECT_ONHOLD.includes(s)) continue;
      const end = sprintEndByProject.get(p.id);
      if (end) {
        const d = daysToEnd(end);
        if (d < 0) { delayedDerived++; continue; }
        if (d <= 7) { atRiskProjects++; continue; }
      }
      if (PROJECT_PLANNING.includes(s)) continue;
      onTrackProjects++;
    }

    // ── Derive scalar metrics (null-safe → 0) ────────────────────────────────
    const revenue = wonAgg._sum.amount || 0;
    const pipelineValue = openAgg._sum.amount || 0;
    const wonDeals = wonAgg._count._all;
    const conversionRate = totalLeads > 0 ? Math.round((convertedLeads / totalLeads) * 100) : 0;

    // ── Revenue trend — bucket won-deal value into the last 6 months ─────────
    const trend: Array<{ key: string; label: string; revenue: number }> = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      trend.push({
        key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`,
        label: d.toLocaleString('en-US', { month: 'short' }),
        revenue: 0,
      });
    }
    const trendMap = new Map(trend.map((t) => [t.key, t]));
    for (const deal of dealRows) {
      if (deal.status !== 'won') continue;
      const dt = deal.closedAt || deal.updatedAt;
      if (!dt) continue;
      const key = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`;
      const bucket = trendMap.get(key);
      if (bucket) bucket.revenue += deal.amount || 0;
    }

    // Deal-stage distribution (count + value per stage) computed from dealRows.
    const stageMap = new Map<string, { value: number; amount: number }>();
    for (const deal of dealRows) {
      const label = deal.stage ?? 'Unknown';
      const cur = stageMap.get(label) || { value: 0, amount: 0 };
      cur.value += 1;
      cur.amount += deal.amount || 0;
      stageMap.set(label, cur);
    }
    const dealStage = [...stageMap.entries()]
      .map(([label, v]) => ({ label, value: v.value, amount: v.amount }))
      .filter((d) => d.value > 0)
      .sort((a, b) => b.value - a.value);

    // ── Alert Center — org-wide, only surfaced when the count is non-zero ─────
    const alerts: Array<{ id: string; title: string; desc: string; type: string; time: string }> = [];
    if (criticalTickets > 0)
      alerts.push({
        id: 'alert-critical-tickets',
        title: 'Critical Tickets',
        desc: `${criticalTickets} critical/high-severity ticket(s) are open across projects.`,
        type: 'critical',
        time: 'Now',
      });
    if (escalatedTickets > 0)
      alerts.push({
        id: 'alert-escalated-tickets',
        title: 'Escalated Blockers',
        desc: `${escalatedTickets} ticket(s) have been escalated and need attention.`,
        type: 'critical',
        time: 'Now',
      });
    if (criticalBugs > 0)
      alerts.push({
        id: 'alert-critical-bugs',
        title: 'Escalated Bugs',
        desc: `${criticalBugs} critical bug(s) are open across all projects.`,
        type: 'critical',
        time: 'Now',
      });
    if (overdueTasks > 0)
      alerts.push({
        id: 'alert-overdue-tasks',
        title: 'Overdue Tasks',
        desc: `${overdueTasks} task(s) have passed their due date.`,
        type: 'warning',
        time: 'Now',
      });
    if (delayedProjects > 0)
      alerts.push({
        id: 'alert-delayed-projects',
        title: 'Delayed Projects',
        desc: `${delayedProjects} active project(s) are past their planned end date.`,
        type: 'warning',
        time: 'Now',
      });
    if (upcomingMeetings > 0)
      alerts.push({
        id: 'alert-upcoming-meetings',
        title: 'Upcoming Meetings',
        desc: `${upcomingMeetings} meeting(s) are scheduled across the organization.`,
        type: 'info',
        time: 'Now',
      });

    return res.status(200).json({
      success: true,
      data: {
        stats: {
          projects: {
            total: totalProjects,
            active: activeProjects,
            completed: completedProjects,
            onHold: onHoldProjects,
            // Sprint-derived (matches the Projects-module badges), not the raw
            // endDate count `delayedProjects` (which still drives the alert).
            delayed: delayedDerived,
            archived: archivedProjects,
            onTrack: onTrackProjects,
            atRisk: atRiskProjects,
          },
          tickets: {
            total: totalTickets,
            open: openTickets,
            critical: criticalTickets,
            escalated: escalatedTickets,
            resolved: resolvedTickets,
          },
          bugs: {
            total: totalBugs,
            open: openBugs,
            critical: criticalBugs,
            resolved: resolvedBugs,
          },
          sales: {
            totalLeads,
            convertedLeads,
            conversionRate,
            totalOpportunities,
            totalDeals,
            wonDeals,
            openDeals: totalDeals - wonDeals - lostDeals < 0 ? 0 : totalDeals - wonDeals - lostDeals,
            lostDeals,
            revenue,
            pipelineValue,
          },
          meetings: {
            total: totalMeetings,
            upcoming: upcomingMeetings,
            completed: completedMeetings,
            cancelled: cancelledMeetings,
          },
          users: { total: totalUsers },
        },
        charts: {
          projectStatus: distribution(projectStatusRows, 'status'),
          projectCategory: distribution(projectStatusRows, 'category', 'Uncategorized'),
          ticketStatus: distribution(ticketRows, 'status'),
          ticketSeverity: distribution(ticketRows, 'severity'),
          bugPriority: distribution(bugPriorityRows, 'priority'),
          dealStage,
          leadSource: distribution(leadSourceRows, 'source'),
          meetingStatus: [
            { label: 'Scheduled', value: upcomingMeetings },
            { label: 'Completed', value: completedMeetings },
            { label: 'Cancelled', value: cancelledMeetings },
          ].filter((d) => d.value > 0),
          revenueTrend: trend.map((t) => ({ label: t.label, revenue: t.revenue })),
        },
        activities: recentActivities.map((act) => ({
          id: act.id,
          actor: act.actor?.name || 'System',
          type: act.type,
          description: act.description,
          created_at: act.created_at,
        })),
        alerts,
      },
    });
  } catch (error) {
    console.error('Error fetching master dashboard analytics:', error);
    return res.status(500).json({ error: 'Failed to fetch master dashboard analytics' });
  }
};
