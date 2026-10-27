/**
 * Runnable self-check for push notifications (FCM).
 *   npx tsx src/services/push.service.selfcheck.ts
 *
 * Drives the REAL push + My Tasks routers over HTTP (real authenticate, real
 * controllers, real push.service). Prisma delegates are replaced with in-memory
 * stores and FCM with a fake sender, so no database or Firebase is needed.
 */
process.env.AUTH_TOKEN_SECRET ||= 'push-selfcheck-secret-0123456789abcdefghij';
process.env.NODE_ENV ||= 'test';

import express from 'express';
import { createServer } from 'http';
import type { AddressInfo } from 'net';

let failed = 0;
const ok = (cond: boolean, label: string) => {
  if (cond) console.log(`✓ ${label}`);
  else { console.error(`✗ ${label}`); failed++; }
};
const flush = () => new Promise((r) => setTimeout(r, 50));

// ── fixtures ──────────────────────────────────────────────────────────────
// 1 Alice (task creator), 2 Bob (In-Charge), 3 Carol, 4 Ext (External account),
// 5 Dave (push off), 6 Erin (taskUpdates off).
const users = new Map<number, { name: string; role: string }>([
  [1, { name: 'Alice', role: 'Developer' }],
  [2, { name: 'Bob', role: 'Developer' }],
  [3, { name: 'Carol', role: 'Developer' }],
  [4, { name: 'Ext', role: 'External' }],
  [5, { name: 'Dave', role: 'Developer' }],
  [6, { name: 'Erin', role: 'Developer' }],
]);
let tokens: { user_id: number; token: string; platform: string }[] = [];
let prefs = new Map<number, any>();
const members = new Map<number, number[]>([[10, [2, 3, 5, 6]]]);
let tasks: any[] = [];
const notificationRows: any[] = [];

const resetTokens = () => {
  tokens = [
    { user_id: 1, token: 't1', platform: 'android' },
    { user_id: 2, token: 't2', platform: 'android' },
    { user_id: 2, token: 'bad-2', platform: 'iOS' },
    { user_id: 3, token: 't3', platform: 'android' },
    { user_id: 3, token: 'dead-3', platform: 'android' },
    { user_id: 5, token: 't5', platform: 'android' },
    { user_id: 6, token: 't6', platform: 'android' },
  ];
  prefs = new Map([
    [5, { user_id: 5, push: false, task_updates: true, mentions: true, due_reminders: true }],
    [6, { user_id: 6, push: true, task_updates: false, mentions: true, due_reminders: false }],
  ]);
};

const prisma = (await import('../config/db.js')).default as any;
const stub = (model: string, value: any) =>
  Object.defineProperty(prisma, model, { value, configurable: true, writable: true });

const inList = (cond: any, v: any) => cond === undefined || (cond?.in ? cond.in.includes(v) : cond === v);

