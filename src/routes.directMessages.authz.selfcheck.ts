/**
 * Runnable self-check for direct 1:1 messaging (Phase 2.6B).
 *   npx tsx src/routes.directMessages.authz.selfcheck.ts
 *
 * Drives the REAL Express router over a REAL HTTP server: real authenticate,
 * real routes, real controllers, real service. The database is replaced with an
 * in-memory table that answers the service's actual SQL, so the SQL's own
 * scoping (the WHERE clauses that isolate one conversation) is exercised rather
 * than bypassed.
 *
 * The properties under test: the sender is always the verified user, a recipient
 * must be visible, and no query can reach a third party's messages.
 */
process.env.AUTH_TOKEN_SECRET ||= 'dm-selfcheck-secret-0123456789abcdefghij';
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
// 1 Alice, 2 Bob, 3 Carol — all visible. 4 Mallory — deactivated (invisible).
// 99 does not exist at all.
const users = new Map<number, { name: string; email: string; role: string; status: string }>([
  [1, { name: 'Alice', email: 'a@x.io', role: 'Developer', status: 'active' }],
  [2, { name: 'Bob', email: 'b@x.io', role: 'Developer', status: 'active' }],
  [3, { name: 'Carol', email: 'c@x.io', role: 'Developer', status: 'active' }],
  [4, { name: 'Mallory', email: 'm@x.io', role: 'Developer', status: 'inactive' }],
]);

interface Row {
  id: number; sender_id: number; recipient_id: number;
  message: string; created_at: Date; read_at: Date | null;
}
let table: Row[] = [];
let nextId = 1;
let clock = 0;
const stamp = () => new Date(Date.UTC(2026, 0, 1, 0, 0, clock++));

const visible = (id: number) => {
  const u = users.get(id);
  return !!u && !['inactive', 'deleted', 'disabled', 'suspended', 'banned', 'archived'].includes(u.status.toLowerCase());
};

const seed = (s: number, r: number, m: string, read = false) => {
  table.push({ id: nextId++, sender_id: s, recipient_id: r, message: m, created_at: stamp(), read_at: read ? stamp() : null });
};

const prisma = (await import('./config/db.js')).default as any;
const { VISIBLE_USER_PREDICATE } = await import('./services/userLookup.service.js');

/**
 * The in-memory engine reads the ACTUAL SQL rather than assuming what it says.
 * Each guard below is applied only when the corresponding clause is really
 * present in the statement, so deleting a clause from the service changes the
 * result here exactly as it would against Postgres — a test that enforced the
 * rules itself would keep passing after the rule was removed.
 */
const has = (sql: string, fragment: string) => sql.includes(fragment);
const runQuery = (sql: string, args: any[]): any[] => {
  // authenticate(): user row
  if (sql.includes('FROM users WHERE id = $1 LIMIT 1')) {
    const u = users.get(Number(args[0]));
    return u ? [{ id: Number(args[0]), role: u.role, status: u.status, must_change_password: false }] : [];
  }
  // findVisibleUser(): id + VISIBLE_USER_PREDICATE. The predicate is applied
  // ONLY if the statement actually carries it.
  if (sql.includes('SELECT id, name, email, role FROM users')) {
    const id = Number(args[0]);
    const u = users.get(id);
    if (!u) return [];
    if (has(sql, VISIBLE_USER_PREDICATE) && !visible(id)) return [];
    return [{ id, name: u.name, email: u.email, role: u.role }];
  }
  if (sql.includes('INSERT INTO direct_messages')) {
    const [s, r, m] = args;
    const row: Row = { id: nextId++, sender_id: Number(s), recipient_id: Number(r), message: String(m), created_at: stamp(), read_at: null };
    table.push(row);
    return [row];
  }
  // conversation(): both directions of ONE pair
  if (sql.includes('FROM direct_messages') && sql.includes('OR (sender_id = $2 AND recipient_id = $1)')) {
    const [a, b, limit] = args.map(Number);
    return table
      .filter((r) => (r.sender_id === a && r.recipient_id === b) || (r.sender_id === b && r.recipient_id === a))
      .sort((x, y) => y.created_at.getTime() - x.created_at.getTime() || y.id - x.id)
      .slice(0, limit)
      .sort((x, y) => x.created_at.getTime() - y.created_at.getTime() || x.id - y.id);
  }
  // unreadCount() — each condition honoured only if the SQL states it.
  if (sql.includes('SELECT COUNT(*)::int AS count FROM direct_messages')) {
    const me = Number(args[0]);
    const rows = table.filter((r) =>
      (has(sql, 'recipient_id = $1') ? r.recipient_id === me : true) &&
      (has(sql, 'read_at IS NULL') ? r.read_at === null : true));
    return [{ count: rows.length }];
  }
  // threads()
  if (sql.includes('WITH latest AS')) {
    const me = Number(args[0]);
    const mine = table.filter((r) => r.sender_id === me || r.recipient_id === me);
    const byOther = new Map<number, Row>();
    for (const r of mine.slice().sort((x, y) => x.created_at.getTime() - y.created_at.getTime() || x.id - y.id)) {
      byOther.set(r.sender_id === me ? r.recipient_id : r.sender_id, r);
    }
    const out: any[] = [];
    for (const [otherId, last] of byOther) {
      // The JOIN's VISIBLE_USER_PREDICATE — only if the statement carries it.
      if (has(sql, VISIBLE_USER_PREDICATE) && !visible(otherId)) continue;
      const u = users.get(otherId);
      if (!u) continue;
      out.push({
        other_id: otherId, message: last.message, created_at: last.created_at, sender_id: last.sender_id,
        unread_count: table.filter((r) => r.recipient_id === me && r.sender_id === otherId && r.read_at === null).length,
        name: u.name, email: u.email, role: u.role,
      });
    }
    return out.sort((a, b) => b.created_at.getTime() - a.created_at.getTime());
  }
  throw new Error(`selfcheck: unstubbed query: ${sql.slice(0, 90)}`);
};

