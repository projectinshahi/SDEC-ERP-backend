/**
 * Runnable self-check for Socket.IO room authorization (Phase 2.6A.1).
 *   npx tsx src/socket.authz.selfcheck.ts
 *
 * This drives a REAL Socket.IO server over a REAL Engine.IO connection with a
 * real socket.io-client: the handshake middleware, the join handlers and the
 * room broadcast path all execute exactly as they do in production. Only the
 * database is stubbed — prisma.$queryRawUnsafe is swapped for an in-memory
 * fixture — so the test can assert authorization without a live Postgres.
 *
 * The property under test: knowing a task/bug id must never be enough to enter
 * its room or to receive its discussion events.
 */
process.env.AUTH_TOKEN_SECRET ||= 'socket-authz-selfcheck-secret-0123456789abcdef';
process.env.NODE_ENV ||= 'test';

import { createServer } from 'http';
import type { AddressInfo } from 'net';
import { io as ioClient, Socket as ClientSocket } from 'socket.io-client';

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
// Mutable so a test can change a user's access at runtime and re-join.
const state = {
  users: new Map<number, { status: string; role: string }>([
    [1, { status: 'active', role: 'SuperAdmin' }],   // global admin bypass
    [2, { status: 'active', role: 'Developer' }],    // holds task.read + bugs.read
    [3, { status: 'active', role: 'Viewer' }],       // holds nothing
    [4, { status: 'inactive', role: 'Developer' }],  // deactivated
  ]),
  rolePermissions: new Map<string, string[]>([
    ['SuperAdmin', []],
    ['Developer', ['task.read', 'bugs.read']],
    ['Viewer', []],
  ]),
  tasks: new Set<string>(['TASK-1']),
  bugs: new Set<number>([55]),
};

const prisma = (await import('./config/db.js')).default as any;

// The single seam: every authorization query in socket.ts / roomAccess.ts goes
// through $queryRawUnsafe, so routing on the SQL text covers all of them.
prisma.$queryRawUnsafe = async (sql: string, ...args: any[]): Promise<any[]> => {
  if (sql.includes('FROM users')) {
    const user = state.users.get(Number(args[0]));
    if (!user) return [];
    // roomAccess filters deactivated accounts in SQL; emulate that here.
    if (sql.includes("<> 'inactive'") && user.status === 'inactive') return [];
    return [{ id: Number(args[0]), status: user.status, role: user.role }];
  }
  if (sql.includes('FROM roles')) {
    const perms = state.rolePermissions.get(String(args[0]));
    return perms ? [{ permissions: perms }] : [];
  }
  if (sql.includes('FROM kanban_tasks')) {
    return state.tasks.has(String(args[0])) ? [{ ok: 1 }] : [];
  }
  if (sql.includes('FROM bugs')) {
    return state.bugs.has(Number(args[0])) ? [{ ok: 1 }] : [];
  }
  throw new Error(`selfcheck: unstubbed query: ${sql}`);
};

const { initSocket } = await import('./socket.js');
const socketModule = await import('./socket.js');
const { issueToken } = await import('./utils/authToken.js');

// ── harness ───────────────────────────────────────────────────────────────
const httpServer = createServer();
initSocket(httpServer);
await new Promise<void>((resolve) => httpServer.listen(0, resolve));
const port = (httpServer.address() as AddressInfo).port;
const url = `http://127.0.0.1:${port}`;

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
const open: ClientSocket[] = [];

/** Connect as a user id, or with an explicit token string. Resolves null if rejected. */
function connect(token: string): Promise<ClientSocket | null> {
  return new Promise((resolve) => {
    const client = ioClient(url, { auth: { token }, transports: ['websocket'], reconnection: false });
    open.push(client);
    const done = (v: ClientSocket | null) => { clearTimeout(timer); resolve(v); };
    const timer = setTimeout(() => done(null), 4000);
    client.on('connect', () => done(client));
    client.on('connect_error', () => done(null));
  });
}

const connectAs = (userId: number) => connect(issueToken(userId));

/** Is this client's socket actually a member of the room, server-side? */
const inRoom = (client: ClientSocket, room: string) =>
  socketModule.io.sockets.adapter.rooms.get(room)?.has(client.id!) === true;

/**
 * Emit a join and settle: waits until the socket is in the room, an error
 * arrives, or the attempt is judged silent. Returns what actually happened.
 */
