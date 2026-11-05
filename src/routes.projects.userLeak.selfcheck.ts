/**
 * Runnable regression check: project endpoints never serialize member users'
 * secrets (password hash, resetPasswordToken).
 *   npx tsx src/routes.projects.userLeak.selfcheck.ts
 *
 * Drives the REAL /projects router (authenticate + controller) over HTTP. The
 * DB is stubbed with FULL users rows — exactly what `include: { user: true }`
 * loads — so the check fails if formatProject ever spreads them again.
 */
process.env.AUTH_TOKEN_SECRET ||= 'projects-leak-selfcheck-secret-0123456789abcdef';
process.env.NODE_ENV ||= 'test';

import express from 'express';
import { createServer } from 'http';
import type { AddressInfo } from 'net';

let failed = 0;
const ok = (cond: boolean, label: string) => {
  if (cond) console.log(`✓ ${label}`);
  else { console.error(`✗ ${label}`); failed++; }
};

const fullUser = (id: number, name: string) => ({
  id, name, email: `${name.toLowerCase().replace(/\s/g, '.')}@sdec.test`, role: 'Developer', status: 'active',
  password: `HASH-SECRET-${id}`, resetPasswordToken: `RESET-SECRET-${id}`, resetPasswordExpires: new Date(), must_change_password: false,
});
const project = {
  id: 'p1', name: 'ERP Revamp', status: 'active', category: 'Internal', owner_id: 2, createdAt: new Date(),
  owner: fullUser(2, 'Dev Member'),
  project_members: [{ id: 11, project_id: 'p1', user_id: 2, role: 'editor', capacity_points: 5, user: fullUser(2, 'Dev Member') }],
};

const prisma = (await import('./config/db.js')).default as any;
prisma.$queryRawUnsafe = async (sql: string, ...args: any[]): Promise<any[]> => {
  if (sql.includes('FROM users')) return [2, 3].includes(Number(args[0])) ? [{ id: Number(args[0]), role: 'Developer', status: 'active', must_change_password: false }] : [];
  if (sql.includes('FROM roles')) return [{ permissions: ['project.read'] }];
  throw new Error(`selfcheck: unstubbed query: ${sql.slice(0, 80)}`);
};
Object.defineProperty(prisma, 'projects', {
  value: { findMany: async () => [structuredClone(project)], findUnique: async () => structuredClone(project) },
  configurable: true, writable: true,
});

const { issueToken } = await import('./utils/authToken.js');
const routes = (await import('./routes/project.routes.js')).default;
const app = express();
app.use(express.json());
app.use('/projects', routes);
const server = createServer(app);
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/projects`;
const get = async (userId: number, path = '') => {
  const res = await fetch(base + path, { headers: { Authorization: `Bearer ${issueToken(userId)}` } });
  const text = await res.text();
  return { status: res.status, text, json: JSON.parse(text || 'null') };
};
const noSecrets = (text: string) => !/HASH-SECRET|RESET-SECRET|"password"|resetPassword/i.test(text);

try {
  const list = await get(2);
  const p = list.json?.[0];
  ok(list.status === 200 && noSecrets(list.text), 'GET /projects: no password hash / resetPasswordToken anywhere in the response');
  ok(p?.name === 'ERP Revamp' && p.status === 'active' && p.category === 'Internal', 'GET /projects: project details still returned');
  ok(p?.members?.[0] === 'Dev Member' && p.memberDetails?.[0]?.email === 'dev.member@sdec.test' && p.memberDetails[0].role === 'editor' && p.memberDetails[0].capacityPoints === 5,
     'GET /projects: members + memberDetails (what the project screens read) intact');
  ok(JSON.stringify(p?.project_members?.[0]?.user) === JSON.stringify({ id: 2, name: 'Dev Member', email: 'dev.member@sdec.test' }) && p.project_members[0].role === 'editor',
     'GET /projects: project_members keeps its shape, user reduced to id/name/email');
  ok(JSON.stringify(p?.owner) === JSON.stringify({ id: 2, name: 'Dev Member' }), 'GET /projects: owner reduced to id/name');

  const one = await get(2, '/p1');
  ok(one.status === 200 && noSecrets(one.text) && one.json?.memberDetails?.length === 1, 'GET /projects/:id (member): details returned, no secrets');
  ok((await get(3, '/p1')).status === 403, 'GET /projects/:id (non-member): still 403');
} finally {
  server.close();
}

if (failed) {
  console.error(`\n${failed} project leak check(s) FAILED`);
  process.exit(1);
}
console.log('\nAll project user-leak checks passed');
process.exit(0);
