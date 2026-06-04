import { Request, Response } from 'express';
import prisma from '../config/db.js';
import { activityService } from '../services/activity.service.js';

// ─────────────────────────────────────────────
// BOARD endpoints
// ─────────────────────────────────────────────

export const getBoards = async (req: Request, res: Response) => {
  try {
    const boards = await prisma.kanban_boards.findMany({
      orderBy: { createdAt: 'desc' },
      include: { project: true }
    });
    
    const formatted = boards.map((b: any) => ({
      id: b.id,
      name: b.name,
      projectName: b.project?.name || b.projectId || '',
      projectId: b.projectId,
      createdAt: b.createdAt
    }));
    res.status(200).json(formatted);
  } catch (error: any) {
    console.error('Error fetching boards:', error);
    res.status(500).json({ error: 'Failed to fetch boards' });
  }
};

export const createBoard = async (req: Request, res: Response) => {
  try {
    const { name, projectId } = req.body;
    if (!name) {
      return res.status(400).json({ error: 'Board name is required' });
    }

    const newBoard = await prisma.kanban_boards.create({
      data: {
        name,
        projectId: projectId || null,
      },
      include: { project: true }
    });

    // Removed default columns creation as requested; board will start empty.

    const userId = Number((req as any).userId);
    if (userId) {
      await activityService.logActivity({
        actorUserId: userId,
        projectId: projectId || undefined,
        type: 'board_created',
        description: `Created Kanban board '${name}'`
      });
    }

    res.status(201).json({
      id: newBoard.id,
      name: newBoard.name,
      projectName: newBoard.project?.name || newBoard.projectId || '',
      projectId: newBoard.projectId,
      createdAt: newBoard.createdAt
    });
  } catch (error: any) {
    console.error('Error creating board:', error);
    res.status(500).json({ error: 'Failed to create board' });
  }
};

export const updateBoard = async (req: Request, res: Response) => {
  try {
    const boardId = Number(req.params.id);
    const { name } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'Board name is required' });
    }

    const updatedBoard = await prisma.kanban_boards.update({
      where: { id: boardId },
      data: { name }
    });

    const userId = Number((req as any).userId);
    if (userId) {
      await activityService.logActivity({
        actorUserId: userId,
        projectId: updatedBoard.projectId || undefined,
        type: 'board_updated',
        description: `Updated Kanban board name to '${name}'`
      });
    }

    res.status(200).json(updatedBoard);
  } catch (error: any) {
    console.error('Error updating board:', error);
    res.status(500).json({ error: 'Failed to update board' });
  }
};

export const deleteBoard = async (req: Request, res: Response) => {
  try {
    const boardId = Number(req.params.id);
    
    // Deleting the board will cascade delete columns and tasks because of onDelete: Cascade in Prisma
    await prisma.kanban_boards.delete({
      where: { id: boardId }
    });
    
    const userId = Number((req as any).userId);
    if (userId) {
      await activityService.logActivity({
        actorUserId: userId,
        projectId: undefined,
        type: 'board_deleted',
        description: `Deleted a Kanban board`
      });
    }

    res.status(200).json({ success: true, message: 'Board deleted successfully' });
  } catch (error: any) {
    console.error('Error deleting board:', error);
    res.status(500).json({ error: 'Failed to delete board' });
  }
};

// ─────────────────────────────────────────────
// COLUMN endpoints
// ─────────────────────────────────────────────

export const getColumns = async (req: Request, res: Response) => {
  try {
    const boardId = req.params.id ? Number(req.params.id) : undefined;
    if (!boardId) {
      return res.status(200).json([]);
    }
    
    const cols = await prisma.kanban_columns.findMany({
      where: { board_id: boardId },
      orderBy: { order_index: 'asc' }
    });
    
    const formatted = cols.map((c: any) => ({
      id: c.id,
      label: c.label,
      order: c.order_index,
      boardId: c.board_id
    }));
    
    res.status(200).json(formatted);
  } catch (error: any) {
    console.error('Error fetching kanban columns:', error);
    res.status(500).json({ error: 'Failed to fetch kanban columns' });
  }
};

