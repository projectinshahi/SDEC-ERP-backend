import { Request, Response } from 'express';
import prisma from '../config/db.js';
import { activityService } from '../services/activity.service.js';

/**
 * Helper to fetch a project with its members and format it for the frontend
 */
async function formatProject(project: any) {
  return {
    ...project,
    members: project.project_members ? project.project_members.map((pm: any) => pm.user?.name || `User ${pm.user_id}`) : [],
  };
}

export const getProjects = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    const userRole = ((req as any).userRole || '').toLowerCase();

    // Super Admin / Admin bypass
    const isAdmin = userRole === 'super admin' || userRole === 'admin';

    const dbProjects = await prisma.projects.findMany({
      where: isAdmin ? undefined : {
        project_members: {
          some: { user_id: userId }
        }
      },
      include: {
        project_members: {
          include: { user: true }
        }
      },
      orderBy: { createdAt: 'desc' }
    });

    const formatted = await Promise.all(dbProjects.map(formatProject));
    res.status(200).json(formatted);
  } catch (error) {
    console.error('Error fetching projects:', error);
    res.status(500).json({ error: 'Failed to fetch projects' });
  }
};

export const createProject = async (req: Request, res: Response) => {
  try {
    const userRole = ((req as any).userRole || '').toLowerCase();
    if (userRole !== 'super admin' && userRole !== 'admin') {
      return res.status(403).json({ success: false, message: 'Forbidden: Only global Admins can create projects' });
    }

    const { name, description, status, startDate, members } = req.body as any;
    if (!name) return res.status(400).json({ success: false, message: 'Project Name is required' });

    let numericMemberIds: number[] = [];
    if (Array.isArray(members)) {
      numericMemberIds = members.map(m => Number(m)).filter(m => !isNaN(m));
    }

    const userId = (req as any).userId;
    if (userId && !numericMemberIds.includes(userId)) {
      numericMemberIds.push(userId);
    }

    if (numericMemberIds.length === 0) numericMemberIds = [1];

    const newProject = await prisma.projects.create({
      data: {
        id: `prj-${Date.now()}`,
        name,
        description: description || '',
        status: status || 'active',
        startDate: startDate || new Date().toISOString().split('T')[0],
        project_members: {
          create: numericMemberIds.map(uid => ({
            user_id: uid,
            role: 'admin' // Creator gets admin
          }))
        }
      },
      include: {
        project_members: { include: { user: true } }
      }
    });

    if (userId) {
      await activityService.logActivity({
        actorUserId: userId,
        projectId: newProject.id,
        type: 'project_created',
        description: `Created project '${newProject.name}'`
      });
    }

    res.status(201).json({ success: true, data: await formatProject(newProject) });
  } catch (error) {
    console.error('Error creating project:', error);
    res.status(500).json({ success: false, message: 'Server error creating project' });
  }
};

export const getProjectById = async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    const userId = (req as any).userId;
    const userRole = ((req as any).userRole || '').toLowerCase();

    const isAdmin = userRole === 'super admin' || userRole === 'admin';

    const project = await prisma.projects.findUnique({
      where: { id },
      include: { project_members: { include: { user: true } } }
    });

    if (!project) return res.status(404).json({ error: 'Project not found' });

    if (!isAdmin) {
      const isMember = project.project_members.some((pm: any) => pm.user_id === userId);
      if (!isMember) {
        return res.status(403).json({ error: 'Forbidden: You do not have access to this project' });
      }
    }

    res.status(200).json(await formatProject(project));
  } catch (error) {
    console.error('Error fetching project by ID:', error);
    res.status(500).json({ error: 'Failed to fetch project' });
  }
};