stub('$queryRawUnsafe', async (sql: string, ...args: any[]) => {
  if (sql.includes('FROM users WHERE id = $1 LIMIT 1')) {
    const u = users.get(Number(args[0]));
    return u ? [{ id: Number(args[0]), role: u.role, status: 'active', must_change_password: false }] : [];
  }
  throw new Error(`selfcheck: unstubbed query: ${sql}`);
});
// Token upsert. ON CONFLICT semantics are applied only if the SQL really says so.
stub('$executeRaw', async (strings: TemplateStringsArray, ...vals: any[]) => {
  const sql = strings.join('?');
  if (!sql.includes('INSERT INTO device_tokens')) throw new Error(`selfcheck: unstubbed exec: ${sql}`);
  const [user_id, token, platform] = vals;
  const existing = tokens.find((t) => t.token === token);
  if (!existing) { tokens.push({ user_id, token, platform }); return 1; }
  if (!sql.includes('ON CONFLICT (token) DO UPDATE') || !sql.includes('user_id = EXCLUDED.user_id')) {
    throw new Error('unique violation');
  }
  Object.assign(existing, { user_id, platform });
  return 1;
});
stub('device_tokens', {
  findMany: async ({ where }: any) => tokens.filter((t) => inList(where.user_id, t.user_id)),
  deleteMany: async ({ where }: any) => {
    const before = tokens.length;
    tokens = tokens.filter((t) => !(inList(where.token, t.token) && inList(where.user_id, t.user_id)));
    return { count: before - tokens.length };
  },
});
stub('notification_preferences', {
  findMany: async ({ where }: any) => [...prefs.values()].filter((p) => inList(where.user_id, p.user_id)),
  findUnique: async ({ where }: any) => prefs.get(where.user_id) ?? null,
  upsert: async ({ where, update, create }: any) => {
    const row = prefs.has(where.user_id)
      ? { ...prefs.get(where.user_id), ...update }
      : { push: true, task_updates: true, mentions: true, due_reminders: false, ...create };
    prefs.set(where.user_id, row);
    return row;
  },
});
stub('users', {
  findUnique: async ({ where }: any) => {
    const u = users.get(where.id);
    return u ? { id: where.id, ...u } : null;
  },
  findMany: async ({ where }: any) =>
    [...users.entries()].filter(([id]) => inList(where.id, id)).map(([id, u]) => ({ id, ...u })),
});
stub('my_tasks', {
  findUnique: async ({ where }: any) => tasks.find((t) => t.id === where.id) ?? null,
  findMany: async ({ where }: any) => tasks
    .filter((t) => t.due_reminder_sent_at === null && !where.status.notIn.includes(t.status))
    .map((t) => ({ ...t, members: (members.get(t.id) ?? []).map((user_id) => ({ user_id })) })),
  updateMany: async ({ where, data }: any) => {
    const t = tasks.find((x) => x.id === where.id && x.due_reminder_sent_at === where.due_reminder_sent_at);
    if (!t) return { count: 0 };
    Object.assign(t, data);
    return { count: 1 };
  },
});
stub('my_task_members', {
  findMany: async ({ where }: any) => (members.get(where.task_id) ?? [])
    .filter((u) => inList(where.user_id, u)).map((user_id) => ({ user_id })),
  findUnique: async ({ where }: any) => {
    const { task_id, user_id } = where.task_id_user_id;
    return (members.get(task_id) ?? []).includes(user_id) ? { id: 1 } : null;
  },
});
stub('my_task_messages', {
  create: async ({ data }: any) => ({
    id: 1, ...data, created_at: new Date(),
    sender: { id: data.sender_id, name: users.get(data.sender_id)!.name, email: 'x@x.io' },
  }),
});
stub('notifications', { create: async ({ data }: any) => { notificationRows.push(data); return data; } });

// Fake FCM: 'dead-*' → token gone, 'bad-*' → a server-side error, else success.
const sends: { tokens: string[]; notification: any; data: any }[] = [];
const fakeMessaging = {
  sendEachForMulticast: async (m: any) => {
    sends.push({ tokens: m.tokens, notification: m.notification, data: m.data });
    const responses = m.tokens.map((t: string) =>
      t.startsWith('dead') ? { success: false, error: { code: 'messaging/registration-token-not-registered' } }
        : t.startsWith('bad') ? { success: false, error: { code: 'messaging/internal-error' } }
          : { success: true });
    return { responses, successCount: 0, failureCount: 0 };
  },
};

const push = await import('./push.service.js');
const { issueToken } = await import('../utils/authToken.js');
const { initSocket } = await import('../socket.js');
const pushRoutes = (await import('../routes/push.routes.js')).default;
const myTasksRoutes = (await import('../routes/myTasks.routes.js')).default;

