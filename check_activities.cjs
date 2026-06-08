const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
async function main() {
  const activities = await prisma.activity_logs.findMany({
    take: 5,
    orderBy: { created_at: 'desc' },
    include: { actor: true }
  });
  console.log(JSON.stringify(activities, null, 2));
}
main().catch(console.error).finally(() => prisma.$disconnect());