export const createColumn = async (req: Request, res: Response) => {
  try {
    const { id, label, order, boardId } = req.body;
    if (!id || !label || !boardId) {
      return res.status(400).json({ error: 'Column ID, label, and boardId are required' });
    }
    
    await prisma.kanban_columns.create({
      data: {
        id,
        label,
        order_index: order !== undefined ? Number(order) : 0,
        board_id: Number(boardId)
      }
    });

    const userId = Number((req as any).userId);
    if (userId) {
      await activityService.logActivity({
        actorUserId: userId,
        projectId: undefined,
        type: 'column_created',
        description: `Created new board column '${label}'`
      });
    }

    res.status(201).json({ success: true, message: 'Column created successfully' });
  } catch (error: any) {
    console.error('Error creating kanban column:', error);
    res.status(500).json({ error: 'Failed to create kanban column' });
  }
};

export const updateColumn = async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);
    const { label, order } = req.body;

    const dataToUpdate: any = {};
    if (label !== undefined) dataToUpdate.label = label;
    if (order !== undefined) dataToUpdate.order_index = Number(order);

    if (Object.keys(dataToUpdate).length > 0) {
      await prisma.kanban_columns.update({
        where: { id },
        data: dataToUpdate
      });
    }

    res.status(200).json({ success: true, message: 'Column updated successfully' });
  } catch (error: any) {
    console.error('Error updating kanban column:', error);
    res.status(500).json({ error: 'Failed to update kanban column' });
  }
};

export const deleteColumn = async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);

    await prisma.kanban_tasks.deleteMany({
      where: { status: id }
    });
    
    await prisma.kanban_columns.delete({
      where: { id }
    });

    const userId = Number((req as any).userId);
    if (userId) {
      await activityService.logActivity({
        actorUserId: userId,
        projectId: undefined,
        type: 'column_deleted',
        description: `Deleted a board column`
      });
    }

    res.status(200).json({ success: true, message: 'Column and its tasks deleted successfully' });
  } catch (error: any) {
    console.error('Error deleting kanban column:', error);
    res.status(500).json({ error: 'Failed to delete kanban column' });
  }
};

export const reorderColumns = async (req: Request, res: Response) => {
  try {
    const { columns } = req.body;
    if (!Array.isArray(columns)) {
      return res.status(400).json({ error: 'Columns array is required' });
    }

    // Run in transaction to guarantee consistency
    await prisma.$transaction(
      columns.map((col: any) => 
        prisma.kanban_columns.update({
          where: { id: col.id },
          data: { order_index: Number(col.order) }
        })
      )
    );

    res.status(200).json({ success: true, message: 'Columns reordered successfully' });
  } catch (error: any) {
    console.error('Error reordering kanban columns:', error);
    res.status(500).json({ error: 'Failed to reorder kanban columns' });
  }
};

// ─────────────────────────────────────────────
// TASK endpoints
// ─────────────────────────────────────────────

export const getSprintsForBoard = async (req: Request, res: Response) => {
  try {
    const boardId = Number(req.params.id);
    if (!boardId) {
      return res.status(400).json({ error: 'Board ID is required' });
    }

    const board = await prisma.kanban_boards.findUnique({
      where: { id: boardId },
      select: { projectId: true }
    });

    if (!board || !board.projectId) {
      return res.status(200).json([]);
    }

    const sprints = await prisma.sprints.findMany({
      where: { projectId: board.projectId },
      orderBy: { startDate: 'desc' }
    });

    res.status(200).json(sprints);
  } catch (error: any) {
    console.error('Error fetching sprints for board:', error);
    res.status(500).json({ error: 'Failed to fetch sprints for board' });
  }
};