prisma.$queryRawUnsafe = async (sql: string, ...args: any[]) => runQuery(sql, args);
prisma.$executeRawUnsafe = async (sql: string, ...args: any[]): Promise<number> => {
  // markRead(): recipient is ALWAYS the caller
  if (sql.includes('UPDATE direct_messages')) {
    const [me, other] = args.map(Number);
    let n = 0;
    for (const r of table) {
      // Drop any of these clauses from the service and this loop widens too.
      const match =
        (has(sql, 'recipient_id = $1') ? r.recipient_id === me : true) &&
        (has(sql, 'sender_id = $2') ? r.sender_id === other : true) &&
        (has(sql, 'read_at IS NULL') ? r.read_at === null : true);
      if (match) { r.read_at = stamp(); n++; }
    }
    return n;
  }
  throw new Error(`selfcheck: unstubbed exec: ${sql.slice(0, 90)}`);
};

const messageRoutes = (await import('./routes/messages.routes.js')).default;
const { issueToken } = await import('./utils/authToken.js');

// ── capture everything written to the console, for the logging assertions ──
const logged: string[] = [];
for (const stream of ['log', 'warn', 'error'] as const) {
  const original = console[stream].bind(console);
  console[stream] = (...a: any[]) => {
    logged.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x ?? ''))).join(' '));
    original(...a);
  };
}

// ── harness ───────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use('/api/messages', messageRoutes);
const httpServer = createServer(app);
await new Promise<void>((r) => httpServer.listen(0, r));
const base = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;

interface Res { status: number; body: string; json: any }
async function call(method: string, path: string, token?: string, body?: any): Promise<Res> {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, body: text, json };
}
const as = (id: number) => issueToken(id);

// ── AUTH (1-4) ────────────────────────────────────────────────────────────
{
  ok((await call('GET', '/api/messages/threads', as(1))).status === 200,
    '1 a valid authenticated user can access messaging');

  const noTok = await call('GET', '/api/messages/threads');
  ok(noTok.status === 401, '2a a request with no token is rejected');
  ok((await call('GET', '/api/messages/threads', 'garbage')).status === 401, '2b an invalid token is rejected');
  ok((await call('GET', '/api/messages/threads', 'user-token-1')).status === 401,
    '2c the old unsigned format is rejected');

  const p = as(1).split('.');
  ok((await call('GET', '/api/messages/threads', ['v1', '2', p[2], p[3], p[4]].join('.'))).status === 401,
    '3 a tampered token (id swapped, signature reused) is rejected');
}

