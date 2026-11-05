import type { Request, Response } from 'express';
import prisma from '../config/db.js';
import { io } from '../socket.js';
import { SalesAuthContext, can, getSalesAuth } from '../utils/salesAuth.js';
import { canAccessMyTask } from '../utils/myTaskAccess.js';
import { isGlobalAdmin, isExternalUser } from '../utils/roles.js';
import {
  createMyTask, updateMyTask, updateMyTaskStatus, bumpMyTaskActivity, emitTaskEvent,
} from '../controllers/myTasks.controller.js';
import { notifyTask } from './push.service.js';
import { isYmd } from './marketingFinance.service.js';
import { todayIST } from './attendanceAnalytics.service.js';
import type { ToolSpec } from './aiProvider.service.js';
import type { ToolOutcome } from './aiAssistantTools.service.js';

/**
 * ERP AI Assistant — Phase 3: Task Management ACTION PROPOSALS (My Tasks only).
 *
 * The model can only call `preview_*` tools. A preview (1) resolves names to ids,
 * (2) checks the caller's EXISTING My Tasks permission + per-task role (the same
 * canAccessMyTask rules the REST controllers use), (3) builds a canonical payload
 * and a display-safe card, and (4) stores a PENDING proposal bound to the user.
 * Nothing changes until the signed-in user presses Confirm in the chat UI, which
 * hits POST /ai-assistant/actions/:id/confirm — never reachable by the model.
 *
 * Confirm claims the row atomically (pending → executing, single use, not expired,
 * same user), re-validates the STORED payload against fresh permissions and the
 * current task, then executes through the EXISTING My Tasks controller logic
 * (createMyTask / updateMyTask / updateMyTaskStatus) so validation, activity
 * history, sockets and push notifications stay identical to the module's own UI.
 * Member changes run in one transaction (the module has no multi-member endpoint).
 */

export type ActionType = 'create_task' | 'update_task' | 'assign_task' | 'change_task_status';
export interface ProposalCard {
  id: number;
  action: ActionType;
  label: string;
  taskId: number | null;
  title: string;
  changes: Array<{ field: string; current: string | null; proposed: string | null }>;
  notes: string[];
  expiresAt: string;
  status: 'pending';
}
/** The chat controller adds the caller's full role list (needed for the External-account rule). */
export interface ActionAuth extends SalesAuthContext { roleNames?: string[] }
type Args = Record<string, unknown>;
type Err = { error: string; message: string };
type Card = Omit<ProposalCard, 'id' | 'expiresAt' | 'status'>;
interface Validated { permission: string; targetTaskId: number | null; card: Card; summary: string }
interface ReqAuth { userId: number; userRole: string; userRoleNames: string[] }

const EXPIRY_MIN = Math.max(1, Number(process.env.AI_ACTION_EXPIRY_MINUTES) || 5);
const PRIORITIES = ['low', 'medium', 'high', 'urgent'] as const;
const STATUSES = ['todo', 'in_progress', 'waiting', 'done', 'approved'] as const;
const STATUS_LABEL: Record<string, string> = { todo: 'To Do', in_progress: 'In Progress', waiting: 'Waiting', done: 'Done', approved: 'Approved' };
const LABELS: Record<ActionType, string> = { create_task: 'Create task', update_task: 'Update task', assign_task: 'Change assignees', change_task_status: 'Change status' };
const PERMISSION: Record<ActionType, string> = { create_task: 'mytasks.create', update_task: 'mytasks.edit', assign_task: 'mytasks.assign', change_task_status: 'mytasks.edit' };
const IST_OFFSET_MS = 330 * 60_000;

const err = (error: string, message: string): Err => ({ error, message });
const isErr = (v: unknown): v is Err => !!v && typeof v === 'object' && 'error' in (v as object) && 'message' in (v as object);
const text = (v: unknown, max: number): string | undefined => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);
const oneOf = <T extends string>(v: unknown, allowed: readonly T[]): T | undefined =>
  v === undefined || v === null || v === '' ? undefined : (allowed as readonly string[]).includes(String(v)) ? (v as T) : undefined;
const isHm = (v: unknown): v is string => typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v);
const names = (list: Array<{ name: string }>) => list.map((u) => u.name).join(', ') || '—';
const roleNamesOf = (ctx: ActionAuth) => ctx.roleNames?.length ? ctx.roleNames : [ctx.roleName];
const dueYmd = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null); // DATE column at UTC midnight
const dueLabel = (date: string | null, time: string | null) => (date ? `${date}${time ? ` ${time}` : ''}` : null);

// ── Lookups (names → ids; ambiguity is reported, never guessed) ──────────────

async function resolveUser(name: string): Promise<{ id: number; name: string } | Err> {
  const n = name.trim();
  const rows = await prisma.users.findMany({ where: { name: { contains: n, mode: 'insensitive' } }, select: { id: true, name: true, status: true }, take: 25 });
  const active = rows.filter((u) => String(u.status ?? 'active').toLowerCase() === 'active');
  const exact = active.filter((u) => u.name.trim().toLowerCase() === n.toLowerCase());
  const pick = exact.length === 1 ? exact : active;
  if (!pick.length) return err('not_found', `No active user matches "${n}". Ask the user for the exact name.`);
  if (pick.length > 1) return err('ambiguous', `Several users match "${n}": ${pick.map((u) => u.name).join(', ')}. Ask the user which one they mean.`);
  return { id: pick[0].id, name: pick[0].name };
}

