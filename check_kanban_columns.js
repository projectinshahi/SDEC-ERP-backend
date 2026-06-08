const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
async function main() {
  const cols = await prisma.kanban_columns.findMany();
  console.log(cols);
}
main().catch(console.error).finally(() => prisma.$disconnect());