export const getTasksByBoard = async (req: Request, res: Response) => {
  try {
    const boardId = Number(req.params.id);
    const sprintId = req.query.sprintId as string;

    if (!boardId) {
      return res.status(400).json({ error: 'Board ID is required' });
    }

    const whereClause: any = { board_id: boardId };
    
    if (sprintId && sprintId !== 'all') {
      whereClause.sprintId = sprintId;
    }

    const tasks = await prisma.kanban_tasks.findMany({
      where: whereClause,
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
  } catch (error: any) {
    console.error('Error fetching kanban tasks for board:', error);
    res.status(500).json({ error: 'Failed to fetch kanban tasks for board' });
  }
};

const generateOriginTaskId = () => {
  const num = Math.floor(10000 + Math.random() * 90000); // 5-digit number
  return `TID-${num}`;
};

export const createTask = async (req: Request, res: Response) => {
  try {
    const { title, description, priority, assignee, status, dueDate, storyPoints, boardId } = req.body;
    if (!title || !status) {
      return res.status(400).json({ error: 'Title and status are required' });
    }

    const maxOrderRes = await prisma.kanban_tasks.aggregate({
      _max: { order_index: true },
      where: { status }
    });
    const maxOrder = maxOrderRes._max.order_index || 0;

    // Generate unique Task ID
    let finalTaskId = '';
    let isUnique = false;
    let attempts = 0;
    
    while (!isUnique && attempts < 10) {
      finalTaskId = generateOriginTaskId();
      const existing = await prisma.kanban_tasks.findFirst({
        where: { id: finalTaskId }
      });
      if (!existing) {
        isUnique = true;
      }
      attempts++;
    }

    if (!isUnique) {
      console.error('Failed to generate unique task ID after 10 attempts');
      return res.status(500).json({ error: 'Failed to generate unique task tracking ID' });
    }

    const newTask = await prisma.kanban_tasks.create({
      data: {
        id: finalTaskId,
        title,
        description: description || '',
        priority: priority || 'medium',
        assignee: assignee || '',
        status,
        dueDate: dueDate || '',
        order_index: maxOrder + 1,
        storyPoints: storyPoints || 0,
        originTaskId: finalTaskId,
        ...(boardId ? { board: { connect: { id: Number(boardId) } } } : {})
      }
    });

    const userId = Number((req as any).userId);
    if (userId) {
      await activityService.logActivity({
        actorUserId: userId,
        projectId: undefined,
        taskId: finalTaskId,
        type: 'task_created',
        description: `Created task '${title}'`
      });
      if (description) {
        await activityService.extractAndLogMentions(description, userId, undefined, finalTaskId, title);
      }
    }

    // Return the created task, containing the auto-generated originTaskId
    res.status(201).json({ success: true, message: 'Task created successfully', task: newTask });
  } catch (error: any) {
    console.error('Error creating kanban task:', error);
    res.status(500).json({ error: 'Failed to create kanban task' });
  }
};

export const updateTask = async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);
    const { title, description, priority, assignee, status, dueDate, storyPoints, originTaskId } = req.body;

    const dataToUpdate: any = {};
    if (title !== undefined) dataToUpdate.title = title;
    if (description !== undefined) dataToUpdate.description = description;
    if (priority !== undefined) dataToUpdate.priority = priority;
    if (assignee !== undefined) dataToUpdate.assignee = assignee;
    if (status !== undefined) dataToUpdate.status = status;
    if (dueDate !== undefined) dataToUpdate.dueDate = dueDate;
    if (storyPoints !== undefined) dataToUpdate.storyPoints = storyPoints;
    if (originTaskId !== undefined) dataToUpdate.originTaskId = originTaskId;

    if (Object.keys(dataToUpdate).length > 0) {
      await prisma.kanban_tasks.update({
        where: { id },
        data: dataToUpdate
      });

      const userId = Number((req as any).userId);
      if (userId) {
        await activityService.logActivity({
          actorUserId: userId,
          projectId: undefined,
          taskId: id,
          type: 'task_updated',
          description: `Updated task '${title || 'Task'}'`
        });
        if (description !== undefined) {
          await activityService.extractAndLogMentions(description, userId, undefined, id, title || 'Task');
        }
      }
    }

    res.status(200).json({ success: true, message: 'Task updated successfully' });
  } catch (error: any) {
    console.error('Error updating kanban task:', error);
    res.status(500).json({ error: 'Failed to update kanban task' });
  }
};

export const deleteTask = async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);
    
    const task = await prisma.kanban_tasks.findUnique({ where: { id }});
    await prisma.kanban_tasks.delete({ where: { id } });

    const userId = Number((req as any).userId);
    if (userId && task) {
      await activityService.logActivity({
        actorUserId: userId,
        projectId: undefined,
        taskId: undefined,
        type: 'task_deleted',
        description: `Deleted task '${task.title}'`
      });
    }

    res.status(200).json({ success: true, message: 'Task deleted successfully' });
  } catch (error: any) {
    console.error('Error deleting kanban task:', error);
    res.status(500).json({ error: 'Failed to delete kanban task' });
  }
};

