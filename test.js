import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
prisma.kanban_tasks.findMany().then(console.log).catch(console.error).finally(() => prisma.$disconnect());
