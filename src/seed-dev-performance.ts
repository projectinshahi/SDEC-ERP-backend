import prisma from './config/db.js';
import crypto from 'crypto';

async function main() {
  console.log('Seeding developer performance data...');
  
  // 1. Create or get developers
  const devRole = 'Developer';
  const devsData = [
    { name: 'Alex Frontend', email: 'alex@dev.com', role: devRole, status: 'active' },
    { name: 'Sam Backend', email: 'sam@dev.com', role: devRole, status: 'active' },
    { name: 'Taylor Fullstack', email: 'taylor@dev.com', role: devRole, status: 'active' },
  ];
  
  const devUsers = [];
  for (const data of devsData) {
    let u = await prisma.users.findUnique({ where: { email: data.email } });
    if (!u) {
      u = await prisma.users.create({
        data: {
          name: data.name,
          email: data.email,
          password: 'password123',
          role: data.role,
          status: data.status,
        }
      });
    }
    devUsers.push(u);
  }

  // 2. Ensure project exists
  let project = await prisma.projects.findFirst();
  if (!project) {
    project = await prisma.projects.create({
      data: {
        id: crypto.randomUUID(),
        name: "SDEC Performance Analytics",
        description: "Building developer dashboard",
        category: "Internal",
        status: "In Progress"
      }
    });
  }

  // 3. Add to project members
  for (const u of devUsers) {
    const existingMem = await prisma.project_members.findFirst({
      where: { project_id: project.id, user_id: u.id }
    });
    if (!existingMem) {
      await prisma.project_members.create({
        data: {
          project_id: project.id,
          user_id: u.id,
          role: 'Developer',
          capacity_points: 10,
        }
      });
    }
  }

  // 4. Ensure Kanban Board and Columns
  let board = await prisma.kanban_boards.findFirst({
    where: { projectId: project.id }
  });
  if (!board) {
    board = await prisma.kanban_boards.create({
      data: {
        projectId: project.id,
        name: 'Main Board',
        description: 'Main Kanban Board'
      }
    });
  }

  const columnsData = ['Todo', 'In Progress', 'Review', 'QA', 'Done'];
  const columns = [];
  for (let i = 0; i < columnsData.length; i++) {
    let col = await prisma.kanban_columns.findFirst({
      where: { board_id: board.id, label: columnsData[i] }
    });
    if (!col) {
      col = await prisma.kanban_columns.create({
        data: {
          id: crypto.randomUUID(),
          board_id: board.id,
          label: columnsData[i],
          order_index: i,
        }
      });
    }
    columns.push(col);
  }

  // 5. Create some tasks and activity logs for Velocity/Delivery metrics
  // Let's create some tasks assigned to devs
  const now = Date.now();
  const dayMs = 86400000;
  
  const tasksToCreate = [
    { title: 'Setup DB', assignee: 'Alex Frontend', storyPoints: 5, col: 'Done', offsetDays: -14 },
    { title: 'Create UI', assignee: 'Alex Frontend', storyPoints: 8, col: 'Done', offsetDays: -7 },
    { title: 'Fix Header', assignee: 'Alex Frontend', storyPoints: 2, col: 'Todo', offsetDays: 0 },
    { title: 'API Integration', assignee: 'Sam Backend', storyPoints: 13, col: 'Done', offsetDays: -10 },
    { title: 'Auth flow', assignee: 'Sam Backend', storyPoints: 8, col: 'Done', offsetDays: -2 },
    { title: 'Optimize Queries', assignee: 'Sam Backend', storyPoints: 5, col: 'In Progress', offsetDays: 0 },
    { title: 'Deploy Staging', assignee: 'Taylor Fullstack', storyPoints: 3, col: 'Done', offsetDays: 0 },
    { title: 'Write Tests', assignee: 'Taylor Fullstack', storyPoints: 5, col: 'Review', offsetDays: -1 },
    { title: 'Dockerize', assignee: 'Taylor Fullstack', storyPoints: 8, col: 'QA', offsetDays: -5 },
  ];

  for (const t of tasksToCreate) {
    const dueDate = new Date(now + (5 * dayMs)); // Due in 5 days
    const createdDate = new Date(now + (t.offsetDays * dayMs));
    
    // Find the dev
    const dev = devUsers.find(u => u.name === t.assignee);
    const col = columns.find(c => c.label === t.col);
    
    const task = await prisma.kanban_tasks.create({
      data: {
        id: crypto.randomUUID(),
        title: t.title,
        description: 'Task description',
        board_id: board.id,
        status: String(col!.id),
        assignee: t.assignee,
        storyPoints: t.storyPoints,
        dueDate: dueDate.toISOString(),
        order_index: 0,
        priority: "Medium",
      }
    });

    // Create activity logs to populate velocity chart
    // Creation log
    await prisma.activity_logs.create({
      data: {
        project_id: project.id,
        actor_user_id: dev!.id,
        task_id: task.id,
        type: 'task_created',
        description: `Created task ${t.title}`,
        created_at: createdDate
      }
    });

    // If done, create a completion log recently (if it's offset 0, it means today)
    if (t.col === 'Done') {
      const doneDate = new Date(now + ((t.offsetDays + 1) * dayMs));
      await prisma.activity_logs.create({
        data: {
          project_id: project.id,
          actor_user_id: dev!.id,
          task_id: task.id,
          type: 'task_moved_to_done',
          description: `Completed task ${t.title}`,
          created_at: doneDate
        }
      });
    }
  }

  // 6. Create some bugs
  const bugsData = [
    { title: 'Login fails', assignedTo: 'Alex Frontend', status: 'open' },
    { title: 'Crash on dashboard', assignedTo: 'Sam Backend', status: 'resolved' },
    { title: 'Typo in header', assignedTo: 'Taylor Fullstack', status: 'open' },
  ];
  
  for (const b of bugsData) {
    await prisma.bugs.create({
      data: {
        title: b.title,
        project_id: project.id,
        assignedTo: b.assignedTo,
        status: b.status,
        severity: 'high',
        description: 'Bug description'
      }
    });
  }
  
  console.log('Seeding completed!');
}

main()
  .catch(e => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