async function tryJoin(
  client: ClientSocket,
  event: string,
  payload: any,
  room: string,
): Promise<{ outcome: 'joined' | 'denied' | 'silent'; message?: string }> {
  let message: string | undefined;
  const onErr = (e: any) => { message = e?.message; };
  client.on('error', onErr);
  client.emit(event, payload);

  for (let i = 0; i < 60; i++) {
    await delay(10);
    if (inRoom(client, room) || message !== undefined) break;
  }
  await delay(20); // let a late join land before declaring victory
  client.off('error', onErr);

  if (inRoom(client, room)) return { outcome: 'joined', message };
  return { outcome: message !== undefined ? 'denied' : 'silent', message };
}

/** Broadcast to a room and report which of the given clients received it. */
async function broadcast(room: string, event: string, clients: ClientSocket[]): Promise<boolean[]> {
  const got = clients.map(() => false);
  const handlers = clients.map((c, i) => {
    const h = () => { got[i] = true; };
    c.on(event, h);
    return h;
  });
  socketModule.io.to(room).emit(event, { message: 'discussion content' });
  await delay(120);
  clients.forEach((c, i) => c.off(event, handlers[i]));
  return got;
}

// ── C. AUTH REGRESSION (unchanged Phase 2.6A behaviour) ───────────────────
{
  const valid = await connectAs(2);
  ok(valid !== null, 'valid token still authenticates the socket');

  const token = issueToken(2);
  const parts = token.split('.');
  const flipped = parts[4].slice(0, -1) + (parts[4].endsWith('A') ? 'B' : 'A');
  ok(await connect([...parts.slice(0, 4), flipped].join('.')) === null,
    'tampered signature is rejected at the handshake');
  ok(await connect(['v1', '3', parts[2], parts[3], parts[4]].join('.')) === null,
    'user id swapped with the signature reused is rejected');
  ok(await connect('user-token-2') === null, 'the old unsigned format is still refused');
  ok(await connect('') === null, 'an empty token is refused');
  ok(await connectAs(4) === null, 'a deactivated account cannot open a socket');
}

// ── A. TASK ROOM ──────────────────────────────────────────────────────────
const dev = (await connectAs(2))!;      // task.read + bugs.read
const viewer = (await connectAs(3))!;   // no permissions
const admin = (await connectAs(1))!;    // global admin

{
  // 1. authorized + existing task → joins
  const r = await tryJoin(dev, 'join_task_room', { taskId: 'TASK-1' }, 'task_TASK-1');
  ok(r.outcome === 'joined', 'A1 authorized user joins a task room they may read');

  // admin bypass must work the same way
  const a = await tryJoin(admin, 'join_task_room', { taskId: 'TASK-1' }, 'task_TASK-1');
  ok(a.outcome === 'joined', 'A1b a global admin joins via the permission bypass');

  // 2. authenticated but NOT authorized → rejected
  const u = await tryJoin(viewer, 'join_task_room', { taskId: 'TASK-1' }, 'task_TASK-1');
  ok(u.outcome !== 'joined', 'A2 a user without task.read is NOT admitted to the task room');
  ok(!inRoom(viewer, 'task_TASK-1'), 'A2b …and is genuinely absent from the room server-side');
  ok((u.message ?? '').toLowerCase().includes('unauthor'),
    'A2c …and is told, in the shape the existing client understands');

  // 3. non-existent task, for a user who otherwise holds task.read
  const missing = await tryJoin(dev, 'join_task_room', { taskId: 'NOPE-9999' }, 'task_NOPE-9999');
  ok(missing.outcome !== 'joined', 'A3 a non-existent task is safely rejected');

  // 5. the denial must not leak that the task is missing rather than forbidden
  ok(missing.message === u.message,
    'A3b unknown-task and forbidden-task return the SAME message (no existence probe)');

  // 4. malformed ids
  for (const bad of [{ taskId: null }, { taskId: 'undefined' }, { taskId: {} },
                     { taskId: 'x'.repeat(300) }, {}, null]) {
    const room = `task_${(bad as any)?.taskId}`;
    const m = await tryJoin(dev, 'join_task_room', bad, room);
    ok(m.outcome !== 'joined', `A4 malformed task id safely rejected: ${JSON.stringify(bad)}`);
  }
  ok(true, 'A4b no malformed id crashed the server');
}

// ── D11. DATA LEAKAGE — task discussion events ────────────────────────────
{
  const [devGot, viewerGot] = await broadcast('task_TASK-1', 'new_message', [dev, viewer]);
  ok(devGot, 'D11a the authorized member receives task discussion events');
  ok(!viewerGot, 'D11b the REJECTED user receives NO task discussion events');
}

