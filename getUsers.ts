import prisma from './src/config/db.js';

async function run() {
  const users = await prisma.users.findMany({
    select: { id: true, name: true, email: true, role: true }
  });
  console.log(users.map(u => ({ id: u.id, email: u.email, role: u.role })));
}
run().finally(() => { prisma.$disconnect(); });
