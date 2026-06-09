const fs = require('fs');

const file = 'd:/SDEC/erp/SDEC-ERP-backend/src/controllers/project.controller.ts';
let content = fs.readFileSync(file, 'utf8');

const newCode = `      const [totalTasks, activeTasks, completedTasks, openBugs, teamMembers] = await Promise.all([
        prisma.kanban_tasks.count({
          where: { board: { projectId } }
        }),
        prisma.kanban_tasks.count({
          where: {
            board: { projectId },
            NOT: {
              OR: [
                { status: { equals: 'done', mode: 'insensitive' } },
                { status: { equals: 'completed', mode: 'insensitive' } },
                { status: { equals: 'closed', mode: 'insensitive' } },
                { status: { equals: 'resolved', mode: 'insensitive' } }
              ]
            }
          }
        }),
        prisma.kanban_tasks.count({
          where: {
            board: { projectId },
            OR: [
              { status: { equals: 'done', mode: 'insensitive' } },
              { status: { equals: 'completed', mode: 'insensitive' } },
              { status: { equals: 'closed', mode: 'insensitive' } },
              { status: { equals: 'resolved', mode: 'insensitive' } }
            ]
          }
        }),
        prisma.bugs.count({
          where: { 
            project_id: projectId,
            OR: [
              { status: { equals: 'open', mode: 'insensitive' } },
              { status: { equals: 'new', mode: 'insensitive' } }
            ]
          }
        }),
        prisma.project_members.count({
          where: { project_id: projectId }
        })
      ]);`;

const pattern = /const \[totalTasks, activeTasks, completedTasks, openBugs, teamMembers\] = await Promise\.all\(\[[\s\S]*?prisma\.project_members\.count\(\{\s*where: \{\s*project_id: projectId\s*\}\s*\}\)\s*\]\);/g;

content = content.replace(pattern, newCode);
fs.writeFileSync(file, content);
