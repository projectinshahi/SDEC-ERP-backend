import { Request, Response } from 'express';
import prisma from '../config/db.js';

/**
 * Global Task Dashboard aggregation for the standalone My Tasks module.
 *
 * This is the FIRST org-wide aggregation over my_tasks (the existing
 * /my-tasks/workspace is hard-scoped to the caller). It is gated by the
 * `mytasks.dashboard.view` permission at the route layer.
 *
 * Deliberate design notes:
 *  - NO prisma groupBy: this backend OOMs the TS compiler on groupBy, so we use
 *    findMany(select) + JS grouping — the same pattern as masterDashboardModules.
 *  - my_tasks has NO completion timestamp, so "completed at" is reconstructed from
 *    my_task_activities ("Changed Status from X → Done/Approved"), mirroring how
 *    getDeveloperPerformance reconstructs trends from activity_logs. Tasks completed
 *    before that log existed simply have no duration (avgCompletionHours = null).
 *  - Department lives ONLY on employees.department, joined via employees.user_id
 *    (nullable) — users with no employee row fall into the 'Unassigned' bucket.
 *    Departments are derived from data, never hardcoded.
 */

const COMPLETED_STATUSES = ['done', 'approved'];
const STATUS_LABELS: Record<string, string> = {
  todo: 'To Do', in_progress: 'In Progress', waiting: 'Waiting', done: 'Done', approved: 'Approved',
};
const UNASSIGNED_DEPT = 'Unassigned';

const pad = (n: number) => String(n).padStart(2, '0');

/** due_date is a DATE stored at UTC midnight → 'YYYY-MM-DD' via its UTC parts. */
function ymdOfDate(d: Date | null | undefined): string | null {
  if (!d) return null;
  const dt = d instanceof Date ? d : new Date(d);
  if (isNaN(dt.getTime())) return null;
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}
function todayYmd(): string {
  const n = new Date();
  return `${n.getFullYear()}-${pad(n.getMonth() + 1)}-${pad(n.getDate())}`;
}
const dayKeyOf = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** Last `n` calendar days as {key,label} buckets (mirrors masterDashboardModules). */
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