export const moveTask = async (req: Request, res: Response) => {
  try {
    const { taskId, targetStatus, taskIdsOrder } = req.body;
    if (!taskId || !targetStatus) {
      return res.status(400).json({ error: 'taskId and targetStatus are required' });
    }

    await prisma.kanban_tasks.update({
      where: { id: taskId },
      data: { status: targetStatus }
    });

    if (Array.isArray(taskIdsOrder)) {
      await prisma.$transaction(
        taskIdsOrder.map((id: string, i: number) =>
          prisma.kanban_tasks.update({
            where: { id },
            data: { order_index: i }
          })
        )
      );
    }

    res.status(200).json({ success: true, message: 'Task moved successfully' });
  } catch (error: any) {
    console.error('Error moving kanban task:', error);
    res.status(500).json({ error: 'Failed to move kanban task' });
  }
};

export const resetBoard = async (req: Request, res: Response) => {
  try {
    await prisma.kanban_tasks.deleteMany();
    await prisma.kanban_columns.deleteMany();
    res.status(200).json({ success: true, message: 'Kanban board cleared successfully' });
  } catch (error: any) {
    console.error('Error resetting kanban board:', error);
    res.status(500).json({ error: 'Failed to reset kanban board' });
  }
};
export const cloneTask = async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);
    
    // Find original task
    const originalTask = await prisma.kanban_tasks.findUnique({ where: { id }});
    if (!originalTask) {
      return res.status(404).json({ error: 'Original task not found' });
    }

    // Get max order in the target status column
    const maxOrderRes = await prisma.kanban_tasks.aggregate({
      _max: { order_index: true },
      where: { status: originalTask.status }
    });
    const maxOrder = maxOrderRes._max.order_index || 0;

    // Generate unique Task ID
    let finalTaskId = '';
    let isUnique = false;
    let attempts = 0;
    
    while (!isUnique && attempts < 10) {
      finalTaskId = generateOriginTaskId();
      const existing = await prisma.kanban_tasks.findFirst({
        where: { id: finalTaskId }
      });
      if (!existing) {
        isUnique = true;
      }
      attempts++;
    }

    const newTitle = `${originalTask.title} (Clone)`;
    
    const clonedTask = await prisma.kanban_tasks.create({
      data: {
        id: finalTaskId,
        title: newTitle,
        description: originalTask.description,
        priority: originalTask.priority,
        assignee: originalTask.assignee,
        status: originalTask.status,
        dueDate: originalTask.dueDate,
        order_index: maxOrder + 1,
        storyPoints: originalTask.storyPoints,
        originTaskId: finalTaskId,
        ...(originalTask.board_id ? { board: { connect: { id: originalTask.board_id } } } : {}),
        ...(originalTask.sprintId ? { sprint: { connect: { id: originalTask.sprintId } } } : {})
      }
    });

    const userId = Number((req as any).userId);
    if (userId) {
      await activityService.logActivity({
        actorUserId: userId,
        projectId: undefined,
        taskId: finalTaskId,
        type: 'task_cloned',
        description: `Cloned task from '${originalTask.title}'`
      });
    }

    res.status(201).json({ success: true, message: 'Task cloned successfully', task: clonedTask });
  } catch (error: any) {
    console.error('Error cloning kanban task:', error);
    res.status(500).json({ error: 'Failed to clone kanban task' });
  }
};

// ─────────────────────────────────────────────
// ANALYTICS endpoints
// ─────────────────────────────────────────────

