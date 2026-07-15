const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function run() {
  const users = await prisma.users.findMany();
  console.log(JSON.stringify(users, null, 2));
}

run().finally(() => prisma.$disconnect());