/** {label,value}[] frequency count — same shape the MasterKit charts consume. */
function distribution(rows: Array<Record<string, any>>, key: string): Array<{ label: string; value: number }> {
  const counts = new Map<string, number>();
  for (const r of rows) {
    const raw = r[key];
    const label = raw === null || raw === undefined || raw === '' ? 'Unknown' : String(raw);
    counts.set(label, (counts.get(label) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([label, value]) => ({ label, value }))
    .filter((d) => d.value > 0)
    .sort((a, b) => b.value - a.value);
}

/** GET /my-tasks/dashboard — aggregates only (gated by mytasks.dashboard.view). */
export const getMyTaskDashboard = (req: Request, res: Response) => buildMyTaskDashboard(req, res, false);

/**
 * GET /my-tasks/dashboard/report — the EXACT same aggregation PLUS the detailed
 * task list. Split only so it can carry its own `mytasks.dashboard.export` gate;
 * it shares this implementation rather than duplicating any query or calculation.
 * (An explicit flag, NOT a mutated req.query — Express exposes `query` via a
 * getter, so mutating it is not reliably observed downstream.)
 */
export const getMyTaskDashboardReport = (req: Request, res: Response) => buildMyTaskDashboard(req, res, true);

async function buildMyTaskDashboard(req: Request, res: Response, includeTasks: boolean) {
  try {
    const { employeeId, department, projectId, startDate, endDate, status, priority, inChargeId } = req.query;

    // ── Filters pushed into SQL where possible ──────────────────────────────
    const where: any = {};
    if (projectId) where.project_id = String(projectId);
    if (status) where.status = String(status);
    if (priority) where.priority = String(priority);
    if (inChargeId && !Number.isNaN(Number(inChargeId))) where.in_charge_id = Number(inChargeId);
    if (employeeId && !Number.isNaN(Number(employeeId))) {
      where.members = { some: { user_id: Number(employeeId) } };
    }
    // Date range applies to when the task entered the system (created_at).
    if (startDate || endDate) {
      where.created_at = {};
      if (startDate) where.created_at.gte = new Date(`${String(startDate)}T00:00:00.000Z`);
      if (endDate) where.created_at.lte = new Date(`${String(endDate)}T23:59:59.999Z`);
    }

    const [tasks, users, employees, projects] = await Promise.all([
      prisma.my_tasks.findMany({
        where,
        select: {
          id: true, title: true, status: true, priority: true, due_date: true, due_time: true,
          created_at: true, created_by: true, in_charge_id: true, project_id: true, waiting_reason: true,
          members: { select: { user_id: true } },
        },
        orderBy: { created_at: 'desc' },
      }),
      prisma.users.findMany({ select: { id: true, name: true, email: true } }),
      prisma.employees.findMany({ select: { user_id: true, department: true, designation: true } }),
      prisma.projects.findMany({ select: { id: true, name: true }, orderBy: { name: 'asc' } }),
    ]);

    // user → department / designation (employees.user_id is nullable + @unique)
    const deptOf = new Map<number, string>();
    const desigOf = new Map<number, string>();
    for (const e of employees) {
      if (e.user_id != null) {
        deptOf.set(e.user_id, e.department || UNASSIGNED_DEPT);
        if (e.designation) desigOf.set(e.user_id, e.designation);
      }
    }

    // Department is not a task column — filter in JS over the member→dept mapping.
    const scoped = department
      ? tasks.filter((t) => t.members.some((m) => (deptOf.get(m.user_id) ?? UNASSIGNED_DEPT) === String(department)))
      : tasks;

    // ── Summary cards ───────────────────────────────────────────────────────
    const today = todayYmd();
    const isCompleted = (s: string) => COMPLETED_STATUSES.includes(s);
    // 'waiting' is never delayed (dependency outside the assignee's control) —
    // mirrors the standardized status workflow rule used in the workspace UI.
    const isDelayed = (t: { due_date: Date | null; status: string }) => {
      const d = ymdOfDate(t.due_date);
      return !!d && d < today && !isCompleted(t.status) && t.status !== 'waiting';
    };
    const isDueToday = (t: { due_date: Date | null; status: string }) =>
      ymdOfDate(t.due_date) === today && !isCompleted(t.status);
    const countStatus = (s: string) => scoped.filter((t) => t.status === s).length;

    const summary = {
      total: scoped.length,
      active: scoped.filter((t) => !isCompleted(t.status)).length,
      todo: countStatus('todo'),
      inProgress: countStatus('in_progress'),
      waiting: countStatus('waiting'),
      done: countStatus('done'),
      approved: countStatus('approved'),
      delayed: scoped.filter(isDelayed).length,
      dueToday: scoped.filter(isDueToday).length,
    };

    // ── Completion reconstruction from the activity timeline ─────────────────
    const taskIds = scoped.map((t) => t.id);
    const acts = taskIds.length
      ? await prisma.my_task_activities.findMany({
        where: { task_id: { in: taskIds }, action: { contains: '→' } },
        select: { task_id: true, action: true, created_at: true, user_id: true },
        orderBy: { created_at: 'asc' },
      })
      : [];
    // First transition INTO done/approved wins. Tolerates both the humanized
    // labels ("→ Done") and the older raw values ("→ done"/"→ approved").
    const completedAt = new Map<number, Date>();
    const completedBy = new Map<number, number>();
    for (const a of acts) {
      const lower = String(a.action).toLowerCase();
      if ((lower.includes('→ done') || lower.includes('→ approved')) && !completedAt.has(a.task_id)) {
        completedAt.set(a.task_id, a.created_at);
        completedBy.set(a.task_id, a.user_id);
      }
    }

    // ── Charts ──────────────────────────────────────────────────────────────
    const statusDistribution = distribution(
      scoped.map((t) => ({ s: STATUS_LABELS[t.status] || t.status })), 's',
    );
    const priorityDistribution = distribution(
      scoped.map((t) => ({ p: t.priority || 'medium' })), 'p',
    );

    const buckets = dayBuckets(30, new Date());
    const createdByDay = new Map<string, number>();
    for (const t of scoped) {
      const k = dayKeyOf(new Date(t.created_at));
      createdByDay.set(k, (createdByDay.get(k) || 0) + 1);
    }
    const completedByDay = new Map<string, number>();
    for (const d of completedAt.values()) {
      const k = dayKeyOf(new Date(d));
      completedByDay.set(k, (completedByDay.get(k) || 0) + 1);
    }
    const trend = buckets.map((b) => ({
      label: b.label,
      created: createdByDay.get(b.key) || 0,
      completed: completedByDay.get(b.key) || 0,
    }));

    // ── Employee performance rows (a task counts for every assigned member) ──
    const byUser = new Map<number, typeof scoped>();
    for (const t of scoped) {
      for (const m of t.members) {
        const arr = byUser.get(m.user_id);
        if (arr) arr.push(t);
        else byUser.set(m.user_id, [t]);
      }
    }
    const userById = new Map(users.map((u) => [u.id, u]));
    const employeeRows = [...byUser.entries()].map(([uid, ts]) => {
      const u = userById.get(uid);
      const total = ts.length;
      const completed = ts.filter((t) => isCompleted(t.status)).length;
      const durations: number[] = [];
      for (const t of ts) {
        const c = completedAt.get(t.id);
        if (c) durations.push((new Date(c).getTime() - new Date(t.created_at).getTime()) / 3_600_000);
      }
      return {
        userId: uid,
        name: u?.name || 'Unknown',
        email: u?.email || null,
        department: deptOf.get(uid) || UNASSIGNED_DEPT,
        designation: desigOf.get(uid) || null,
        total,
        completed,
        done: ts.filter((t) => t.status === 'done').length,
        approved: ts.filter((t) => t.status === 'approved').length,
        pending: ts.filter((t) => !isCompleted(t.status)).length,
        waiting: ts.filter((t) => t.status === 'waiting').length,
        delayed: ts.filter(isDelayed).length,
        completionPct: total ? Math.round((completed / total) * 100) : 0,
        avgCompletionHours: durations.length
          ? Math.round((durations.reduce((a, b) => a + b, 0) / durations.length) * 10) / 10
          : null,
      };
    }).sort((a, b) => b.total - a.total);

    // ── Department performance ──────────────────────────────────────────────
    // Departments are DERIVED from employees.department — never hardcoded, so a new
    // department appears automatically. A task counts once per distinct department
    // among its members (two members in one dept must not double-count that dept).
    type DeptAcc = {
      total: number; completed: number; pending: number; waiting: number;
      delayed: number; people: Set<number>;
    };
    const deptAcc = new Map<string, DeptAcc>();
    for (const t of scoped) {
      const deptsOfTask = new Set(t.members.map((m) => deptOf.get(m.user_id) ?? UNASSIGNED_DEPT));
      for (const d of deptsOfTask) {
        let row = deptAcc.get(d);
        if (!row) {
          row = { total: 0, completed: 0, pending: 0, waiting: 0, delayed: 0, people: new Set() };
          deptAcc.set(d, row);
        }
        row.total += 1;
        if (isCompleted(t.status)) row.completed += 1; else row.pending += 1;
        if (t.status === 'waiting') row.waiting += 1;
        if (isDelayed(t)) row.delayed += 1;
      }
      for (const m of t.members) {
        deptAcc.get(deptOf.get(m.user_id) ?? UNASSIGNED_DEPT)?.people.add(m.user_id);
      }
    }
    const departments = [...deptAcc.entries()]
      .map(([department, r]) => ({
        department,
        people: r.people.size,
        total: r.total,
        completed: r.completed,
        pending: r.pending,
        waiting: r.waiting,
        delayed: r.delayed,
        completionPct: r.total ? Math.round((r.completed / r.total) * 100) : 0,
      }))
      .sort((a, b) => b.total - a.total);

    // ── Executive: company progress, bottlenecks, workload, productivity ─────
    const companyProgress = {
      total: summary.total,
      completed: summary.done + summary.approved,
      completionPct: summary.total ? Math.round(((summary.done + summary.approved) / summary.total) * 100) : 0,
      approvedPct: summary.total ? Math.round((summary.approved / summary.total) * 100) : 0,
      delayedPct: summary.total ? Math.round((summary.delayed / summary.total) * 100) : 0,
      activePct: summary.total ? Math.round((summary.active / summary.total) * 100) : 0,
      people: new Set(scoped.flatMap((t) => t.members.map((m) => m.user_id))).size,
    };

    const slim = (e: typeof employeeRows[number]) => ({
      userId: e.userId, name: e.name, department: e.department,
      total: e.total, pending: e.pending, delayed: e.delayed, completionPct: e.completionPct,
    });
    const bottlenecks = {
      highestPending: [...employeeRows].filter((e) => e.pending > 0).sort((a, b) => b.pending - a.pending).slice(0, 5).map(slim),
      highestDelayed: [...employeeRows].filter((e) => e.delayed > 0).sort((a, b) => b.delayed - a.delayed).slice(0, 5).map(slim),
    };

    // Workload = OPEN work only (completed tasks are not workload).
    const workload = {
      byDepartment: departments
        .filter((d) => d.pending > 0)
        .map((d) => ({ label: d.department, value: d.pending })),
      byEmployee: [...employeeRows]
        .filter((e) => e.pending > 0)
        .sort((a, b) => b.pending - a.pending)
        .slice(0, 10)
        .map((e) => ({ label: e.name, value: e.pending })),
    };

    const taskById = new Map(scoped.map((t) => [t.id, t]));
    const nameOf = (uid: number | null | undefined) => (uid ? userById.get(uid)?.name ?? null : null);

    const recentlyCompleted = [...completedAt.entries()]
      .sort((a, b) => b[1].getTime() - a[1].getTime())
      .slice(0, 8)
      .map(([taskId, at]) => {
        const t = taskById.get(taskId);
        return {
          id: taskId,
          title: t?.title ?? 'Untitled',
          status: t?.status ?? null,
          completedAt: at.toISOString(),
          completedBy: nameOf(completedBy.get(taskId)),
        };
      });

    const upcomingDeadlines = scoped
      .filter((t) => !isCompleted(t.status))
      .map((t) => ({ t, ymd: ymdOfDate(t.due_date) }))
      .filter((x) => !!x.ymd && x.ymd! >= today)
      .sort((a, b) => (a.ymd! < b.ymd! ? -1 : a.ymd! > b.ymd! ? 1 : 0))
      .slice(0, 8)
      .map(({ t, ymd }) => ({
        id: t.id,
        title: t.title,
        dueDate: ymd,
        dueTime: t.due_time,
        status: t.status,
        priority: t.priority,
        inCharge: nameOf(t.in_charge_id),
      }));

    // "Delayed trend" = currently-overdue tasks bucketed by the DAY THEY WERE DUE
    // (my_tasks keeps no history, so this shows when the overdue work was due —
    // it is NOT a historical snapshot of the overdue count).
    const overdueByDueDay = new Map<string, number>();
    for (const t of scoped) {
      if (!isDelayed(t)) continue;
      const d = ymdOfDate(t.due_date);
      if (d) overdueByDueDay.set(d, (overdueByDueDay.get(d) || 0) + 1);
    }
    const delayedTrend = buckets.map((b) => ({ label: b.label, delayed: overdueByDueDay.get(b.key) || 0 }));

    // ── Detailed task list (opt-in; powers the PDF report's task table) ─────
    // Derived from the SAME `scoped` set the aggregates use — no second query and
    // no re-filtering, so the report can never disagree with the dashboard.
    const projectById = new Map(projects.map((p) => [p.id, p.name]));
    const detailedTasks = includeTasks
      ? scoped.map((t) => {
        const depts = [...new Set(t.members.map((m) => deptOf.get(m.user_id) ?? UNASSIGNED_DEPT))];
        return {
          id: t.id,
          title: t.title,
          status: STATUS_LABELS[t.status] || t.status,
          priority: t.priority || 'medium',
          owner: nameOf(t.created_by) || 'Unknown',
          inCharge: nameOf(t.in_charge_id),
          members: t.members.map((m) => nameOf(m.user_id)).filter(Boolean),
          dueDate: ymdOfDate(t.due_date),
          dueTime: t.due_time,
          createdAt: t.created_at.toISOString(),
          department: depts.length ? depts.join(', ') : UNASSIGNED_DEPT,
          project: t.project_id ? (projectById.get(t.project_id) ?? null) : null,
          waitingReason: t.waiting_reason ?? null,
        };
      })
      : undefined;

    // ── Filter options (derived from data, NOT filtered by the current query,
    //    so the user can always widen a selection) ─────────────────────────────
    const departmentOptions = [...new Set(employees.map((e) => e.department).filter(Boolean))].sort();
    const filterOptions = {
      employees: users
        .map((u) => ({ id: u.id, name: u.name }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      departments: departmentOptions,
      projects: projects.map((p) => ({ id: p.id, name: p.name })),
      statuses: Object.entries(STATUS_LABELS).map(([value, label]) => ({ value, label })),
    };

    return res.status(200).json({
      summary,
      statusDistribution,
      priorityDistribution,
      trend,
      delayedTrend,
      employees: employeeRows,
      departments,
      companyProgress,
      bottlenecks,
      workload,
      recentlyCompleted,
      upcomingDeadlines,
      filterOptions,
      ...(detailedTasks ? { tasks: detailedTasks } : {}),
      generatedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Error building my-task dashboard:', error);
    return res.status(500).json({ error: 'Failed to build task dashboard' });
  }
};
