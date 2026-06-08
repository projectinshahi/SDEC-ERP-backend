import prisma from './src/config/db.js';

async function main() {
  const notifs = await prisma.notifications.findMany({ orderBy: { id: 'desc' }, take: 5 });
  console.log(notifs);
}

main().finally(() => prisma.$disconnect());