export const getBoardAnalytics = async (req: Request, res: Response) => {
  try {
    const boardId = Number(req.params.id);
    const sprintId = req.query.sprintId as string;
    const assigneeId = req.query.assignee as string;

    if (!boardId) {
      return res.status(400).json({ error: 'Board ID is required' });
    }

    const whereClause: any = { board_id: boardId };
    if (sprintId && sprintId !== 'all') whereClause.sprintId = sprintId;
    if (assigneeId && assigneeId !== 'all') whereClause.assignee = assigneeId;

    // Fetch tasks
    const tasks = await prisma.kanban_tasks.findMany({
      where: whereClause,
      include: {
        sprint: true
      }
    });

    const totalTasks = tasks.length;

    // Helpers
    const isDone = (status: string) => status.toLowerCase().includes('done') || status.toLowerCase().includes('completed');
    const isOverdue = (dueDate: string, status: string) => {
      if (!dueDate || isDone(status)) return false;
      const due = new Date(dueDate);
      if (isNaN(due.getTime())) return false;
      return due < new Date();
    };

    const completedTasks = tasks.filter(t => isDone(t.status)).length;
    const activeTasks = tasks.filter(t => !isDone(t.status) && t.status.toLowerCase().includes('progress')).length;
    const overdueTasks = tasks.filter(t => isOverdue(t.dueDate, t.status)).length;

    const completionRate = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;
    
    // Board Health
    let healthScore = 'Healthy';
    if (completionRate < 50) healthScore = 'Critical';
    else if (completionRate < 80) healthScore = 'At Risk';
    if (overdueTasks > (totalTasks * 0.2)) healthScore = 'Critical'; // High overdue overrides

    // Column Distribution
    const colDistMap: Record<string, number> = {};
    tasks.forEach(t => {
      colDistMap[t.status] = (colDistMap[t.status] || 0) + 1;
    });
    
    // For proper labels, we need to fetch columns for this board
    const columns = await prisma.kanban_columns.findMany({ where: { board_id: boardId }});
    const colLabels: Record<string, string> = {};
    columns.forEach((c: any) => colLabels[c.id] = c.label);

    const columnDistribution = Object.keys(colDistMap).map(statusId => ({
      name: colLabels[statusId] || statusId,
      statusId,
      value: colDistMap[statusId]
    }));

    // Priority Distribution
    const priorityMap: Record<string, number> = { high: 0, medium: 0, low: 0 };
    tasks.forEach(t => {
      const p = t.priority.toLowerCase();
      priorityMap[p] = (priorityMap[p] || 0) + 1;
    });

    // Assignee Workload
    const assigneeMap: Record<string, number> = {};
    tasks.forEach(t => {
      if (t.assignee) {
        assigneeMap[t.assignee] = (assigneeMap[t.assignee] || 0) + 1;
      }
    });
    const assigneeWorkload = Object.keys(assigneeMap)
      .map(name => ({ name, tasks: assigneeMap[name] }))
      .sort((a, b) => b.tasks - a.tasks);

    // Due Date Analytics
    let dueToday = 0;
    let dueThisWeek = 0;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const endOfWeek = new Date(today);
    endOfWeek.setDate(endOfWeek.getDate() + 7);

    tasks.forEach(t => {
      if (!t.dueDate || isDone(t.status)) return;
      const due = new Date(t.dueDate);
      if (isNaN(due.getTime())) return;
      
      due.setHours(0,0,0,0);
      if (due.getTime() === today.getTime()) dueToday++;
      if (due >= today && due <= endOfWeek) dueThisWeek++;
    });

    // Sprint Analytics (if sprint filter applied)
    let sprintAnalytics = null;
    if (sprintId && sprintId !== 'all') {
      const sp = await prisma.sprints.findUnique({ where: { id: sprintId } });
      if (sp) {
        sprintAnalytics = {
          name: sp.name,
          startDate: sp.startDate,
          endDate: sp.endDate,
          progress: completionRate
        };
      }
    }

    // Recent Activity (mocked or fetched from activity_logs)
    const recentActivityRaw = await prisma.activity_logs.findMany({
      where: {
        task: { board_id: boardId }
      },
      include: { actor: true },
      orderBy: { created_at: 'desc' },
      take: 10
    });

    const recentActivity = recentActivityRaw.map(a => ({
      actor: a.actor?.name || 'Unknown',
      action: a.type,
      description: a.description,
      timestamp: a.created_at
    }));

    res.status(200).json({
      overview: {
        totalTasks,
        completedTasks,
        activeTasks,
        overdueTasks,
        completionRate,
        healthScore
      },
      columnDistribution,
      priorityDistribution: [
        { name: 'High', value: priorityMap.high || 0 },
        { name: 'Medium', value: priorityMap.medium || 0 },
        { name: 'Low', value: priorityMap.low || 0 }
      ],
      assigneeWorkload,
      dueDateAnalytics: {
        dueToday,
        dueThisWeek,
        overdue: overdueTasks
      },
      sprintAnalytics,
      recentActivity
    });
  } catch (error: any) {
    console.error('Error fetching board analytics:', error);
    res.status(500).json({ error: 'Failed to fetch board analytics' });
  }
};