const app = express();
app.use(express.json());
app.use('/api', pushRoutes);
app.use('/api/my-tasks', myTasksRoutes);
const httpServer = createServer(app);
initSocket(httpServer); // controllers emit on io
await new Promise<void>((r) => httpServer.listen(0, r));
const base = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}/api`;

const call = (method: string, path: string, userId: number, body?: any) =>
  fetch(base + path, {
    method,
    headers: { Authorization: `Bearer ${issueToken(userId)}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

// ── 1. device tokens ───────────────────────────────────────────────────────
resetTokens();
let r = await call('POST', '/devices', 4, { token: 'shared', platform: 'iOS' });
ok(r.status === 204, 'External user can register a device (204, not 403)');
r = await call('POST', '/devices', 1, { token: 'shared', platform: 'android' });
ok(r.status === 204, 're-registering the same token as another user → 204');
const shared = tokens.filter((t) => t.token === 'shared');
ok(shared.length === 1 && shared[0].user_id === 1 && shared[0].platform === 'android', 'token moved to the new user (one row)');
ok((await call('POST', '/devices', 1, { token: 'x', platform: 'ios' })).status === 400, 'platform must be exactly android|iOS');
ok((await call('POST', '/devices', 1, { token: '  ', platform: 'android' })).status === 400, 'blank token → 400');
ok((await call('POST', '/devices', 1, { token: 'a'.repeat(4097), platform: 'android' })).status === 400, 'token > 4096 chars → 400');
ok((await call('DELETE', '/devices/shared', 4)).status === 204 && tokens.some((t) => t.token === 'shared'),
  "DELETE of someone else's token → 204 but token kept");
ok((await call('DELETE', '/devices/shared', 1)).status === 204 && !tokens.some((t) => t.token === 'shared'),
  'DELETE of own token removes it');

// ── 2. preferences ─────────────────────────────────────────────────────────
r = await call('GET', '/notification-preferences', 3);
ok(JSON.stringify(await r.json()) === JSON.stringify({ push: true, taskUpdates: true, mentions: true, dueReminders: false }),
  'no row → defaults');
r = await call('PUT', '/notification-preferences', 3, { dueReminders: true });
ok(JSON.stringify(await r.json()) === JSON.stringify({ push: true, taskUpdates: true, mentions: true, dueReminders: true }),
  'PUT subset → full object');
ok((await call('PUT', '/notification-preferences', 4, { push: 'no' })).status === 400, 'non-boolean pref → 400');
ok((await call('GET', '/notification-preferences', 4)).status === 200, 'External user can read preferences');

// ── 3. chat message: actor exclusion, prefs, de-dup, invalid-token cleanup ──
resetTokens();
push.__setMessagingForTest(fakeMessaging);
tasks = [{ id: 10, title: 'Ship it', status: 'in_progress', created_by: 1, in_charge_id: 2, metadata: {} }];
sends.length = 0;
r = await call('POST', '/my-tasks/10/messages', 1, { message: 'hello team', mentions: [3] });
await flush();
ok(r.status === 201, 'message posted');
ok(notificationRows.some((n) => n.user_id === 3 && n.type === 'mention'), 'existing in-app mention notification still created');
const all = sends.flatMap((s) => s.tokens);
ok(!all.includes('t1'), 'actor (sender) never gets a push');
const mention = sends.find((s) => s.data.type === 'mention');
const chat = sends.find((s) => s.data.type === 'task_message');
ok(!!mention && mention.tokens.sort().join() === 'dead-3,t3' && mention.notification.title === 'Alice mentioned you'
  && mention.notification.body === 'Ship it: hello team', 'mentioned user gets the mention push');
ok(!!chat && chat.tokens.sort().join() === 'bad-2,t2' && chat.notification.body === 'Alice: hello team',
  'chat push: mentioned user de-duplicated, push=false and taskUpdates=false users skipped');
