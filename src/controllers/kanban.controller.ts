import { Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import prisma from '../config/db.js';
import { activityService } from '../services/activity.service.js';
import { io } from '../socket.js';

export const calculateSprintStatus = (startDate: Date | string | null | undefined, endDate: Date | string | null | undefined): string => {
  if (!startDate) return 'Not Started';
  
  const now = new Date();
  
  const start = new Date(startDate);
  start.setHours(0, 0, 0, 0);
  
  if (now.getTime() < start.getTime()) {
    return 'Not Started';
  }
  
  if (endDate) {
    const end = new Date(endDate);
    end.setHours(23, 59, 59, 999);
    if (now.getTime() > end.getTime()) {
      return 'Completed';
    }
  }
  
  return 'Active';
};

export const calculateWorkingDays = (startDate: Date | string | null | undefined, endDate: Date | string | null | undefined): number => {
  if (!startDate || !endDate) return 0;
  
  const start = new Date(startDate);
  start.setHours(0, 0, 0, 0);
  
  const end = new Date(endDate);
  end.setHours(0, 0, 0, 0);
  
  if (start > end) return 0;
  
  let count = 0;
  let current = new Date(start);
  
  while (current <= end) {
    const dayOfWeek = current.getDay();
    if (dayOfWeek !== 0 && dayOfWeek !== 6) { // 0 = Sunday, 6 = Saturday
      count++;
    }
    current.setDate(current.getDate() + 1);
  }
  
  return count;
};

export const calculateTeamCapacity = (workingDays: number, totalDailyCapacity: number): number => {
  if (totalDailyCapacity <= 0) return 0;
  // User requested team capacity to always be total capacity * 5
  return 5 * totalDailyCapacity;
};

// ─────────────────────────────────────────────
// BOARD endpoints
// ─────────────────────────────────────────────

export const getBoards = async (req: Request, res: Response) => {
  try {
    const boards = await prisma.kanban_boards.findMany({
      orderBy: { createdAt: 'desc' },
      include: { 
        project: true,
        tasks: { select: { storyPoints: true } }
      }
    });

    const formatted = boards.map((b: any) => {
      const totalPoints = b.tasks?.reduce((sum: number, t: any) => sum + (Number(t.storyPoints) || 0), 0) || 0;
      return {
        id: b.id,
        name: b.name,
        projectName: b.project?.name || b.projectId || '',
        projectId: b.projectId,
        createdAt: b.createdAt,
        totalEstimatedPoints: totalPoints
      };
    });
    res.status(200).json(formatted);
  } catch (error: any) {
    console.error('Error fetching boards:', error);
    res.status(500).json({ error: 'Failed to fetch boards' });
  }
};

export const createBoard = async (req: Request, res: Response) => {
  try {
    const { name, projectId, goal, description, status, startDate, endDate, estimatedHours, capacity } = req.body;
    if (!name) {
      return res.status(400).json({ error: 'Board name is required' });
    }

    const userId = Number((req as any).userId);
    const userRole = String((req as any).userRole || '').toLowerCase();
    const isGlobalAdmin = userRole === 'super admin';

    if (!isGlobalAdmin) {
      if (projectId) {
        const member = await prisma.project_members.findUnique({
          where: { project_id_user_id: { project_id: projectId, user_id: userId } }
        });
        if (!member || (member.role !== 'admin' && member.role !== 'editor')) {
          return res.status(403).json({ error: 'Forbidden: You must be an admin or editor of the project to create a board/sprint' });
        }
      } else {
        // Fallback to checking global role permissions for personal boards
        const roles = await prisma.$queryRawUnsafe<any[]>(
          'SELECT permissions FROM roles WHERE LOWER(name) = LOWER($1) LIMIT 1;',
          userRole
        );
        let permissions: string[] = [];
        if (roles.length > 0 && roles[0].permissions) {
          const raw = roles[0].permissions;
          permissions = Array.isArray(raw) ? raw : JSON.parse(raw);
        }
        if (!permissions.includes('task.board.create')) {
          return res.status(403).json({ error: 'Forbidden: Missing global permission to create boards' });
        }
      }
    }

    const boardStartDate = startDate ? new Date(startDate) : null;
    const boardEndDate = endDate ? new Date(endDate) : null;
    const computedStatus = calculateSprintStatus(boardStartDate, boardEndDate);

    const newBoard = await prisma.kanban_boards.create({
      data: {
        name,
        projectId: projectId || null,
        goal: goal || null,
        description: description || null,
        status: computedStatus,
        startDate: boardStartDate,
        endDate: boardEndDate,
        estimatedHours: 0,
        capacity: 0,
        created_by: userId || null
      },
      include: { project: true }
    });

    if (userId) {
      await activityService.logActivity({
        actorUserId: userId,
        projectId: projectId || undefined,
        type: 'sprint_created',
        description: `Created Sprint/Board '${name}'`
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
    const { name, goal, description, startDate, endDate } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'Board name is required' });
    }

    const existingBoard = await prisma.kanban_boards.findUnique({ where: { id: boardId } });
    if (!existingBoard) return res.status(404).json({ error: 'Board not found' });

    const userId = Number((req as any).userId);
    const userRole = String((req as any).userRole || '').toLowerCase();
    const isGlobalAdmin = userRole === 'super admin';

    if (!isGlobalAdmin) {
      const roles = await prisma.$queryRawUnsafe<any[]>('SELECT permissions FROM roles WHERE LOWER(name) = LOWER($1) LIMIT 1;', userRole);
      let permissions: string[] = [];
      if (roles.length > 0 && roles[0].permissions) permissions = Array.isArray(roles[0].permissions) ? roles[0].permissions : JSON.parse(roles[0].permissions);
      const hasGlobalPermission = permissions.includes('task.board.edit');

      if (!hasGlobalPermission) {
        if (existingBoard.projectId) {
          const member = await prisma.project_members.findUnique({
            where: { project_id_user_id: { project_id: existingBoard.projectId, user_id: userId } }
          });
          if (!member || (member.role !== 'admin' && member.role !== 'editor')) {
            return res.status(403).json({ error: 'Forbidden: You must be an admin or editor to edit this board/sprint' });
          }
        } else {
          return res.status(403).json({ error: 'Forbidden: You do not have permission to edit this board/sprint' });
        }
      }
    }

    const boardStartDate = startDate ? new Date(startDate) : existingBoard.startDate;
    const boardEndDate = endDate ? new Date(endDate) : existingBoard.endDate;
    const computedStatus = calculateSprintStatus(boardStartDate, boardEndDate);

    const updatedBoard = await prisma.kanban_boards.update({
      where: { id: boardId },
      data: {
        name,
        goal: goal !== undefined ? goal : undefined,
        description: description !== undefined ? description : undefined,
        status: computedStatus,
        startDate: startDate ? new Date(startDate) : undefined,
        endDate: endDate ? new Date(endDate) : undefined
      }
    });

    const projectMembers = await prisma.project_members.findMany({
      where: { project_id: updatedBoard.projectId || '' },
      select: { capacity_points: true }
    });
    const totalDailyCapacity = projectMembers.reduce((sum, member) => sum + (Number(member.capacity_points) || 0), 0);
    const workingDays = calculateWorkingDays(updatedBoard.startDate, updatedBoard.endDate);
    const computedCapacity = calculateTeamCapacity(workingDays, totalDailyCapacity);

    // Get total points
    const tasks = await prisma.kanban_tasks.findMany({
      where: { board_id: updatedBoard.id },
      select: { storyPoints: true }
    });
    const totalPoints = tasks.reduce((sum, t) => sum + (Number(t.storyPoints) || 0), 0);

    const responseBoard = {
      ...updatedBoard,
      estimatedHours: totalPoints,
      capacity: computedCapacity
    };

    if (userId) {
      await activityService.logActivity({
        actorUserId: userId,
        projectId: updatedBoard.projectId || undefined,
        type: 'sprint_updated',
        description: `Updated Sprint/Board '${name}'`
      });
    }

    res.status(200).json(responseBoard);
  } catch (error: any) {
    console.error('Error updating board:', error);
    res.status(500).json({ error: 'Failed to update board' });
  }
};

export const updateBoardStatus = async (req: Request, res: Response) => {
  return res.status(400).json({ error: 'Manual status updates are disabled. Status is automatically calculated based on sprint dates.' });
};

export const deleteBoard = async (req: Request, res: Response) => {
  try {
    const boardId = Number(req.params.id);

    const existingBoard = await prisma.kanban_boards.findUnique({ where: { id: boardId } });
    if (!existingBoard) return res.status(404).json({ error: 'Board not found' });

    const userId = Number((req as any).userId);
    const userRole = String((req as any).userRole || '').toLowerCase();
    const isGlobalAdmin = userRole === 'super admin';

    if (!isGlobalAdmin) {
      const roles = await prisma.$queryRawUnsafe<any[]>('SELECT permissions FROM roles WHERE LOWER(name) = LOWER($1) LIMIT 1;', userRole);
      let permissions: string[] = [];
      if (roles.length > 0 && roles[0].permissions) permissions = Array.isArray(roles[0].permissions) ? roles[0].permissions : JSON.parse(roles[0].permissions);
      const hasGlobalPermission = permissions.includes('task.board.delete');

      if (!hasGlobalPermission) {
        if (existingBoard.projectId) {
          const member = await prisma.project_members.findUnique({
            where: { project_id_user_id: { project_id: existingBoard.projectId, user_id: userId } }
          });
          if (!member || member.role !== 'admin') {
            return res.status(403).json({ error: 'Forbidden: Only project admins or users with delete permissions can delete boards/sprints' });
          }
        } else {
          return res.status(403).json({ error: 'Forbidden: You do not have permission to delete this board/sprint' });
        }
      }
    }

    // Deleting the board will cascade delete columns and tasks because of onDelete: Cascade in Prisma
    await prisma.kanban_boards.delete({
      where: { id: boardId }
    });

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

    const boardsAsSprints = await prisma.kanban_boards.findMany({
      where: { projectId: board.projectId },
      orderBy: { createdAt: 'desc' },
      include: {
        tasks: { select: { storyPoints: true } }
      }
    });

    const projectMembers = await prisma.project_members.findMany({
      where: { project_id: board.projectId },
      select: { capacity_points: true }
    });
    const totalDailyCapacity = projectMembers.reduce((sum, member) => sum + (Number(member.capacity_points) || 0), 0);

    const formattedSprints = boardsAsSprints.map((s: any) => {
      const totalPoints = s.tasks?.reduce((sum: number, t: any) => sum + (Number(t.storyPoints) || 0), 0) || 0;
      const { tasks, ...sprintData } = s; // Exclude tasks from final response to save bandwidth
      
      const workingDays = calculateWorkingDays(s.startDate, s.endDate);
      const capacity = calculateTeamCapacity(workingDays, totalDailyCapacity);

      return {
        ...sprintData,
        status: calculateSprintStatus(s.startDate, s.endDate),
        estimatedHours: totalPoints,
        capacity: capacity,
        totalEstimatedPoints: totalPoints
      };
    });

    res.status(200).json(formattedSprints);
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

    const board = await prisma.kanban_boards.findUnique({
      where: { id: boardId },
      select: { projectId: true }
    });

    if (!board) {
      return res.status(404).json({ error: 'Board not found' });
    }

    const whereClause: any = {};

    if (!sprintId || sprintId === 'all') {
      if (board.projectId) {
        const projectBoards = await prisma.kanban_boards.findMany({
          where: { projectId: board.projectId },
          select: { id: true }
        });
        const boardIds = projectBoards.map((b: any) => b.id);
        whereClause.board_id = { in: boardIds };
      } else {
        whereClause.board_id = boardId;
      }
    } else {
      whereClause.board_id = Number(sprintId);
    }

    const tasks = await prisma.kanban_tasks.findMany({
      where: whereClause,
      include: {
        attachments: {
          include: { uploader: { select: { id: true, name: true } } }
        }
      },
      orderBy: { order_index: 'asc' }
    });

    const userId = Number((req as any).userId);
    const taskIds = tasks.map((t: any) => t.id);
    let unreadCountsMap: Record<string, number> = {};

    if (taskIds.length > 0 && userId) {
      const unreadCounts: any[] = await prisma.$queryRaw`
        SELECT 
          m.task_id,
          COUNT(m.id) as unread_count
        FROM task_discussions m
        LEFT JOIN task_discussion_reads r 
          ON m.task_id = r.task_id AND r.user_id = ${userId}
        WHERE m.task_id IN (${Prisma.join(taskIds)})
          AND m.sender_id != ${userId}
          AND (r.last_read_at IS NULL OR m.created_at > r.last_read_at)
        GROUP BY m.task_id
      `;
      unreadCounts.forEach(row => {
        unreadCountsMap[row.task_id] = Number(row.unread_count);
      });
    }

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
      originTaskId: t.originTaskId,
      attachments: t.attachments || [],
      unreadCount: unreadCountsMap[t.id] || 0
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
      },
      include: { board: true }
    });

    if (newTask.board?.projectId) {
      io.to(`project_${newTask.board.projectId}`).emit('project_analytics_updated');
    }

    const userId = Number((req as any).userId);
    if (userId) {
      await activityService.logActivity({
        actorUserId: userId,
        projectId: newTask.board?.projectId || undefined,
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
    const { title, description, priority, assignee, status, dueDate, storyPoints, originTaskId, boardId } = req.body;

    const oldTask = await prisma.kanban_tasks.findUnique({
      where: { id },
      include: { board: true }
    });

    if (!oldTask) {
      return res.status(404).json({ error: 'Task not found' });
    }

    const dataToUpdate: any = {};
    if (title !== undefined) dataToUpdate.title = title;
    if (description !== undefined) dataToUpdate.description = description;
    if (priority !== undefined) dataToUpdate.priority = priority;
    if (assignee !== undefined) dataToUpdate.assignee = assignee;
    if (status !== undefined) dataToUpdate.status = status;
    if (dueDate !== undefined) dataToUpdate.dueDate = dueDate;
    if (storyPoints !== undefined) dataToUpdate.storyPoints = storyPoints;
    if (originTaskId !== undefined) dataToUpdate.originTaskId = originTaskId;
    
    let isBoardMoved = false;
    let oldBoard = oldTask.board;
    let newBoard = null;

    if (boardId !== undefined && Number(boardId) !== oldTask.board_id) {
      dataToUpdate.board = { connect: { id: Number(boardId) } };
      isBoardMoved = true;
      newBoard = await prisma.kanban_boards.findUnique({ where: { id: Number(boardId) } });
    }

    if (Object.keys(dataToUpdate).length > 0) {
      const updatedTask = await prisma.kanban_tasks.update({
        where: { id },
        data: dataToUpdate,
        include: { board: true }
      });

      if (updatedTask.board?.projectId) {
        io.to(`project_${updatedTask.board.projectId}`).emit('project_analytics_updated');
      }
      
      // If the board was moved to a different project, notify the old project as well
      if (isBoardMoved && oldBoard?.projectId && oldBoard.projectId !== updatedTask.board?.projectId) {
        io.to(`project_${oldBoard.projectId}`).emit('project_analytics_updated');
      }

      const userId = Number((req as any).userId);
      if (userId) {
        if (isBoardMoved && oldBoard && newBoard) {
          // Log specific activity for board movement
          await activityService.logActivity({
            actorUserId: userId,
            projectId: newBoard.projectId || undefined,
            taskId: id,
            type: 'task_moved_board',
            description: `Moved task '${updatedTask.title}' from '${oldBoard.name}' to '${newBoard.name}'`
          });
        } else {
          // Log regular task update
          await activityService.logActivity({
            actorUserId: userId,
            projectId: updatedTask.board?.projectId || undefined,
            taskId: id,
            type: 'task_updated',
            description: `Updated task '${title || updatedTask.title}'`
          });
        }
        
        if (description !== undefined) {
          await activityService.extractAndLogMentions(description, userId, undefined, id, title || updatedTask.title);
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

    const task = await prisma.kanban_tasks.findUnique({ 
      where: { id },
      include: { board: true }
    });
    
    await prisma.kanban_tasks.delete({ where: { id } });

    if (task?.board?.projectId) {
      io.to(`project_${task.board.projectId}`).emit('project_analytics_updated');
    }

    const userId = Number((req as any).userId);
    if (userId && task) {
      await activityService.logActivity({
        actorUserId: userId,
        projectId: task.board?.projectId || undefined,
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

    const oldTask = await prisma.kanban_tasks.findUnique({
      where: { id: taskId },
      include: { board: true }
    });

    if (!oldTask) {
      return res.status(404).json({ error: 'Task not found' });
    }

    const updatedTask = await prisma.kanban_tasks.update({
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

    if (oldTask.status !== targetStatus) {
      const newColumn = await prisma.kanban_columns.findUnique({ where: { id: targetStatus } });
      const userId = Number((req as any).userId);
      
      if (userId) {
        await activityService.logActivity({
          actorUserId: userId,
          projectId: oldTask.board?.projectId || undefined,
          taskId: taskId,
          type: 'task_updated',
          description: `Moved task '${oldTask.title}' to '${newColumn?.label || targetStatus}'`
        });
      }
    }

    if (oldTask.board?.projectId) {
      io.to(`project_${oldTask.board.projectId}`).emit('project_analytics_updated');
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
    const originalTask = await prisma.kanban_tasks.findUnique({ where: { id } });
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
        ...(originalTask.board_id ? { board: { connect: { id: originalTask.board_id } } } : {})
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

    const board = await prisma.kanban_boards.findUnique({
      where: { id: boardId },
      select: { projectId: true, startDate: true, endDate: true }
    });

    if (!board) {
      return res.status(404).json({ error: 'Board not found' });
    }

    const whereClause: any = {};
    if (assigneeId && assigneeId !== 'all') whereClause.assignee = assigneeId;

    if (!sprintId || sprintId === 'all') {
      if (board.projectId) {
        const projectBoards = await prisma.kanban_boards.findMany({
          where: { projectId: board.projectId },
          select: { id: true }
        });
        const boardIds = projectBoards.map((b: any) => b.id);
        whereClause.board_id = { in: boardIds };
      } else {
        whereClause.board_id = boardId;
      }
    } else {
      whereClause.board_id = Number(sprintId);
    }

    // Fetch tasks
    const tasks = await prisma.kanban_tasks.findMany({
      where: whereClause,
      include: {
        board: { include: { columns: true } }
      }
    });

    const totalTasks = tasks.length;
    const totalEstimatedPoints = tasks.reduce((sum, t) => sum + (Number(t.storyPoints) || 0), 0);

    let teamCapacity = 0;
    if (board.projectId) {
      const projectMembers = await prisma.project_members.findMany({
        where: { project_id: board.projectId },
        select: { capacity_points: true }
      });
      const totalDailyCapacity = projectMembers.reduce((sum, member) => sum + (Number(member.capacity_points) || 0), 0);

      let sprintToCalculate = null;
      if (sprintId && sprintId !== 'all') {
        const s = await prisma.kanban_boards.findUnique({ where: { id: Number(sprintId) } });
        if (s) sprintToCalculate = s;
      }
      
      const targetDates = sprintToCalculate || board;
      const workingDays = calculateWorkingDays(targetDates.startDate, targetDates.endDate);
      teamCapacity = calculateTeamCapacity(workingDays, totalDailyCapacity);
    }

    // Helpers
    const isDone = (status: string) => status.toLowerCase().includes('done') || status.toLowerCase().includes('completed');

    // Date Normalization
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const endOfWeek = new Date(today);
    endOfWeek.setDate(endOfWeek.getDate() + 7);

    let overdueTasks = 0;
    let dueToday = 0;
    let dueThisWeek = 0;

    tasks.forEach(t => {
      if (!t.dueDate || isDone(t.status)) return;
      const due = new Date(t.dueDate);
      if (isNaN(due.getTime())) return;

      due.setHours(0, 0, 0, 0);

      if (due.getTime() < today.getTime()) {
        overdueTasks++;
      } else if (due.getTime() === today.getTime()) {
        dueToday++;
      }

      if (due.getTime() >= today.getTime() && due.getTime() <= endOfWeek.getTime()) {
        dueThisWeek++;
      }
    });

    const completedTasks = tasks.filter(t => isDone(t.status)).length;
    const activeTasks = tasks.filter(t => !isDone(t.status) && t.status.toLowerCase().includes('progress')).length;

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
    const columns = await prisma.kanban_columns.findMany({ where: { board_id: boardId } });
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

    // Due Date Analytics (Calculated at the top with Date Normalization)

    // Sprint Analytics (if sprint filter applied)
    let sprintAnalytics = null;
    // Removed because boards are sprints now, analytics are on the board itself.

    // Recent Activity (mocked or fetched from activity_logs)
    const recentActivityRaw = await prisma.activity_logs.findMany({
      where: {
        task: { board_id: boardId }
      },
      include: { actor: true },
      orderBy: { created_at: 'desc' },
      take: 10
    });

    const recentActivity = recentActivityRaw.map(a => {
      const isSystemEvent = ['system_job', 'cleanup', 'automated_sync', 'cron'].includes(a.type);
      return {
        actor: a.actor?.name || (isSystemEvent ? 'System' : 'Unknown User'),
        action: a.type,
        description: a.description,
        timestamp: a.created_at
      };
    });

    res.status(200).json({
      overview: {
        totalTasks,
        completedTasks,
        activeTasks,
        overdueTasks,
        completionRate,
        healthScore,
        totalEstimatedPoints,
        teamCapacity
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