// ── A5. authorization reflects CURRENT backend state ──────────────────────
{
  state.rolePermissions.set('Viewer', ['task.read']); // access granted upstream
  const now = await tryJoin(viewer, 'join_task_room', { taskId: 'TASK-1' }, 'task_TASK-1');
  ok(now.outcome === 'joined', 'A5 a newly granted permission admits the user on the next join');

  state.rolePermissions.set('Viewer', []); // and revoked again
  const fresh = (await connectAs(3))!;
  const after = await tryJoin(fresh, 'join_task_room', { taskId: 'TASK-1' }, 'task_TASK-1');
  ok(after.outcome !== 'joined', 'A5b a revoked permission is refused on the next join');
}

// ── B. BUG ROOM (its own rule: bugs.read) ─────────────────────────────────
{
  const bugDev = (await connectAs(2))!;
  const bugViewer = (await connectAs(3))!;

  const j = await tryJoin(bugDev, 'join_bug_room', { bugId: 55 }, 'bug_55');
  ok(j.outcome === 'joined', 'B6 authorized user joins a bug room they may read');

  const d = await tryJoin(bugViewer, 'join_bug_room', { bugId: 55 }, 'bug_55');
  ok(d.outcome !== 'joined', 'B7 a user without bugs.read is NOT admitted to the bug room');
  ok(!inRoom(bugViewer, 'bug_55'), 'B7b …and is absent from the room server-side');

  const missing = await tryJoin(bugDev, 'join_bug_room', { bugId: 999999 }, 'bug_999999');
  ok(missing.outcome !== 'joined', 'B8 a non-existent bug is safely rejected');
  ok(missing.message === d.message, 'B8b unknown-bug and forbidden-bug are indistinguishable');

  for (const bad of [{ bugId: 'abc' }, { bugId: -1 }, { bugId: 0 }, { bugId: 1.5 },
                     { bugId: 9999999999 }, { bugId: null }]) {
    const m = await tryJoin(bugDev, 'join_bug_room', bad, `bug_${(bad as any).bugId}`);
    ok(m.outcome !== 'joined', `B8c malformed bug id safely rejected: ${JSON.stringify(bad)}`);
  }

  // D12. bug discussion events must not reach the rejected socket
  const [got, leaked] = await broadcast('bug_55', 'new_message', [bugDev, bugViewer]);
  ok(got, 'D12a the authorized member receives bug discussion events');
  ok(!leaked, 'D12b the REJECTED user receives NO bug discussion events');
}

// ── the separation the phase exists to prove ──────────────────────────────
{
  // bugs.read must not be satisfiable by task.read, and vice versa.
  state.rolePermissions.set('Viewer', ['task.read']);
  const taskOnly = (await connectAs(3))!;
  const bugTry = await tryJoin(taskOnly, 'join_bug_room', { bugId: 55 }, 'bug_55');
  ok(bugTry.outcome !== 'joined', 'task.read alone does NOT open a bug room');

  state.rolePermissions.set('Viewer', ['bugs.read']);
  const bugOnly = (await connectAs(3))!;
  const taskTry = await tryJoin(bugOnly, 'join_task_room', { taskId: 'TASK-1' }, 'task_TASK-1');
  ok(taskTry.outcome !== 'joined', 'bugs.read alone does NOT open a task room');
  state.rolePermissions.set('Viewer', []);
}

// ── presence/typing cannot be injected into a room you never joined ───────
{
  const outsider = (await connectAs(3))!;
  let heard = false;
  dev.on('typing', () => { heard = true; });
  outsider.emit('typing', { taskId: 'TASK-1', userName: 'intruder' });
  outsider.emit('stop_typing', { taskId: 'TASK-1' });
  outsider.emit('leave_task_room', { taskId: 'TASK-1' });
  await delay(120);
  dev.off('typing');
  ok(!heard, 'a non-member cannot inject typing presence into a task room');
  ok(inRoom(dev, 'task_TASK-1'), 'and cannot evict a legitimate member from it');
}

// ── a DB failure must fail CLOSED ─────────────────────────────────────────
{
  const saved = prisma.$queryRawUnsafe;
  prisma.$queryRawUnsafe = async () => { throw new Error('database is down'); };
  const brokenClient = (await connectAs(2)) ?? dev; // handshake tolerates DB loss by design
  const r = await tryJoin(brokenClient, 'join_task_room', { taskId: 'TASK-1' }, 'task_TASK-1');
  ok(r.outcome !== 'joined', 'a failing authorization query denies the join rather than allowing it');
  prisma.$queryRawUnsafe = saved;
}

// ── teardown ──────────────────────────────────────────────────────────────
open.forEach((c) => c.close());
socketModule.io.close();
httpServer.close();

if (failed) {
  console.error(`\n${failed} socket authorization self-check(s) FAILED`);
  process.exit(1);
}
console.log('\nAll socket authorization self-checks passed.');
process.exit(0);
