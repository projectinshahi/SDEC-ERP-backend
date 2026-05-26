const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
async function main() {
  const users = await prisma.users.findMany();
  console.log('USERS:', users.map(u => ({ id: u.id, name: u.name, role: u.role })));
  const roles = await prisma.roles.findMany();
  console.log('ROLES:', roles.map(r => ({ id: r.id, name: r.name, permissions: r.permissions })));
}
main().finally(() => prisma.$disconnect());