export const updateProject = async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    const { name, description, status, startDate, endDate, members } = req.body as any;

    if (!name) return res.status(400).json({ success: false, message: 'Project Name is required' });
    if (!startDate) return res.status(400).json({ success: false, message: 'Start Date is required' });
    if (endDate && startDate && new Date(endDate) < new Date(startDate)) {
      return res.status(400).json({ success: false, message: 'End date must be on or after start date' });
    }

    const existingProject = await prisma.projects.findUnique({ where: { id } });
    if (!existingProject) return res.status(404).json({ success: false, message: 'Project not found' });

    const updateData: any = {
      name,
      description: description || '',
      status: status || existingProject.status,
      startDate,
      endDate: endDate || null,
    };

    if (Array.isArray(members)) {
      const numericMemberIds = members.map(m => Number(m)).filter(m => !isNaN(m));
      updateData.project_members = {
        deleteMany: {},
        create: numericMemberIds.map(uid => ({ user_id: uid, role: 'editor' }))
      };
    }

    const updatedProject = await prisma.projects.update({
      where: { id },
      data: updateData,
      include: { project_members: { include: { user: true } } }
    });

    const userId = (req as any).userId;
    if (userId) {
      await activityService.logActivity({
        actorUserId: userId,
        projectId: updatedProject.id,
        type: 'project_updated',
        description: `Updated project '${updatedProject.name}'`
      });
    }

    res.status(200).json({ success: true, message: 'Project updated successfully', data: await formatProject(updatedProject) });
  } catch (error) {
    console.error('Error updating project:', error);
    res.status(500).json({ success: false, message: 'Server error updating project' });
  }
};

export const archiveProject = async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    const project = await prisma.projects.update({
      where: { id },
      data: { is_archived: true },
      include: { project_members: { include: { user: true } } }
    });
    res.status(200).json({ success: true, message: 'Project archived successfully', data: await formatProject(project) });
  } catch (error) {
    console.error('Error archiving project:', error);
    res.status(500).json({ error: 'Failed to archive project' });
  }
};

export const restoreProject = async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    const project = await prisma.projects.update({
      where: { id },
      data: { is_archived: false },
      include: { project_members: { include: { user: true } } }
    });
    res.status(200).json({ success: true, message: 'Project restored successfully', data: await formatProject(project) });
  } catch (error) {
    console.error('Error restoring project:', error);
    res.status(500).json({ error: 'Failed to restore project' });
  }
};

export const deleteProject = async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;

    // Get project name before deletion for the log message
    const project = await prisma.projects.findUnique({
      where: { id },
      select: { name: true }
    });

    await prisma.projects.delete({ where: { id } });

    const userId = (req as any).userId;
    if (userId && project) {
      await activityService.logActivity({
        actorUserId: userId,
        projectId: undefined,
        type: 'project_deleted',
        description: `Deleted project '${project.name}'`
      });
    }

    res.status(200).json({ success: true, message: 'Project permanently deleted successfully' });
  } catch (error: any) {
    if (error.code === 'P2025') return res.status(404).json({ error: 'Project not found' });
    console.error('Error permanently deleting project:', error);
    res.status(500).json({ error: 'Failed to permanently delete project' });
  }
};

export const getProjectMembers = async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    const members = await prisma.project_members.findMany({
      where: { project_id: id },
      include: { user: true }
    });

    const result = members.map((pm: any) => ({
      id: pm.id,
      project_id: pm.project_id,
      userId: pm.user_id,
      role: pm.role,
      name: pm.user?.name || `User ${pm.user_id}`,
      email: pm.user?.email || `user${pm.user_id}@example.com`
    }));

    res.status(200).json(result);
  } catch (error) {
    console.error('Error fetching project members:', error);
    res.status(500).json({ error: 'Failed to fetch project members' });
  }
};

export const addProjectMember = async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    const { userId, role } = req.body;

    if (!userId || !role) return res.status(400).json({ error: 'User ID and role are required' });
    if (!['admin', 'editor', 'viewer'].includes(role)) return res.status(400).json({ error: 'Invalid role' });

    const existing = await prisma.project_members.findUnique({
      where: {
        project_id_user_id: { project_id: id, user_id: Number(userId) }
      }
    });

    if (existing) return res.status(400).json({ error: 'User is already a member of this project' });

    const newMember = await prisma.project_members.create({
      data: { project_id: id, user_id: Number(userId), role }
    });

    const actorId = (req as any).userId;
    if (actorId) {
      await activityService.logActivity({
        actorUserId: actorId,
        targetUserId: Number(userId),
        projectId: id,
        type: 'member_added',
        description: `Added a member to the project`
      });
    }

    res.status(201).json({ success: true, message: 'Member added successfully', data: { id: newMember.id, project_id: id, userId: Number(userId), role } });
  } catch (error) {
    console.error('Error adding project member:', error);
    res.status(500).json({ error: 'Failed to add project member' });
  }
};