ok(mention?.data.entity_type === 'my_task' && mention?.data.entity_id === '10', 'data payload carries string entity fields');
ok(!tokens.some((t) => t.token === 'dead-3'), 'not-registered token deleted');
ok(tokens.some((t) => t.token === 'bad-2'), 'token with a non-token error kept');

// ── 4. status change by the In-Charge reaches the creator, not the actor ──
sends.length = 0;
tasks[0].status = 'done';
await push.notifyTask(10, 2, (_a, t) => ({ title: 'Task updated', body: `${t} is now Done` }), { type: 'task_status', includeClosed: true });
ok(sends.length === 1 && sends[0].tokens.includes('t1') && !sends[0].tokens.includes('t2'), 'status push: creator yes, actor no');
sends.length = 0;
await push.notifyTask(10, 1, (a) => ({ title: 'x', body: a }), { type: 'task_message' });
ok(sends.length === 0, 'closed task: non-status events are not pushed');
await push.notifyTask(10, 2, () => ({ title: 'x', body: 'y' }), { type: 'task_assigned', to: [99], includeClosed: true });
ok(sends.length === 0, 'users not on the task are never pushed');

// ── 5. truncation + disabled FCM ───────────────────────────────────────────
sends.length = 0;
await push.sendPush([1], { title: 'T', body: 'x'.repeat(300), type: 't', entityType: 'my_task', entityId: 1 }, 'messages');
ok(sends[0]?.notification.body.length === 120 && sends[0].notification.body.endsWith('…'), 'body truncated to 120 with …');
push.__setMessagingForTest(null);
sends.length = 0;
await push.sendPush([1], { title: 'T', body: 'b', type: 't', entityType: 'my_task', entityId: 1 }, 'messages');
ok(sends.length === 0, 'no Firebase configured → no-op');
push.__setMessagingForTest(fakeMessaging);

// ── 6. due reminders ───────────────────────────────────────────────────────
// now = 08:30 IST on 2026-10-27. Bob (2) has dueReminders on.
prefs.set(2, { user_id: 2, push: true, task_updates: true, mentions: true, due_reminders: true });
const day = new Date('2026-10-27T00:00:00.000Z');
const now = new Date('2026-10-27T03:00:00.000Z');
members.set(20, [2]);
tasks = [
  { id: 20, title: 'Default time', status: 'todo', due_date: day, due_time: null, created_by: 1, in_charge_id: 2, due_reminder_sent_at: null },
  { id: 21, title: 'Seconds fmt', status: 'todo', due_date: day, due_time: '09:20:00', created_by: 2, in_charge_id: null, due_reminder_sent_at: null },
  { id: 22, title: 'Too far', status: 'todo', due_date: day, due_time: '10:00', created_by: 2, in_charge_id: null, due_reminder_sent_at: null },
  { id: 23, title: 'Already past', status: 'todo', due_date: day, due_time: '08:00', created_by: 2, in_charge_id: null, due_reminder_sent_at: null },
  { id: 24, title: 'Closed', status: 'approved', due_date: day, due_time: '09:10', created_by: 2, in_charge_id: null, due_reminder_sent_at: null },
];
sends.length = 0;
const first = await push.runDueReminders(now);
ok(first === 2, `reminds only tasks due within the next 60 minutes (got ${first})`);
ok(sends.map((s) => s.notification.body).sort().join('|') === 'Default time is due at 09:00|Seconds fmt is due at 09:20',
  'no due time ⇒ 09:00; HH:mm:ss accepted');
ok(tasks.filter((t) => t.due_reminder_sent_at).map((t) => t.id).join() === '20,21', 'dueReminderSentAt set on sent tasks');
sends.length = 0;
ok(await push.runDueReminders(now) === 0 && sends.length === 0, 'second run sends nothing (no double-send)');
ok((await fetch(`${base}/internal/due-reminders`, { method: 'POST' })).status === 401, 'cron endpoint rejects missing secret');

httpServer.close();
if (failed) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log('\nAll push self-checks passed');
process.exit(0);
