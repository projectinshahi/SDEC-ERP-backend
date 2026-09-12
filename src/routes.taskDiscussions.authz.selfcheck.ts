/**
 * Runnable self-check for REST task-discussion authorization (Phase 2.6A.2).
 *   npx tsx src/routes.taskDiscussions.authz.selfcheck.ts
 *
 * Drives the REAL Express router over a REAL HTTP server: the real
 * authenticate + checkPermission middleware and the real controller all run.
 * Only the database is stubbed, so no live Postgres is needed.
 *
 * The property under test: /tasks/:id/discussions must not hand discussion
 * content to an authenticated user who lacks the kanban read permission.
 */
process.env.AUTH_TOKEN_SECRET ||= 'rest-authz-selfcheck-secret-0123456789abcdef';
process.env.NODE_ENV ||= 'test';

import express from 'express';
import { createServer } from 'http';
import type { AddressInfo } from 'net';

let failed = 0;
const ok = (cond: boolean, label: string) => {
  if (cond) {
    console.log(`✓ ${label}`);
  } else {
    console.error(`✗ ${label}`);
    failed++;
  }
};

// ── fixtures ──────────────────────────────────────────────────────────────
const SECRET_MESSAGE = 'CONFIDENTIAL-DISCUSSION-CONTENT';
const state = {
  users: new Map<number, { role: string; status: string; must_change_password: boolean }>([
    [1, { role: 'SuperAdmin', status: 'active', must_change_password: false }],
    [2, { role: 'Developer', status: 'active', must_change_password: false }], // read + update
    [3, { role: 'Reader', status: 'active', must_change_password: false }],    // read only
    [4, { role: 'Viewer', status: 'active', must_change_password: false }],    // nothing
  ]),
  rolePermissions: new Map<string, string[]>([
    ['SuperAdmin', []],
    ['Developer', ['task.read', 'task.update', 'bugs.read']],
    ['Reader', ['task.read']],
    ['Viewer', []],
  ]),
};

const prisma = (await import('./config/db.js')).default as any;

prisma.$queryRawUnsafe = async (sql: string, ...args: any[]): Promise<any[]> => {
  if (sql.includes('FROM users')) {
    const u = state.users.get(Number(args[0]));
    return u ? [{ id: Number(args[0]), ...u }] : [];
  }
  if (sql.includes('FROM roles')) {
    const p = state.rolePermissions.get(String(args[0]));
    return p ? [{ permissions: p }] : [];
  }
  throw new Error(`selfcheck: unstubbed query: ${sql}`);
};

const stub = (model: string, value: any) =>
  Object.defineProperty(prisma, model, { value, configurable: true, writable: true });

stub('kanban_tasks', { findUnique: async () => ({ id: 'TASK-1', board_id: 7 }) });
stub('bugs', { findUnique: async () => ({ id: 55 }) });
stub('users', { findUnique: async () => ({ id: 2, name: 'Dev' }) });
stub('task_discussions', {
  findMany: async () => [
    { id: 1, task_id: 'TASK-1', message: SECRET_MESSAGE, sender: { id: 2, name: 'Dev', email: 'd@x.io' } },
  ],
  create: async () => ({ id: 2, task_id: 'TASK-1', message: 'hi', sender: { id: 2, name: 'Dev', email: 'd@x.io' } }),
  updateMany: async () => ({ count: 0 }),
  findFirst: async () => null,
});
stub('bug_discussions', {
  findMany: async () => [
    { id: 9, bug_id: 55, message: 'BUG-SECRET', sender: { id: 2, name: 'Dev', email: 'd@x.io' } },
  ],
});

stub('task_discussion_reads', { upsert: async () => ({ id: 1 }) });

const taskDiscussionRoutes = (await import('./routes/task_discussions.routes.js')).default;
const bugRoutes = (await import('./routes/bug.routes.js')).default;
const { issueToken } = await import('./utils/authToken.js');
const { initSocket } = await import('./socket.js');

// ── harness: mounted exactly as routes/index.ts mounts it ─────────────────
const app = express();
app.use(express.json());
app.use('/api/tasks/:id/discussions', taskDiscussionRoutes);
app.use('/api/bugs', bugRoutes);

const httpServer = createServer(app);
initSocket(httpServer); // the controller broadcasts through io on write paths
await new Promise<void>((r) => httpServer.listen(0, r));
const base = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;

interface Res { status: number; body: string }

async function call(method: string, path: string, token?: string, body?: any): Promise<Res> {
  const res = await fetch(base + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: await res.text() };
}

const asUser = (id: number) => issueToken(id);
const leaks = (r: Res) => r.body.includes(SECRET_MESSAGE);

// ── 1 + 4. authorized read still works, contract unchanged ────────────────
{
  const r = await call('GET', '/api/tasks/TASK-1/discussions', asUser(3)); // task.read only
  ok(r.status === 200, '1 a user WITH task.read still gets the discussion (200)');
  ok(leaks(r), '4a …and the existing response contract still carries the messages');
  const parsed = JSON.parse(r.body);
  ok(Array.isArray(parsed) && parsed[0]?.sender?.name === 'Dev',
    '4b …still a bare array of messages with the sender relation (shape unchanged)');

  const admin = await call('GET', '/api/tasks/TASK-1/discussions', asUser(1));
  ok(admin.status === 200, '1b a global admin still reads through the permission bypass');
}