// ── SEND + sender identity (4, 9-13) ──────────────────────────────────────
{
  const sent = await call('POST', '/api/messages/2', as(1), { message: 'hello bob' });
  ok(sent.status === 201, '9 a valid message is stored (201)');
  ok(sent.json?.senderId === 1 && sent.json?.recipientId === 2, '9b …with the right sender and recipient');

  // 4 + 13: the body tries to be somebody else.
  const forged = await call('POST', '/api/messages/2', as(3), {
    message: 'from carol, claiming to be alice',
    senderId: 1, sender_id: 1, sender: 1, userId: 1,
  });
  ok(forged.status === 201, '13a a body carrying senderId is still accepted…');
  ok(forged.json?.senderId === 3,
    '4/13b …but the stored sender is the VERIFIED user (3), not the body value (1)');
  ok(!table.some((r) => r.message.includes('claiming') && r.sender_id === 1),
    '13c …and no row exists attributing that message to the impersonated user');

  const q = await call('POST', '/api/messages/2?sender=1&userId=1', as(3), { message: 'query attempt' });
  ok(q.json?.senderId === 3, '13d a ?sender= query param cannot override the verified sender either');

  // 10-12 validation
  ok((await call('POST', '/api/messages/2', as(1), { message: '' })).status === 400, '10 an empty message is rejected');
  ok((await call('POST', '/api/messages/2', as(1), { message: '   \n\t  ' })).status === 400,
    '11 a whitespace-only message is rejected');
  ok((await call('POST', '/api/messages/2', as(1), { message: 'x'.repeat(4001) })).status === 400,
    '12 an oversized message is rejected');
  ok((await call('POST', '/api/messages/2', as(1), { message: 'x'.repeat(4000) })).status === 201,
    '12b …and one exactly at the limit is accepted');
  ok((await call('POST', '/api/messages/2', as(1), {})).status === 400, '10b a missing message field is rejected');
  ok((await call('POST', '/api/messages/2', as(1), { message: 42 })).status === 400, '10c a non-string message is rejected');
}

// ── RECIPIENT AUTHORIZATION (5-8) ─────────────────────────────────────────
{
  ok((await call('POST', '/api/messages/3', as(1), { message: 'hi carol' })).status === 201,
    '5 a visible recipient can be messaged');

  const invisible = await call('POST', '/api/messages/4', as(1), { message: 'hi mallory' });
  ok(invisible.status === 404, '6 a NON-visible recipient returns 404');

  const missing = await call('POST', '/api/messages/99', as(1), { message: 'hi ghost' });
  ok(missing.status === 404, '7a a non-existent recipient returns 404');
  ok(invisible.body === missing.body,
    '7b …byte-identical to the invisible case — user existence is NOT enumerable');
  ok(!invisible.body.toLowerCase().includes('mallory') && !invisible.body.includes('m@x.io'),
    '7c …and the rejection leaks no name, email, role or status');

  ok((await call('GET', '/api/messages/4', as(1))).status === 404, '6b history with an invisible user is 404 too');
  ok((await call('POST', '/api/messages/4/read', as(1))).status === 404, '6c …as is marking it read');

  const self = await call('POST', '/api/messages/1', as(1), { message: 'note to self' });
  ok(self.status === 400, '8 a user cannot message themselves');
  ok(!table.some((r) => r.sender_id === r.recipient_id), '8b …and no self-addressed row was written');

  for (const bad of ['abc', '-1', '0', '1.5', '9999999999', '%2e%2e']) {
    ok((await call('POST', `/api/messages/${bad}`, as(1), { message: 'x' })).status === 404,
      `8c a malformed recipient id is safely refused: ${bad}`);
  }
}

// ── HISTORY (14-16) ───────────────────────────────────────────────────────
{
  table = []; nextId = 1;
  seed(1, 2, 'alice→bob one');
  seed(2, 1, 'bob→alice two');
  seed(1, 3, 'alice→carol SECRET');
  seed(2, 3, 'bob→carol PRIVATE');
  seed(3, 2, 'carol→bob PRIVATE-REPLY');

  const conv = await call('GET', '/api/messages/2', as(1));
  ok(conv.status === 200, '14a Alice can read her conversation with Bob');
  const msgs = conv.json.messages as any[];
  ok(msgs.length === 2, '14b only the two messages of that pair are returned');
  ok(msgs.every((m) => (m.senderId === 1 && m.recipientId === 2) || (m.senderId === 2 && m.recipientId === 1)),
    '14c every returned row belongs to exactly that pair');
  ok(msgs[0].message === 'alice→bob one' && msgs[1].message === 'bob→alice two',
    '14d …in chronological order');

  ok(!conv.body.includes('SECRET') && !conv.body.includes('PRIVATE'),
    '15 messages involving unrelated users are never returned');

  // Carol's conversation with Bob must not appear in Alice's view of Bob.
  const carolBob = await call('GET', '/api/messages/2', as(3));
  ok(!carolBob.body.includes('alice→bob one'),
    '15b …and Carol cannot see Alice↔Bob through her own thread with Bob');

  ok((await call('GET', '/api/messages/2')).status === 401, '16 unauthenticated history access is rejected');
  ok((await call('GET', '/api/messages/99', as(1))).status === 404, '16b history with an unknown user is 404');
}