async function resolveUsers(v: unknown, what: string): Promise<Array<{ id: number; name: string }> | Err> {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) return err('invalid_arguments', `${what} must be a list of user names.`);
  const out = new Map<number, { id: number; name: string }>();
  for (const n of v.slice(0, 10)) { const u = await resolveUser(n); if (isErr(u)) return u; out.set(u.id, u); }
  return [...out.values()];
}

/** Projects the caller can see (GET /projects rule: admins all, others membership). */
async function resolveProject(ctx: SalesAuthContext, name: string): Promise<{ id: string; name: string } | Err> {
  const rows = await prisma.projects.findMany({
    where: { name: { contains: name, mode: 'insensitive' }, ...(isGlobalAdmin(ctx.roleName) ? {} : { project_members: { some: { user_id: ctx.userId } } }) },
    select: { id: true, name: true, is_archived: true }, take: 10,
  });
  const live = rows.filter((p) => !p.is_archived);
  const exact = live.filter((p) => p.name.toLowerCase() === name.toLowerCase());
  const pick = exact.length === 1 ? exact : live;
  if (!pick.length) return err('not_found', `No project named "${name}" is available to this user.`);
  if (pick.length > 1) return err('ambiguous', `Several projects match "${name}": ${pick.map((p) => p.name).join(', ')}. Ask which one.`);
  return { id: pick[0].id, name: pick[0].name };
}

async function userNames(ids: number[]): Promise<Map<number, string>> {
  if (!ids.length) return new Map();
  const rows = await prisma.users.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, status: true } });
  return new Map(rows.filter((u) => String(u.status ?? 'active').toLowerCase() === 'active').map((u) => [u.id, u.name]));
}

// ── Priority → default due date/time (the Create Task form's rule, in IST) ──

type Rule = { offset_days: number; offset_hours: number; due_time: string | null; basis: string };
const DEFAULT_RULES: Record<string, Rule> = {
  low: { offset_days: 3, offset_hours: 0, due_time: '10:00', basis: 'duration' },
  medium: { offset_days: 1, offset_hours: 0, due_time: '10:00', basis: 'duration' },
  high: { offset_days: 1, offset_hours: 0, due_time: '10:00', basis: 'calendar' },
  urgent: { offset_days: 0, offset_hours: 2, due_time: null, basis: 'duration' },
};
async function loadRules(): Promise<Record<string, Rule>> {
  const rows = await prisma.my_task_priority_rules.findMany();
  return rows.length ? Object.fromEntries(rows.map((r) => [r.priority, r])) : DEFAULT_RULES;
}
/** Mirrors CreateMyTaskModal.dueForPriority, evaluated on the IST wall clock. */
export function dueForPriority(rule: Rule, now: Date = new Date()): { date: string; time: string } {
  const ymd = (d: Date) => d.toISOString().slice(0, 10), hm = (d: Date) => d.toISOString().slice(11, 16);
  const t = new Date(now.getTime() + IST_OFFSET_MS); // UTC getters now read IST wall-clock
  if (rule.basis === 'calendar') {
    const d = new Date(t); d.setUTCDate(d.getUTCDate() + (rule.offset_days || 0));
    return { date: ymd(d), time: rule.due_time || hm(d) };
  }
  const base = new Date(t.getTime() + ((rule.offset_days || 0) * 86400 + (rule.offset_hours || 0) * 3600) * 1000);
  if (!rule.due_time) return { date: ymd(base), time: hm(base) };
  const [h, m] = rule.due_time.split(':').map(Number);
  const target = new Date(base); target.setUTCHours(h, m, 0, 0);
  if (target.getTime() < base.getTime()) target.setUTCDate(target.getUTCDate() + 1);
  return { date: ymd(target), time: rule.due_time };
}

// ── Canonical payloads ───────────────────────────────────────────────────────

interface CreatePayload { title: string; description?: string; priority: string; dueDate: string; dueTime: string | null; memberIds: number[]; inChargeId: number | null; projectId: string | null; derivedDue: boolean }
interface UpdatePayload { taskId: number; title?: string; description?: string; priority?: string; dueDate?: string; dueTime?: string | null; projectId?: string | null }
interface AssignPayload { taskId: number; add: number[]; remove: number[]; inChargeId?: number | null }
interface StatusPayload { taskId: number; status: string; waitingReason?: string }
type Payload = CreatePayload | UpdatePayload | AssignPayload | StatusPayload;

