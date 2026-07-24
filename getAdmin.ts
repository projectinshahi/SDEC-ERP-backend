import prisma from './src/config/db.js';

async function run() {
  const admin = await prisma.roles.findFirst({ where: { name: 'admin' } });
  console.log(admin);
}

run().finally(() => prisma.$disconnect());