export const updateProjectMemberRole = async (req: Request, res: Response) => {
  try {
    const memberId = req.params.memberId as string;
    const { role } = req.body;

    if (!role || !['admin', 'editor', 'viewer'].includes(role)) return res.status(400).json({ error: 'Invalid role' });

    await prisma.project_members.update({
      where: { id: Number(memberId) },
      data: { role }
    });

    res.status(200).json({ success: true, message: 'Role updated successfully' });
  } catch (error: any) {
    if (error.code === 'P2025') return res.status(404).json({ error: 'Member not found' });
    console.error('Error updating member role:', error);
    res.status(500).json({ error: 'Failed to update member role' });
  }
};

export const removeProjectMember = async (req: Request, res: Response) => {
  try {
    const memberId = req.params.memberId as string;

    await prisma.project_members.delete({
      where: { id: Number(memberId) }
    });

    const actorId = (req as any).userId;
    if (actorId) {
      await activityService.logActivity({
        actorUserId: actorId,
        projectId: undefined,
        type: 'member_removed',
        description: `Removed a member from the project`
      });
    }

    res.status(200).json({ success: true, message: 'Member removed successfully' });
  } catch (error: any) {
    if (error.code === 'P2025') return res.status(404).json({ error: 'Member not found' });
    console.error('Error removing member:', error);
    res.status(500).json({ error: 'Failed to remove member' });
  }
};

// --- Scoped Data Controllers ---

export const getProjectBoards = async (req: Request, res: Response) => {
  try {
    const projectId = req.params.id as string;
    const boards = await prisma.kanban_boards.findMany({
      where: { projectId },
      orderBy: { createdAt: 'desc' }
    });
    res.status(200).json(boards);
  } catch (error) {
    console.error('Error fetching project boards:', error);
    res.status(500).json({ error: 'Failed to fetch project boards' });
  }
};

export const getProjectTasks = async (req: Request, res: Response) => {
  try {
    const projectId = req.params.id as string;
    // Fetch tasks where the board belongs to this project OR the sprint belongs to this project
    const tasks = await prisma.kanban_tasks.findMany({
      where: {
        OR: [
          { board: { projectId } },
          { sprint: { projectId } }
        ]
      },
      orderBy: { order_index: 'asc' }
    });

    const formatted = tasks.map((t: any) => ({
      id: t.id,
      title: t.title,
      description: t.description,
      priority: t.priority,
      assignee: t.assignee,
      status: t.status,
      dueDate: t.dueDate,
      storyPoints: t.storyPoints,
      boardId: t.board_id,
      sprintId: t.sprintId,
      originTaskId: t.originTaskId
    }));

    res.status(200).json(formatted);
  } catch (error) {
    console.error('Error fetching project tasks:', error);
    res.status(500).json({ error: 'Failed to fetch project tasks' });
  }
};

export const getProjectBugs = async (req: Request, res: Response) => {
  try {
    const projectId = req.params.id as string;
    const bugs = await prisma.bugs.findMany({
      where: { project_id: projectId },
      orderBy: { createdAt: 'desc' }
    });
    res.status(200).json({ success: true, data: bugs });
  } catch (error) {
    console.error('Error fetching project bugs:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch project bugs' });
  }
};

export const getProjectDashboardStats = async (req: Request, res: Response) => {
  try {
    const projectId = req.params.id as string;

    const [totalTasks, activeTasks, completedTasks, openBugs, teamMembers] = await Promise.all([
      prisma.kanban_tasks.count({
        where: { OR: [{ board: { projectId } }, { sprint: { projectId } }] }
      }),
      prisma.kanban_tasks.count({
        where: {
          OR: [{ board: { projectId } }, { sprint: { projectId } }],
          status: { notIn: ['done', 'completed', 'resolved'] }
        }
      }),
      prisma.kanban_tasks.count({
        where: {
          OR: [{ board: { projectId } }, { sprint: { projectId } }],
          status: { in: ['done', 'completed', 'resolved'] }
        }
      }),
      prisma.bugs.count({
        where: { project_id: projectId, status: 'open' }
      }),
      prisma.project_members.count({
        where: { project_id: projectId }
      })
    ]);

    res.status(200).json({
      totalTasks,
      activeTasks,
      completedTasks,
      openBugs,
      teamMembers
    });
  } catch (error) {
    console.error('Error fetching dashboard stats:', error);
    res.status(500).json({ error: 'Failed to fetch dashboard stats' });
  }
};