// ── READ STATE (17-19) ────────────────────────────────────────────────────
{
  table = []; nextId = 1;
  seed(2, 1, 'bob→alice unread');      // id 1 — Alice's inbox
  seed(1, 2, 'alice→bob unread');      // id 2 — Bob's inbox
  seed(3, 2, 'carol→bob unread');      // id 3 — Bob's inbox, from Carol

  const marked = await call('POST', '/api/messages/2/read', as(1));
  ok(marked.status === 200, '17a the recipient can mark messages received from Bob as read');
  ok(table.find((r) => r.id === 1)?.read_at !== null, '17b …and that message is now read');

  ok(table.find((r) => r.id === 2)?.read_at === null,
    '18 the caller did NOT mark the messages they themselves sent as read');
  ok(table.find((r) => r.id === 3)?.read_at === null,
    '19 an unrelated user\'s messages (Carol→Bob) remain unread');

  // Alice tries to clear Bob's inbox by naming Carol as the other party.
  await call('POST', '/api/messages/3/read', as(1));
  ok(table.find((r) => r.id === 3)?.read_at === null,
    '18b a user cannot clear another user\'s unread by naming their correspondent');
}

// ── THREADS (20-22) + UNREAD (23) ─────────────────────────────────────────
{
  table = []; nextId = 1;
  seed(2, 1, 'bob→alice older');
  seed(1, 2, 'alice→bob newer');
  seed(3, 1, 'carol→alice newest');
  seed(2, 3, 'bob→carol UNRELATED');
  seed(3, 2, 'carol→bob UNRELATED-TWO');
  seed(4, 1, 'mallory→alice hidden');   // sender is deactivated

  const t = await call('GET', '/api/messages/threads', as(1));
  ok(t.status === 200, '20a threads load for the authenticated user');
  const threads = t.json as any[];
  ok(threads.every((x) => [2, 3].includes(x.user.id)),
    '20b only the caller\'s own conversation partners are returned');
  ok(!t.body.includes('UNRELATED'), '20c no message from an unrelated conversation appears');
  ok(!t.body.includes('Mallory') && !t.body.includes('hidden'),
    '20d a deactivated partner is filtered out by the visibility join');

  ok(threads[0].user.id === 3 && threads[0].lastMessage === 'carol→alice newest',
    '21 the newest conversation is first and its latest message is correct');
  const bobThread = threads.find((x) => x.user.id === 2);
  ok(bobThread.lastMessage === 'alice→bob newer' && bobThread.lastMessageSenderId === 1,
    '21b …including a thread whose latest message the caller sent');

  ok(bobThread.unreadCount === 1, '22a unread count counts only messages received from that partner');
  ok(threads.find((x) => x.user.id === 3).unreadCount === 1, '22b …per thread');

  const unread = await call('GET', '/api/messages/unread-count', as(1));
  ok(unread.json?.count === 3, '23a unread-count counts only rows addressed to the caller');
  const bobUnread = await call('GET', '/api/messages/unread-count', as(2));
  ok(bobUnread.json?.count === 2, '23b …and is computed per user, not globally');
  ok((await call('GET', '/api/messages/unread-count')).status === 401, '23c unauthenticated is rejected');
}

// ── SECURITY: logging (24-25) ─────────────────────────────────────────────
{
  const SECRET = 'TOP-SECRET-MESSAGE-BODY-XYZ';
  const token = as(1);
  await call('POST', '/api/messages/2', token, { message: SECRET });
  await call('GET', '/api/messages/2', token);
  await call('POST', '/api/messages/4', token, { message: SECRET }); // 404 path
  await call('POST', '/api/messages/2', token, { message: '' });     // 400 path

  const all = logged.join('\n');
  ok(!all.includes(SECRET), '24 no private message body appears anywhere in the logs');
  ok(!all.includes(token), '25a no authentication token appears in the logs');
  const sigs = token.split('.');
  ok(!all.includes(sigs[4]), '25b …not even the signature fragment');
}

// ── rate limiting is actually wired to send ───────────────────────────────
{
  table = []; nextId = 1;
  let limited = false;
  for (let i = 0; i < 40; i++) {
    const r = await call('POST', '/api/messages/2', as(3), { message: `flood ${i}` });
    if (r.status === 429) { limited = true; break; }
  }
  ok(limited, 'the send endpoint rate-limits a flooding sender (429)');
  const other = await call('GET', '/api/messages/threads', as(3));
  ok(other.status === 200, '…without limiting that user\'s other messaging endpoints');
}

// ── teardown ──────────────────────────────────────────────────────────────
httpServer.close();
if (failed) {
  console.error(`\n${failed} direct-messaging self-check(s) FAILED`);
  process.exit(1);
}
console.log('\nAll direct-messaging self-checks passed.');
process.exit(0);
