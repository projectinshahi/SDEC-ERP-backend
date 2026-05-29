import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  try {
    const tasks = await prisma.kanban_tasks.findMany({
      where: { board_id: 4 },
      orderBy: { order_index: 'asc' }
    });
    console.log("Success:", tasks.length);
  } catch (e) {
    console.error("ERROR:");
    console.error(e);
  } finally {
    await prisma.$disconnect();
  }
}

main();