export const getProjectActivities = async (req: Request, res: Response) => {
  try {
    const projectId = req.params.id as string;
    const limit = parseInt((req.query.limit as string) || '20');

    const activities = await prisma.activity_logs.findMany({
      where: { project_id: projectId },
      orderBy: { created_at: 'desc' },
      take: limit,
      include: {
        actor: { select: { id: true, name: true, email: true } },
        target: { select: { id: true, name: true, email: true } },
        project: { select: { id: true, name: true } },
        task: { select: { id: true, title: true } }
      }
    });

    const formatted = activities.map(log => ({
      id: log.id.toString(),
      actorName: log.actor.name,
      targetName: log.target?.name,
      projectName: log.project?.name,
      taskTitle: log.task?.title,
      type: log.type,
      description: log.description,
      createdAt: log.created_at.toISOString()
    }));

    res.status(200).json(formatted);
  } catch (error) {
    console.error('Error fetching project activities:', error);
    res.status(500).json({ error: 'Failed to fetch activities' });
  }
};

export const importProjectBacklog = async (req: Request, res: Response) => {
  try {
    const projectId = req.params.id as string;
    const { tasks } = req.body;

    if (!Array.isArray(tasks) || tasks.length === 0) {
      return res.status(400).json({ error: 'No tasks provided for import' });
    }

    const boardNames = [...new Set(tasks.map((t: any) => t.Board).filter(Boolean))] as string[];
    let boardsCreated = 0;
    let columnsCreated = 0;
    let tasksImported = 0;
    let skippedTasks = 0;

    await prisma.$transaction(async (tx) => {
      const boardMap = new Map<string, number>();
      const inProgressColumnMap = new Map<number, string>();

      for (const boardName of boardNames) {
        let board = await tx.kanban_boards.findFirst({
          where: { projectId, name: boardName }
        });

        if (!board) {
          board = await tx.kanban_boards.create({
            data: { name: boardName, projectId, createdAt: new Date() }
          });
          boardsCreated++;
        }

        boardMap.set(boardName, board.id);

        let inProgressCol = await tx.kanban_columns.findFirst({
          where: { board_id: board.id, label: 'In-Progress' }
        });

        if (!inProgressCol) {
          const colId = `col-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
          inProgressCol = await tx.kanban_columns.create({
            data: { id: colId, label: 'In-Progress', order_index: 1, board_id: board.id }
          });
          columnsCreated++;
        }

        inProgressColumnMap.set(board.id, inProgressCol.id);
      }

      const tasksToCreate: any[] = [];

      for (const task of tasks) {
        if (!task.Board || !task['Task Title']) {
          skippedTasks++;
          continue;
        }

        const boardName = String(task.Board).trim();
        const title = String(task['Task Title']).trim();
        const boardId = boardMap.get(boardName);
        const statusColId = inProgressColumnMap.get(boardId!);

        if (!boardId || !statusColId) {
          skippedTasks++;
          continue;
        }

        const taskId = `task-${Date.now()}-${Math.floor(Math.random() * 1000000)}`;
        const originTaskId = `TID-${Math.floor(10000 + Math.random() * 90000)}`;
        let priority = String(task.Priority || 'Medium').toLowerCase();
        priority = priority.charAt(0).toUpperCase() + priority.slice(1);

        const dueDateRaw = task['Due Date'];
        let dueDateStr = new Date().toISOString().split('T')[0];
        if (dueDateRaw) {
          const parsedDate = new Date(dueDateRaw);
          if (!isNaN(parsedDate.getTime())) {
            dueDateStr = parsedDate.toISOString().split('T')[0];
          }
        }

        const assigneeRaw = task['Assign User'];
        const assigneeStr = (typeof assigneeRaw === 'string' && assigneeRaw.trim()) ? assigneeRaw.trim() : 'Unassigned';

        let storyPoints = 0;
        if (task.Points !== undefined && task.Points !== null) {
          const parsed = parseInt(String(task.Points));
          if (!isNaN(parsed)) storyPoints = parsed;
        }

        tasksToCreate.push({
          id: taskId,
          title,
          description: task.Description ? String(task.Description) : null,
          priority,
          assignee: assigneeStr,
          status: statusColId,
          dueDate: dueDateStr,
          board_id: boardId,
          storyPoints,
          originTaskId,
        });
      }

      if (tasksToCreate.length > 0) {
        await tx.kanban_tasks.createMany({
          data: tasksToCreate
        });
        tasksImported = tasksToCreate.length;
      }
    }, {
      maxWait: 10000,
      timeout: 60000
    });

    const userId = (req as any).userId;
    if (userId) {
      await prisma.activity_logs.create({
        data: {
          actor_user_id: userId,
          project_id: projectId,
          type: 'backlog_imported',
          description: `Imported ${tasksImported} tasks into ${boardsCreated} sprints`,
        }
      });
    }

    res.json({ success: true, summary: { boardsCreated, columnsCreated, tasksImported, skippedTasks } });
  } catch (error: any) {
    console.error('Import Error:', error);
    res.status(500).json({ error: `Failed to import project backlog: ${String(error?.message || error)}` });
  }
};

export const getProjectSprintAnalytics = async (req: Request, res: Response) => {
  try {
    const projectId = req.params.id as string;

    // Fetch sprints for project
    const sprints = await prisma.sprints.findMany({
      where: { projectId },
      include: {
        tasks: {
          include: {
            board: {
              include: { columns: true }
            }
          }
        }
      },
      orderBy: { createdAt: 'asc' }
    });

    const totalSprints = sprints.length;
    let activeSprint: any = sprints.find(s => s.status === 'Active' || s.status === 'In Progress');
    if (!activeSprint && sprints.length > 0) {
      // Fallback to the most recent sprint
      activeSprint = sprints[sprints.length - 1];
    }
    activeSprint = activeSprint || null;
    
    // We also need project tasks not in a sprint? The prompt says "Total tasks across all project boards and sprints."
    const allProjectTasks = await prisma.kanban_tasks.findMany({
      where: {
        OR: [
          { board: { projectId } },
          { sprint: { projectId } }
        ]
      },
      include: {
        board: { include: { columns: true } },
        sprint: true
      }
    });

    // Helper to determine if a task is "Done"
    // In our system, status is a column ID, but sometimes it's text. We check if label contains 'done' or 'completed'
    const isTaskDone = (task: any) => {
      const statusId = String(task.status).toLowerCase();
      if (statusId === 'done' || statusId === 'completed' || statusId === 'resolved') return true;
      if (task.board && task.board.columns) {
        const col = task.board.columns.find((c: any) => c.id === task.status);
        if (col && (col.label.toLowerCase().includes('done') || col.label.toLowerCase().includes('completed'))) {
          return true;
        }
      }
      return false;
    };

    // Helper to get general status bucket ('backlog', 'todo', 'inProgress', 'review', 'done')
    const getTaskBucket = (task: any) => {
      if (isTaskDone(task)) return 'done';
      let label = String(task.status).toLowerCase();
      if (task.board && task.board.columns) {
        const col = task.board.columns.find((c: any) => c.id === task.status);
        if (col) label = col.label.toLowerCase();
      }
      if (label.includes('backlog')) return 'backlog';
      if (label.includes('review') || label.includes('qa') || label.includes('test')) return 'review';
      if (label.includes('progress') || label.includes('doing') || label.includes('active')) return 'inProgress';
      return 'todo'; // default
    };

    const totalTasksCount = allProjectTasks.length;
    const completedTasksCount = allProjectTasks.filter(isTaskDone).length;
    
    const today = new Date().toISOString().split('T')[0];
    const overdueTasksCount = allProjectTasks.filter(t => !isTaskDone(t) && t.dueDate && t.dueDate < today).length;

    const completionRate = totalTasksCount > 0 ? Math.round((completedTasksCount / totalTasksCount) * 100) : 0;

    // Sprint Progress
    const sprintProgress = sprints.map(s => {
      const sprintTasks = s.tasks || [];
      const tTotal = sprintTasks.length;
      const tDone = sprintTasks.filter(isTaskDone).length;
      return {
        sprintId: s.id,
        sprintName: s.name,
        startDate: s.startDate,
        endDate: s.endDate,
        progressPercent: tTotal > 0 ? Math.round((tDone / tTotal) * 100) : 0
      };
    });

    // Sprint Status Distribution
    const sprintStatusDistribution = sprints.map(s => {
      const sprintTasks = s.tasks || [];
      const dist = { backlog: 0, todo: 0, inProgress: 0, review: 0, done: 0 };
      sprintTasks.forEach(t => {
        const bucket = getTaskBucket(t);
        dist[bucket as keyof typeof dist]++;
      });
      return {
        sprintName: s.name,
        ...dist
      };
    });

    // Team Contribution & Workload Distribution
    const contributionMap: Record<string, number> = {};
    const workloadMap: Record<string, number> = {};

    allProjectTasks.forEach(t => {
      const assignee = t.assignee && t.assignee.trim() !== '' ? t.assignee : 'Unassigned';
      if (isTaskDone(t)) {
        contributionMap[assignee] = (contributionMap[assignee] || 0) + 1;
      } else {
        workloadMap[assignee] = (workloadMap[assignee] || 0) + 1;
      }
    });

    const teamContribution = Object.keys(contributionMap)
      .map(userName => ({ userName, completedTasks: contributionMap[userName] }))
      .sort((a, b) => b.completedTasks - a.completedTasks);

    const workloadDistribution = Object.keys(workloadMap)
      .map(userName => ({ userName, activeTasks: workloadMap[userName] }))
      .sort((a, b) => b.activeTasks - a.activeTasks);

    // Sprint Velocity (Story points per sprint)
    const sprintVelocity = sprints.map(s => {
      const sprintTasks = s.tasks || [];
      const completedPoints = sprintTasks
        .filter(isTaskDone)
        .reduce((sum, t) => sum + (t.storyPoints || 0), 0);
      return {
        sprintName: s.name,
        storyPoints: completedPoints
      };
    });

    // Burndown for Active Sprint
    let burndown: any[] = [];
    if (activeSprint) {
      const activeSprintTasks = activeSprint.tasks || [];
      const totalActiveTasks = activeSprintTasks.length;
      const doneActiveTasks = activeSprintTasks.filter(isTaskDone).length;
      burndown = [
        { date: 'Start', remaining: totalActiveTasks, completed: 0 },
        { date: 'Current', remaining: totalActiveTasks - doneActiveTasks, completed: doneActiveTasks }
      ];
    }

    // Health Indicator
    let healthStatus = 'Healthy';
    const overdueRate = totalTasksCount > 0 ? (overdueTasksCount / totalTasksCount) * 100 : 0;
    if (completionRate < 50 || overdueRate > 30) {
      healthStatus = 'Critical';
    } else if (completionRate < 80 || overdueRate > 10) {
      healthStatus = 'At Risk';
    }

    // Recent Activity (sprint_activity_logs)
    const rawActivity = await prisma.sprint_activity_logs.findMany({
      where: { sprint: { projectId } },
      include: { user: true, sprint: true },
      orderBy: { createdAt: 'desc' },
      take: 10
    });

    const recentActivity = rawActivity.map(a => ({
      actor: a.user?.name || 'System',
      action: `${a.action} on ${a.sprint?.name}`,
      timestamp: a.createdAt?.toISOString() || new Date().toISOString()
    }));

    const sprintsList = sprints.map(s => ({
      id: s.id,
      name: s.name,
      status: s.status,
      startDate: s.startDate,
      endDate: s.endDate,
      estimatedHours: s.estimatedHours,
      capacity: s.capacity,
      tasksCount: s.tasks ? s.tasks.length : 0
    }));

    res.status(200).json({
      overview: {
        totalSprints,
        activeSprintName: activeSprint ? activeSprint.name : null,
        activeSprintStartDate: activeSprint ? activeSprint.startDate : null,
        activeSprintEndDate: activeSprint ? activeSprint.endDate : null,
        completionRate,
        totalTasks: totalTasksCount,
        completedTasks: completedTasksCount,
        overdueTasks: overdueTasksCount
      },
      sprintProgress,
      sprintStatusDistribution,
      teamContribution,
      workloadDistribution,
      sprintVelocity,
      burndown,
      health: {
        status: healthStatus,
        completionRate,
        overdueRate
      },
      recentActivity,
      sprintsList
    });

  } catch (error) {
    console.error('Error fetching sprint analytics:', error);
    res.status(500).json({ error: 'Failed to fetch sprint analytics' });
  }
};