const taskIdArg = (v: unknown): number | Err => {
  const n = Number(typeof v === 'string' ? v.replace(/^(task[-\s#]*|#)/i, '') : v);
  return Number.isInteger(n) && n > 0 ? n : err('invalid_arguments', 'task_id must be the task number (e.g. 105 for "#105" / "TASK-105").');
};

/** Step 1 of a preview: resolve the model's arguments (names, keywords) into ids. Pure lookups, no permission checks. */
async function resolveArgs(ctx: ActionAuth, action: ActionType, a: Args): Promise<Payload | Err> {
  const due = async (priority: string, current?: { date: string | null; time: string | null }) => {
    if (a.due_date !== undefined && a.due_date !== null && a.due_date !== '') {
      if (!isYmd(a.due_date)) return err('invalid_arguments', 'due_date must be a real calendar date in YYYY-MM-DD.');
      if (a.due_time !== undefined && a.due_time !== null && a.due_time !== '' && !isHm(a.due_time)) return err('invalid_arguments', 'due_time must be HH:MM (24h).');
      const time = isHm(a.due_time) ? a.due_time : current?.time ?? (await loadRules())[priority]?.due_time ?? null;
      return { date: a.due_date as string, time, derived: false };
    }
    if (a.due_time !== undefined && a.due_time !== null && a.due_time !== '') {
      if (!isHm(a.due_time)) return err('invalid_arguments', 'due_time must be HH:MM (24h).');
      if (!current?.date) return err('invalid_arguments', 'due_time needs a due_date.');
      return { date: current.date, time: a.due_time, derived: false };
    }
    return null;
  };
  switch (action) {
    case 'create_task': {
      const title = text(a.title, 255);
      if (!title) return err('invalid_arguments', 'title is required. Ask the user what the task should be called.');
      const priority = oneOf(a.priority, PRIORITIES) ?? (a.priority ? null : 'low');
      if (!priority) return err('invalid_arguments', `priority must be one of ${PRIORITIES.join(', ')}.`);
      const members = await resolveUsers(a.assignees, 'assignees'); if (isErr(members)) return members;
      let inChargeId: number | null = members.length === 1 ? members[0].id : null;
      if (members.length > 1) {
        const ic = text(a.in_charge, 100);
        if (!ic) return err('needs_clarification', `The task would have ${members.length} assignees (${names(members)}); the module needs exactly one In-Charge. Ask the user who is in charge.`);
        const u = await resolveUser(ic); if (isErr(u)) return u;
        if (!members.some((m) => m.id === u.id)) return err('invalid_arguments', 'in_charge must be one of the assignees.');
        inChargeId = u.id;
      }
      let projectId: string | null = null;
      const pn = text(a.project_name, 150);
      if (pn) { const p = await resolveProject(ctx, pn); if (isErr(p)) return p; projectId = p.id; }
      const rules = await loadRules();
      const d = await due(priority); if (isErr(d)) return d;
      const dd = d ?? { ...dueForPriority(rules[priority] ?? DEFAULT_RULES[priority]), derived: true };
      return { title, description: text(a.description, 5000), priority, dueDate: dd.date, dueTime: dd.time, memberIds: members.map((m) => m.id), inChargeId, projectId, derivedDue: dd.derived };
    }
    case 'update_task': {
      const taskId = taskIdArg(a.task_id); if (isErr(taskId)) return taskId;
      const cur = await prisma.my_tasks.findUnique({ where: { id: taskId }, select: { due_date: true, due_time: true, priority: true } });
      const p: UpdatePayload = { taskId };
      if (a.title !== undefined) { const t = text(a.title, 255); if (!t) return err('invalid_arguments', 'title cannot be empty.'); p.title = t; }
      if (a.description !== undefined) p.description = typeof a.description === 'string' ? a.description.trim().slice(0, 5000) : '';
      if (a.priority !== undefined) { const pr = oneOf(a.priority, PRIORITIES); if (!pr) return err('invalid_arguments', `priority must be one of ${PRIORITIES.join(', ')}.`); p.priority = pr; }
      const d = await due(p.priority ?? cur?.priority ?? 'low', { date: dueYmd(cur?.due_date ?? null), time: cur?.due_time ?? null }); if (isErr(d)) return d;
      if (d) { p.dueDate = d.date; p.dueTime = d.time; }
      const pn = text(a.project_name, 150);
      if (pn) { const pr = await resolveProject(ctx, pn); if (isErr(pr)) return pr; p.projectId = pr.id; }
      return p;
    }
    case 'assign_task': {
      const taskId = taskIdArg(a.task_id); if (isErr(taskId)) return taskId;
      const add = await resolveUsers(a.add, 'add'); if (isErr(add)) return add;
      const replace = await resolveUsers(a.replace_with, 'replace_with'); if (isErr(replace)) return replace;
      const current = await prisma.my_task_members.findMany({ where: { task_id: taskId }, select: { user_id: true, user: { select: { name: true } } } });
      // `remove` is matched against the task's CURRENT members only (no global lookup needed).
      const remove: number[] = [];
      if (a.remove !== undefined && a.remove !== null) {
        if (!Array.isArray(a.remove) || a.remove.some((x) => typeof x !== 'string')) return err('invalid_arguments', 'remove must be a list of member names.');
        for (const n of a.remove as string[]) {
          const hits = current.filter((m) => m.user.name.toLowerCase().includes(n.trim().toLowerCase()));
          const exact = hits.filter((m) => m.user.name.toLowerCase() === n.trim().toLowerCase());
          const pick = exact.length === 1 ? exact : hits;
          if (!pick.length) return err('not_found', `"${n}" is not a member of task #${taskId} (members: ${names(current.map((m) => m.user)) }).`);
          if (pick.length > 1) return err('ambiguous', `Several members match "${n}": ${names(pick.map((m) => m.user))}. Ask which one.`);
          remove.push(pick[0].user_id);
        }
      }
      let addIds = add.map((u) => u.id), removeIds = remove;
      if (replace.length) {
        const keep = new Set(replace.map((u) => u.id));
        addIds = [...new Set([...addIds, ...replace.map((u) => u.id)])];
        removeIds = [...new Set([...removeIds, ...current.map((m) => m.user_id).filter((id) => !keep.has(id))])];
      }
      const p: AssignPayload = { taskId, add: addIds, remove: removeIds };
      const ic = text(a.in_charge, 100);
      if (ic) { const u = await resolveUser(ic); if (isErr(u)) return u; p.inChargeId = u.id; }
      return p;
    }
    case 'change_task_status': {
      const taskId = taskIdArg(a.task_id); if (isErr(taskId)) return taskId;
      const status = oneOf(a.status, STATUSES);
      if (!status) return err('invalid_arguments', `status must be one of ${STATUSES.join(', ')}.`);
      const waitingReason = text(a.waiting_reason, 255);
      if (status === 'waiting' && !waitingReason) return err('needs_clarification', 'Moving a task to Waiting needs a waiting reason (what it is waiting on). Ask the user.');
      return { taskId, status, waitingReason };
    }
  }
}

// ── Step 2 (preview AND confirm): permission + scope + business-rule validation of a canonical payload ──

async function validate(ctx: ActionAuth, action: ActionType, p: Payload): Promise<Validated | Err> {
  const permission = PERMISSION[action];
  if (!can(ctx, permission)) return err('permission_denied', `The user does not have the "${permission}" permission, so this action is not available to them.`);
  const roleNames = roleNamesOf(ctx);
  const today = todayIST();

  if (action === 'create_task') {
    const c = p as CreatePayload;
    if (isExternalUser(roleNames) && c.memberIds.some((id) => id !== ctx.userId)) return err('permission_denied', 'External accounts can only create tasks for themselves.');
    const nm = await userNames(c.memberIds);
    const missing = c.memberIds.filter((id) => !nm.has(id));
    if (missing.length) return err('not_found', 'One of the assignees is no longer an active user.');
    if (c.memberIds.length > 1 && (!c.inChargeId || !c.memberIds.includes(c.inChargeId))) return err('invalid_arguments', 'For multiple members, exactly one In-Charge must be selected.');
    if (c.memberIds.length === 1) c.inChargeId = c.memberIds[0];
    if (!isYmd(c.dueDate)) return err('invalid_arguments', 'Invalid due date.');
    let projectName: string | null = null;
    if (c.projectId) {
      const pr = await prisma.projects.findFirst({ where: { id: c.projectId, ...(isGlobalAdmin(ctx.roleName) ? {} : { project_members: { some: { user_id: ctx.userId } } }) }, select: { name: true } });
      if (!pr) return err('not_found', 'The project is no longer available to this user.');
      projectName = pr.name;
    }
    const notes = [
      c.derivedDue ? `Due date/time comes from the "${c.priority}" priority rule, as the Create Task form would set it.` : '',
      c.dueDate < today ? 'The due date is in the past.' : '',
      !c.memberIds.length ? 'No assignee: the task will only be visible to its creator until someone is assigned.' : '',
    ].filter(Boolean);
    return {
      permission, targetTaskId: null, summary: `Create task "${c.title}" (${c.priority}, due ${dueLabel(c.dueDate, c.dueTime)})${c.memberIds.length ? ` assigned to ${[...nm.values()].join(', ')}` : ''}`,
      card: {
        action, label: LABELS[action], taskId: null, title: c.title, notes,
        changes: [
          { field: 'Title', current: null, proposed: c.title },
          ...(c.description ? [{ field: 'Description', current: null, proposed: c.description.slice(0, 300) }] : []),
          { field: 'Assignees', current: null, proposed: c.memberIds.length ? c.memberIds.map((id) => nm.get(id)!).join(', ') : '(none)' },
          ...(c.memberIds.length > 1 ? [{ field: 'In-Charge', current: null, proposed: nm.get(c.inChargeId!) ?? null }] : []),
          { field: 'Priority', current: null, proposed: c.priority },
          { field: 'Due', current: null, proposed: dueLabel(c.dueDate, c.dueTime) },
          ...(projectName ? [{ field: 'Project', current: null, proposed: projectName }] : []),
          { field: 'Status', current: null, proposed: STATUS_LABEL.todo },
        ],
      },
    };
  }

  // Every other action targets an existing task the caller can reach (same rule as the REST controllers).
  const taskId = (p as UpdatePayload).taskId;
  const access = await canAccessMyTask(taskId, ctx.userId, ctx.roleName);
  if (!access.task || !access.allowed) return err('not_found', `Task #${taskId} was not found or is not accessible to this user.`);
  const t = access.task;
  const members = await prisma.my_task_members.findMany({ where: { task_id: taskId }, select: { user_id: true, user: { select: { name: true } } } });
  const memberNames = (ids: number[]) => ids.map((id) => members.find((m) => m.user_id === id)?.user.name ?? `User #${id}`);
  const base = { taskId, title: t.title as string };

  if (action === 'update_task') {
    if (!access.canManage) return err('permission_denied', 'Only the task creator (or an admin) can edit task details.');
    const u = p as UpdatePayload;
    const changes: Card['changes'] = [];
    if (u.title !== undefined && u.title !== t.title) changes.push({ field: 'Title', current: t.title, proposed: u.title });
    if (u.description !== undefined && u.description !== (t.description ?? '')) changes.push({ field: 'Description', current: (t.description ?? '').slice(0, 300) || '(empty)', proposed: u.description.slice(0, 300) || '(empty)' });
    if (u.priority !== undefined && u.priority !== t.priority) changes.push({ field: 'Priority', current: t.priority, proposed: u.priority });
    if (u.dueDate !== undefined) {
      if (!isYmd(u.dueDate)) return err('invalid_arguments', 'Invalid due date.');
      const cur = dueLabel(dueYmd(t.due_date), t.due_time ?? null), next = dueLabel(u.dueDate, u.dueTime ?? null);
      if (cur !== next) changes.push({ field: 'Due', current: cur ?? '(none)', proposed: next });
    }
    let projectName: string | null = null;
    if (u.projectId !== undefined && u.projectId !== (t.project_id ?? null)) {
      const pr = u.projectId ? await prisma.projects.findFirst({ where: { id: u.projectId, ...(isGlobalAdmin(ctx.roleName) ? {} : { project_members: { some: { user_id: ctx.userId } } }) }, select: { name: true } }) : null;
      if (u.projectId && !pr) return err('not_found', 'The project is no longer available to this user.');
      projectName = pr?.name ?? null;
      const old = t.project_id ? await prisma.projects.findUnique({ where: { id: t.project_id }, select: { name: true } }) : null;
      changes.push({ field: 'Project', current: old?.name ?? '(none)', proposed: projectName ?? '(none)' });
    }
    if (!changes.length) return err('no_change', `Task #${taskId} already has these values; nothing to update.`);
    const notes = [u.dueDate !== undefined && u.dueDate < today ? 'The new due date is in the past.' : ''].filter(Boolean);
    return { permission, targetTaskId: taskId, summary: `Update task #${taskId} "${t.title}": ${changes.map((c) => `${c.field} → ${c.proposed}`).join('; ')}`, card: { action, label: LABELS[action], ...base, changes, notes } };
  }

  if (action === 'assign_task') {
    if (!access.canManage) return err('permission_denied', 'Only the task creator (or an admin) can manage members.');
    if (isExternalUser(roleNames)) return err('permission_denied', 'External accounts can only invite people by phone, not assign users.');
    const s = p as AssignPayload;
    const currentIds = members.map((m) => m.user_id);
    s.remove = s.remove.filter((id) => currentIds.includes(id));
    const already = s.add.filter((id) => currentIds.includes(id));
    s.add = s.add.filter((id) => !currentIds.includes(id));
    const nm = await userNames(s.add);
    if (s.add.some((id) => !nm.has(id))) return err('not_found', 'One of the users to add is no longer active.');
    const resulting = [...currentIds.filter((id) => !s.remove.includes(id)), ...s.add];
    const resultNames = new Map<number, string>([...members.map((m) => [m.user_id, m.user.name] as [number, string]), ...nm]);
    const curInCharge: number | null = t.in_charge_id ?? null;
    let inCharge: number | null | undefined = s.inChargeId;
    if (inCharge !== undefined && inCharge !== null && !resulting.includes(inCharge)) return err('invalid_arguments', 'The In-Charge must be one of the task members after the change.');
    if (inCharge === undefined) {
      if (curInCharge !== null && !resulting.includes(curInCharge)) inCharge = resulting.length === 1 ? resulting[0] : null; // In-Charge is being removed
      else if (curInCharge === null && resulting.length === 1) inCharge = resulting[0];
    }
    if (resulting.length > 1 && (inCharge === null || (inCharge === undefined && curInCharge === null))) {
      return err('needs_clarification', `After this change the task would have ${resulting.length} members (${resulting.map((id) => resultNames.get(id)).join(', ')}) and no In-Charge. Ask the user who should be In-Charge.`);
    }
    if (inCharge === curInCharge) inCharge = undefined;
    s.inChargeId = inCharge;
    if (!s.add.length && !s.remove.length && inCharge === undefined) return err('no_change', `Task #${taskId} already has these members${already.length ? ` (${memberNames(already).join(', ')} already assigned)` : ''}; nothing to change.`);
    const changes: Card['changes'] = [
      { field: 'Members', current: memberNames(currentIds).join(', ') || '(none)', proposed: resulting.map((id) => resultNames.get(id)).join(', ') || '(none)' },
      ...(inCharge !== undefined ? [{ field: 'In-Charge', current: curInCharge ? resultNames.get(curInCharge) ?? `User #${curInCharge}` : '(none)', proposed: inCharge ? resultNames.get(inCharge)! : '(none)' }] : []),
    ];
    const notes = [
      already.length ? `${memberNames(already).join(', ')} already on the task (unchanged).` : '',
      s.remove.length ? `Removed members lose access to the task and its chat.` : '',
    ].filter(Boolean);
    return { permission, targetTaskId: taskId, summary: `Task #${taskId} "${t.title}": ${s.add.length ? `add ${[...nm.values()].join(', ')}` : ''}${s.add.length && s.remove.length ? '; ' : ''}${s.remove.length ? `remove ${memberNames(s.remove).join(', ')}` : ''}${inCharge !== undefined ? `; In-Charge → ${inCharge ? resultNames.get(inCharge) : 'none'}` : ''}`, card: { action, label: LABELS[action], ...base, changes, notes } };
  }

  // change_task_status
  if (!access.canExecute) return err('permission_denied', 'Only the task creator or the Task In-Charge can change the status.');
  const st = p as StatusPayload;
  if (st.status === 'approved' && !access.canManage) return err('permission_denied', 'Only the task creator can approve a task.');
  if (st.status === t.status) return err('no_change', `Task #${taskId} is already ${STATUS_LABEL[st.status]}.`);
  if (st.status === 'approved' && Number(t.estimated_points || 0) > 0 && members.length > 1) {
    return err('not_supported', 'Approving a task that carries points with several assignees needs a points distribution, which must be done in the My Tasks module.');
  }
  const changes: Card['changes'] = [{ field: 'Status', current: STATUS_LABEL[t.status] ?? t.status, proposed: STATUS_LABEL[st.status] }];
  if (st.status === 'waiting') changes.push({ field: 'Waiting reason', current: t.waiting_reason ?? '(none)', proposed: st.waitingReason ?? null });
  const notes = [t.status === 'waiting' && st.status !== 'waiting' ? 'Leaving Waiting clears the waiting reason.' : '', st.status === 'approved' ? 'Approval awards the task\'s points to the In-Charge.' : ''].filter(Boolean);
  return { permission, targetTaskId: taskId, summary: `Task #${taskId} "${t.title}": ${STATUS_LABEL[t.status] ?? t.status} → ${STATUS_LABEL[st.status]}`, card: { action, label: LABELS[action], ...base, changes, notes } };
}

// ── Preview tools (the ONLY action surface the model has) ────────────────────

async function preview(ctx: ActionAuth, action: ActionType, a: Args): Promise<ToolOutcome> {
  // Module permission FIRST — before any name/task lookup, so an unauthorised user cannot probe users or tasks.
  if (!can(ctx, PERMISSION[action])) {
    return { forModel: { ok: false, error: 'permission_denied', message: `The user does not have the "${PERMISSION[action]}" permission, so this action is not available to them. Tell them they can't do this through the assistant.` }, displays: [] };
  }
  const payload = await resolveArgs(ctx, action, a);
  if (isErr(payload)) return { forModel: { ok: false, ...payload }, displays: [] };
  const v = await validate(ctx, action, payload);
  if (isErr(v)) return { forModel: { ok: false, ...v }, displays: [] };
  const expiresAt = new Date(Date.now() + EXPIRY_MIN * 60_000);
  // An identical still-pending proposal is superseded, so two "create" previews never make two tasks by accident.
  await prisma.ai_action_proposals.updateMany({
    where: { user_id: ctx.userId, status: 'pending', action_type: action, payload: { equals: payload as object } },
    data: { status: 'cancelled', error: 'superseded by a newer identical proposal' },
  });
  const row = await prisma.ai_action_proposals.create({
    data: { user_id: ctx.userId, action_type: action, target_task_id: v.targetTaskId, payload: payload as object, preview: v.card as object, expires_at: expiresAt },
    select: { id: true },
  });
  const proposal: ProposalCard = { ...v.card, id: row.id, expiresAt: expiresAt.toISOString(), status: 'pending' };
  return {
    forModel: {
      ok: true, proposal_id: row.id, action, summary: v.summary, expires_in_minutes: EXPIRY_MIN,
      note: 'NOTHING HAS CHANGED YET. A preview card with Confirm and Cancel buttons is shown to the user under your reply. Summarise the proposed change in one or two sentences and tell them to press Confirm to apply it (or Cancel). You cannot confirm it.',
    },
    displays: [],
    proposal,
  };
}

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });
const TASK_ID = { task_id: { type: 'integer', description: 'The task number shown in My Tasks (e.g. 105 for "#105" / "TASK-105")' } };
const DUE = {
  due_date: { type: 'string', description: 'YYYY-MM-DD, resolved from today\'s date in Asia/Kolkata (e.g. "tomorrow", "next Monday"); omit when the user gives no date' },
  due_time: { type: 'string', description: 'HH:MM 24h; optional' },
};
export const ACTION_TOOLS: Record<string, { spec: ToolSpec; run: (ctx: SalesAuthContext, a: Args) => Promise<ToolOutcome> }> = {
  preview_create_task: {
    spec: { name: 'preview_create_task', description: 'PROPOSE a new My Tasks task (nothing is created until the user confirms the preview card). Needs a title; assignees are user names resolved by the server (ambiguous names are reported — ask the user). With several assignees one must be the in_charge. Without due_date the due date/time follows the priority rule, like the Create Task form. Default priority low.',
      parameters: obj({
        title: { type: 'string' }, description: { type: 'string' },
        assignees: { type: 'array', items: { type: 'string' }, description: 'User names to assign' },
        in_charge: { type: 'string', description: 'Which assignee is in charge (required when there are 2+ assignees)' },
        priority: { type: 'string', enum: [...PRIORITIES] },
        ...DUE,
        project_name: { type: 'string', description: 'Optional project to link, by name' },
      }, ['title']) },
    run: (ctx, a) => preview(ctx, 'create_task', a),
  },
  preview_update_task: {
    spec: { name: 'preview_update_task', description: 'PROPOSE changes to an existing task\'s title, description, priority, due date/time or project (only the fields given are changed; the task creator or an admin only). Returns current vs proposed values for the confirmation card; nothing changes until the user confirms.',
      parameters: obj({ ...TASK_ID, title: { type: 'string' }, description: { type: 'string' }, priority: { type: 'string', enum: [...PRIORITIES] }, ...DUE, project_name: { type: 'string' } }, ['task_id']) },
    run: (ctx, a) => preview(ctx, 'update_task', a),
  },
  preview_assign_task: {
    spec: { name: 'preview_assign_task', description: 'PROPOSE a change to a task\'s assigned members: add users, remove current members, or replace_with a new set (reassign). Other members are kept unless removed. in_charge picks the execution owner (required when the result has 2+ members and no In-Charge). Task creator or admin only; nothing changes until the user confirms.',
      parameters: obj({
        ...TASK_ID,
        add: { type: 'array', items: { type: 'string' }, description: 'User names to add' },
        remove: { type: 'array', items: { type: 'string' }, description: 'Current member names to remove' },
        replace_with: { type: 'array', items: { type: 'string' }, description: 'Reassign: the complete new member list' },
        in_charge: { type: 'string' },
      }, ['task_id']) },
    run: (ctx, a) => preview(ctx, 'assign_task', a),
  },
  preview_change_task_status: {
    spec: { name: 'preview_change_task_status', description: 'PROPOSE a status change for a task: todo, in_progress, waiting (needs waiting_reason), done, approved (creator only). Creator, In-Charge or admin only. The module keeps a free status vocabulary; the server reports any rule that blocks the change. Nothing changes until the user confirms.',
      parameters: obj({ ...TASK_ID, status: { type: 'string', enum: [...STATUSES] }, waiting_reason: { type: 'string' } }, ['task_id', 'status']) },
    run: (ctx, a) => preview(ctx, 'change_task_status', a),
  },
};

// ── Execution (confirm endpoint only) ────────────────────────────────────────

/** Runs an EXISTING Express handler with a synthetic request/response so the module's own logic is reused verbatim. */
// ponytail: req/res shim instead of extracting services from a 1000-line controller; swap for real service functions if the controller is ever refactored.
function invoke(handler: (req: Request, res: Response) => Promise<unknown>, auth: ReqAuth, params: Record<string, string>, body: Record<string, unknown>): Promise<{ status: number; body: any }> {
  return new Promise((resolve) => {
    const req = { params, body, query: {}, userId: auth.userId, userRole: auth.userRole, userRoleNames: auth.userRoleNames } as unknown as Request;
    let status = 200;
    const res = { status(s: number) { status = s; return res; }, json(b: unknown) { resolve({ status, body: b }); return res; } } as unknown as Response;
    handler(req, res).catch((e) => { console.error('[AI Actions] handler threw:', (e as Error)?.message); resolve({ status: 500, body: { error: 'The task operation failed.' } }); });
  });
}

async function taskSnapshot(taskId: number) {
  const t = await prisma.my_tasks.findUnique({ where: { id: taskId }, select: { id: true, title: true, status: true, priority: true, due_date: true, due_time: true, in_charge_id: true, members: { select: { user: { select: { id: true, name: true } } } } } });
  if (!t) return null;
  return {
    taskId: t.id, title: t.title, status: STATUS_LABEL[t.status] ?? t.status, priority: t.priority,
    due: dueLabel(dueYmd(t.due_date), t.due_time ?? null), members: t.members.map((m) => m.user.name),
    inCharge: t.members.find((m) => m.user.id === t.in_charge_id)?.user.name ?? null,
  };
}

async function execute(ctx: ActionAuth, auth: ReqAuth, action: ActionType, payload: Payload): Promise<{ ok: true; result: Record<string, unknown> } | { ok: false; status: number; message: string }> {
  // Re-validate the STORED canonical payload with fresh permissions and the current task state.
  const v = await validate(ctx, action, payload);
  if (isErr(v)) return { ok: false, status: v.error === 'permission_denied' ? 403 : v.error === 'not_found' ? 404 : 409, message: v.message };
  const now = new Date();
  let taskId: number;
  if (action === 'create_task') {
    const c = payload as CreatePayload;
    const r = await invoke(createMyTask, auth, {}, { title: c.title, description: c.description ?? '', priority: c.priority, dueDate: c.dueDate, dueTime: c.dueTime, memberIds: c.memberIds, inChargeId: c.inChargeId, projectId: c.projectId, estimatedPoints: 0 });
    if (r.status !== 201) return { ok: false, status: r.status === 403 ? 403 : 409, message: r.body?.error || 'Task creation failed.' };
    taskId = Number(r.body.id);
  } else if (action === 'update_task') {
    const u = payload as UpdatePayload;
    const body: Record<string, unknown> = {};
    for (const k of ['title', 'description', 'priority', 'dueDate', 'dueTime', 'projectId'] as const) if (u[k] !== undefined) body[k] = u[k];
    const r = await invoke(updateMyTask, auth, { id: String(u.taskId) }, body);
    if (r.status !== 200) return { ok: false, status: r.status === 403 ? 403 : r.status === 404 ? 404 : 409, message: r.body?.error || 'Task update failed.' };
    taskId = u.taskId;
  } else if (action === 'change_task_status') {
    const s = payload as StatusPayload;
    const r = await invoke(updateMyTaskStatus, auth, { id: String(s.taskId) }, { status: s.status, waitingReason: s.waitingReason ?? null });
    if (r.status !== 200) return { ok: false, status: r.status === 403 ? 403 : r.status === 404 ? 404 : 409, message: r.body?.error || 'Status change failed.' };
    taskId = s.taskId;
  } else {
    // Members: one transaction so a failed step leaves the previous assignment intact (mirrors addMyTaskMembers / removeMyTaskMember).
    const s = payload as AssignPayload;
    taskId = s.taskId;
    const nm = await userNames([...s.add, ...s.remove]);
    const removedNames = (await prisma.users.findMany({ where: { id: { in: s.remove } }, select: { id: true, name: true } })).map((u) => u.name);
    await prisma.$transaction(async (tx) => {
      if (s.add.length) await tx.my_task_members.createMany({ data: s.add.map((id) => ({ task_id: taskId, user_id: id, added_by: auth.userId })), skipDuplicates: true });
      if (s.remove.length) await tx.my_task_members.deleteMany({ where: { task_id: taskId, user_id: { in: s.remove } } });
      if (s.inChargeId !== undefined) await tx.my_tasks.update({ where: { id: taskId }, data: { in_charge_id: s.inChargeId } });
      if (s.add.length) await tx.my_task_activities.create({ data: { task_id: taskId, user_id: auth.userId, action: `Assigned member(s): ${s.add.map((id) => nm.get(id)).join(', ')}` } });
      for (const n of removedNames) await tx.my_task_activities.create({ data: { task_id: taskId, user_id: auth.userId, action: `Removed member: ${n}` } });
      if (s.inChargeId !== undefined) await tx.my_task_activities.create({ data: { task_id: taskId, user_id: auth.userId, action: 'Changed Task In-Charge' } });
    });
    await bumpMyTaskActivity(taskId, auth.userId, now);
    await emitTaskEvent(taskId, 'mytask_changed', { taskId, action: 'members' });
    try { // personal pings as addMyTaskMembers / removeMyTaskMember do; the DB change above must not depend on the socket
      for (const id of s.add) io.to(`user_${id}`).emit('mytask_changed', { taskId, action: 'assigned' });
      for (const id of s.remove) io.to(`user_${id}`).emit('mytask_changed', { taskId, action: 'unassigned' });
    } catch (e) { console.error('[AI Actions] socket ping failed:', (e as Error)?.message); }
    if (s.add.length) void notifyTask(taskId, auth.userId, (actor, t) => ({ title: 'Added to a task', body: `${actor} added you to ${t}` }), { type: 'task_assigned', to: s.add });
  }
  const snap = await taskSnapshot(taskId);
  return { ok: true, result: { ...(snap ?? { taskId }), action, label: LABELS[action], executedAt: new Date().toISOString() } };
}

const reqAuth = (req: Request): ReqAuth => ({
  userId: Number((req as any).userId),
  userRole: String((req as any).userRole || ''),
  userRoleNames: Array.isArray((req as any).userRoleNames) ? (req as any).userRoleNames : [String((req as any).userRole || 'User')],
});

/** POST /ai-assistant/actions/:id/confirm — the only path that mutates; single-use, user-bound, expiring. */
export const confirmAction = async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const userId = Number((req as any).userId);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ success: false, message: 'Invalid proposal id.' }); return; }
  try {
    // Atomic claim: only a PENDING, UNEXPIRED proposal of THIS user flips to executing — concurrent confirms get 0 rows.
    const claimed = await prisma.$queryRawUnsafe<any[]>(
      `UPDATE ai_action_proposals SET status = 'executing' WHERE id = $1 AND user_id = $2 AND status = 'pending' AND expires_at > now() RETURNING id, action_type, payload`, id, userId);
    if (!claimed.length) {
      const row = await prisma.ai_action_proposals.findFirst({ where: { id, user_id: userId }, select: { status: true, expires_at: true } });
      if (!row) { res.status(404).json({ success: false, message: 'Proposal not found.' }); return; }
      if (row.status === 'pending') {
        await prisma.ai_action_proposals.updateMany({ where: { id, status: 'pending' }, data: { status: 'expired' } });
        res.status(410).json({ success: false, status: 'expired', message: 'This proposal has expired. Ask the assistant for a fresh preview.' }); return;
      }
      res.status(409).json({ success: false, status: row.status, message: `This proposal was already ${row.status}.` }); return;
    }
    const row = claimed[0];
    const payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
    const ctx: ActionAuth = { ...(await getSalesAuth(req)), roleNames: (req as any).userRoleNames }; // fresh permissions
    const outcome = await execute(ctx, reqAuth(req), row.action_type as ActionType, payload);
    if (!outcome.ok) {
      await prisma.ai_action_proposals.update({ where: { id }, data: { status: 'failed', error: outcome.message.slice(0, 500), executed_at: new Date() } });
      res.status(outcome.status).json({ success: false, status: 'failed', message: outcome.message }); return;
    }
    await prisma.ai_action_proposals.update({ where: { id }, data: { status: 'confirmed', result: outcome.result as object, executed_at: new Date() } });
    res.json({ success: true, data: { id, status: 'confirmed', result: outcome.result } });
  } catch (e) {
    console.error('[AI Actions] confirm failed:', (e as Error)?.message);
    await prisma.ai_action_proposals.updateMany({ where: { id, user_id: userId, status: 'executing' }, data: { status: 'failed', error: 'internal error', executed_at: new Date() } }).catch(() => {});
    res.status(500).json({ success: false, message: 'The action could not be completed. Nothing may have changed; check the task in My Tasks.' });
  }
};

/** POST /ai-assistant/actions/:id/cancel — pending → cancelled (no side effects). */
export const cancelAction = async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const userId = Number((req as any).userId);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ success: false, message: 'Invalid proposal id.' }); return; }
  try {
    const r = await prisma.ai_action_proposals.updateMany({ where: { id, user_id: userId, status: 'pending' }, data: { status: 'cancelled' } });
    if (r.count === 1) { res.json({ success: true, data: { id, status: 'cancelled' } }); return; }
    const row = await prisma.ai_action_proposals.findFirst({ where: { id, user_id: userId }, select: { status: true } });
    if (!row) { res.status(404).json({ success: false, message: 'Proposal not found.' }); return; }
    res.status(409).json({ success: false, status: row.status, message: `This proposal was already ${row.status}.` });
  } catch (e) {
    console.error('[AI Actions] cancel failed:', (e as Error)?.message);
    res.status(500).json({ success: false, message: 'Could not cancel the proposal.' });
  }
};
