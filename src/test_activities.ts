import * as dotenv from 'dotenv';
dotenv.config();

async function run() {
  const { default: prisma } = await import('./config/db.js');
  console.log("DB_URL:", process.env.DATABASE_URL);
  try {
    const projectId = "P-2024-001";
    console.log("Fetching project boards...");
    const projectBoards = await prisma.kanban_boards.findMany({
      where: { projectId },
      select: { id: true }
    });
    const boardIds = projectBoards.map((b) => b.id);
    console.log("Boards:", boardIds);

    let taskIds: string[] = [];
    if (boardIds.length > 0) {
      const projectTasks = await prisma.kanban_tasks.findMany({
        where: { board_id: { in: boardIds } },
        select: { id: true }
      });
      taskIds = projectTasks.map((t) => t.id);
    }
    console.log("Tasks:", taskIds.length);

    const projectBlockers = await prisma.blocker.findMany({
      where: { projectId },
      select: { id: true }
    });
    const blockerIds = projectBlockers.map((b) => b.id);
    console.log("Blockers:", blockerIds.length);

    const orConditions: any[] = [
      { project_id: projectId }
    ];
    if (taskIds.length > 0) {
      orConditions.push({ task_id: { in: taskIds } });
    }
    if (blockerIds.length > 0) {
      orConditions.push({ blocker_id: { in: blockerIds } });
    }

    console.log("Querying activity_logs with OR:", JSON.stringify(orConditions));
    const activities = await prisma.activity_logs.findMany({
      where: { OR: orConditions },
      orderBy: { created_at: 'desc' },
      take: 20,
      include: {
        actor: { select: { id: true, name: true, email: true } },
        target: { select: { id: true, name: true, email: true } },
        project: { select: { id: true, name: true } },
        task: { select: { id: true, title: true } }
      }
    });

    console.log("Found activities:", activities.length);
  } catch(e) {
    console.error("Prisma Error:", e);
  } finally {
    await prisma.$disconnect();
  }
}
run();
