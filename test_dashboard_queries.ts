import 'dotenv/config';
import prisma from './src/config/db.js';

async function test() {
  try {
    const PROJECT_ACTIVE = ['active', 'in_progress', 'in-progress', 'ongoing'];
    const PROJECT_COMPLETED = ['completed', 'complete', 'done', 'closed'];
    const PROJECT_ONHOLD = ['on-hold', 'on_hold', 'onhold', 'paused', 'hold'];

    const TICKET_RESOLVED = ['resolved', 'closed', 'done', 'completed'];
    const CRITICAL_LEVELS = ['critical', 'urgent', 'high'];

    const BUG_OPEN = ['open', 'new', 'in_progress', 'in-progress', 'reopened'];
    const BUG_RESOLVED = ['resolved', 'closed', 'done', 'fixed'];

    console.log("Testing Wave 1 queries...");
    await prisma.projects.count();
    await prisma.projects.count({ where: { status: { in: PROJECT_ACTIVE, mode: 'insensitive' } } });
    await prisma.projects.count({ where: { is_archived: true } });
    await prisma.blocker.count();
    await prisma.bugs.count();
    await prisma.lead.count();
    await prisma.opportunity.count();
    await prisma.deal.count();
    await prisma.deal.aggregate({ _sum: { amount: true }, _count: { _all: true }, where: { status: 'won' } });
    await prisma.meeting.count();
    await prisma.users.count();
    await prisma.kanban_tasks.count();
    console.log("Wave 1 queries passed.");

    console.log("Testing Wave 2 queries...");
    await prisma.projects.findMany({ select: { id: true, status: true, is_archived: true } });
    await prisma.blocker.findMany({ select: { status: true, severity: true } });
    await prisma.bugs.findMany({ select: { priority: true } });
    await prisma.deal.findMany({ select: { stage: true, amount: true, status: true, closedAt: true, updatedAt: true } });
    await prisma.lead.findMany({ select: { source: true } });
    await prisma.activity_logs.findMany({ take: 1 });
    await prisma.kanban_boards.findMany({ select: { projectId: true, endDate: true } });
    console.log("Wave 2 queries passed.");

  } catch (error) {
    console.error("Test failed:", error);
  } finally {
    process.exit(0);
  }
}

test();
