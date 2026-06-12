import prisma from './src/config/db';

async function main() {
  const count25 = await prisma.kanban_tasks.count({ where: { board_id: 25 } });
  const count29 = await prisma.kanban_tasks.count({ where: { board_id: 29 } });
  console.log('Tasks in 25 (Sprint 5):', count25);
  console.log('Tasks in 29 (Project Board):', count29);
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