// ── 2 + 6. the gap this phase closes ──────────────────────────────────────
{
  const r = await call('GET', '/api/tasks/TASK-1/discussions', asUser(4)); // no task.read
  ok(r.status === 403, '2 a user WITHOUT task.read is now rejected (403)');
  ok(!leaks(r), '6 …and NO discussion content is returned to them');
  ok(r.body.includes('task.read'), '2b …with the standard missing-permission error');
}

// ── 3. unauthenticated behaviour unchanged ────────────────────────────────
{
  const none = await call('GET', '/api/tasks/TASK-1/discussions');
  ok(none.status === 401, '3 an unauthenticated request is still 401');
  ok(!leaks(none), '3b …and leaks nothing');

  const parts = asUser(3).split('.');
  const forged = ['v1', '4', parts[2], parts[3], parts[4]].join('.');
  const t = await call('GET', '/api/tasks/TASK-1/discussions', forged);
  ok(t.status === 401, '3c a tampered token is still 401 (2.6A intact)');
  ok(!leaks(t), '3d …and leaks nothing');

  const old = await call('GET', '/api/tasks/TASK-1/discussions', 'user-token-3');
  ok(old.status === 401 && !leaks(old), '3e the old unsigned format is still refused');
}

// ── write paths take the kanban write permission ──────────────────────────
{
  const readOnly = await call('POST', '/api/tasks/TASK-1/discussions', asUser(3), { message: 'hi' });
  ok(readOnly.status === 403, 'W1 task.read alone cannot POST a message (needs task.update)');

  const writer = await call('POST', '/api/tasks/TASK-1/discussions', asUser(2), { message: 'hi' });
  ok(writer.status !== 401 && writer.status !== 403, 'W2 task.update passes authorization on POST');

  const del = await call('DELETE', '/api/tasks/TASK-1/discussions/1', asUser(3));
  ok(del.status === 403, 'W3 task.read alone cannot DELETE a message');

  const mark = await call('POST', '/api/tasks/TASK-1/discussions/read', asUser(3), {});
  ok(mark.status === 200, 'W4 task.read may still mark the thread read (200, real controller path)');

  const noPerm = await call('POST', '/api/tasks/TASK-1/discussions/read', asUser(4), {});
  ok(noPerm.status === 403, 'W5 …but a user with no task permission cannot');
}

// ── 5. sibling discussion routes unchanged ────────────────────────────────
{
  const allowed = await call('GET', '/api/bugs/55/discussions', asUser(2)); // has bugs.read
  ok(allowed.status === 200, '5a bug discussions still work for a bugs.read holder');

  const denied = await call('GET', '/api/bugs/55/discussions', asUser(3)); // no bugs.read
  ok(denied.status === 403, '5b bug discussions still reject a user without bugs.read');
  ok(denied.body.includes('bugs.read'), '5c …with their own permission, not the task one');
  ok(!denied.body.includes('task.read'), '5d task.read does not satisfy the bug route');
}

// ── no bypass through path or query manipulation ──────────────────────────
{
  const viewer = asUser(4);
  const attempts: Array<[string, string]> = [
    ['GET', '/api/tasks/TASK-1/discussions?permission=task.read'],
    ['GET', '/api/tasks/TASK-1/discussions?role=SuperAdmin'],
    ['GET', '/api/tasks/TASK-1/discussions/'],
    ['GET', '/api/tasks/TASK-1/discussions?userId=1'],
    ['GET', '/api/tasks/TASK-1/discussions?userRole=SuperAdmin'],
  ];
  let bypassed = 0;
  for (const [m, p] of attempts) {
    const r = await call(m, p, viewer);
    if (r.status === 200 || leaks(r)) {
      bypassed++;
      console.error(`   leaked via ${p} (${r.status})`);
    }
  }
  ok(bypassed === 0, 'no path/query manipulation bypasses the guard or leaks content');
}

// ── the socket rule must not have been weakened to match REST ─────────────
{
  const { canJoinTaskRoom } = await import('./utils/roomAccess.js');
  const savedRaw = prisma.$queryRawUnsafe;
  prisma.$queryRawUnsafe = async (sql: string, ...args: any[]): Promise<any[]> => {
    if (sql.includes('FROM users')) {
      const u = state.users.get(Number(args[0]));
      return u ? [{ role: u.role }] : [];
    }
    if (sql.includes('FROM roles')) {
      const p = state.rolePermissions.get(String(args[0]));
      return p ? [{ permissions: p }] : [];
    }
    if (sql.includes('FROM kanban_tasks')) return [{ ok: 1 }];
    return [];
  };
  ok((await canJoinTaskRoom('TASK-1', 3)).allowed === true, 'socket still admits a task.read holder');
  ok((await canJoinTaskRoom('TASK-1', 4)).allowed === false, 'socket still rejects a user without task.read');
  prisma.$queryRawUnsafe = savedRaw;
}

// ── teardown ──────────────────────────────────────────────────────────────
httpServer.close();
if (failed) {
  console.error(`\n${failed} REST task-discussion authorization self-check(s) FAILED`);
  process.exit(1);
}
console.log('\nAll REST task-discussion authorization self-checks passed.');
process.exit(0);
