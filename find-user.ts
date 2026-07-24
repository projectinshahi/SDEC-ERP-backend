import 'dotenv/config';
import prisma from './src/config/db.js';

async function main() {
  const users = await prisma.users.findMany();
  for (const u of users) {
    if (!u.role) continue;
    const role = await prisma.roles.findUnique({ where: { name: u.role } });
    if (!role) continue;
    const perms = role.permissions;
    const p = Array.isArray(perms) ? perms : [];
    if (
      p.includes('hr.leave.self') &&
      !p.includes('hr.view') &&
      (p.some(x => x.startsWith('sales.')) || p.some(x => x.startsWith('development.')) || p.some(x => x.startsWith('project.')))
    ) {
      console.log('Found user:', u.name, u.email, u.role, p);
    }
  }
}

main().catch(console.error).finally(() => prisma.$disconnect());
