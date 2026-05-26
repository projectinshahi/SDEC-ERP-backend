import { Request, Response } from 'express';
import prisma from '../config/db';

/**
 * Fetch all Kanban Columns
 * GET /api/kanban/columns
 */
export const getColumns = async (req: Request, res: Response) => {
  try {
    const cols = await prisma.$queryRawUnsafe<any[]>(
      'SELECT id, label, order_index as "order" FROM kanban_columns ORDER BY order_index ASC;'
    );
    res.status(200).json(cols);
  } catch (error: any) {
    console.error('Error fetching kanban columns:', error);
    res.status(500).json({ error: 'Failed to fetch kanban columns' });
  }
};

/**
 * Create a new Kanban Column
 * POST /api/kanban/columns
 */
export const createColumn = async (req: Request, res: Response) => {
  try {
    const { id, label, order } = req.body;
    if (!id || !label) {
      return res.status(400).json({ error: 'Column ID and label are required' });
    }
    const orderVal = order !== undefined ? Number(order) : 0;

    await prisma.$executeRawUnsafe(
      'INSERT INTO kanban_columns (id, label, order_index) VALUES ($1, $2, $3);',
      id,
      label,
      orderVal
    );
    res.status(201).json({ success: true, message: 'Column created successfully' });
  } catch (error: any) {
    console.error('Error creating kanban column:', error);
    res.status(500).json({ error: 'Failed to create kanban column' });
  }
};

/**
 * Rename/Modify a Kanban Column
 * PUT /api/kanban/columns/:id
 */
export const updateColumn = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { label, order } = req.body;

    if (label !== undefined && order !== undefined) {
      await prisma.$executeRawUnsafe(
        'UPDATE kanban_columns SET label = $1, order_index = $2 WHERE id = $3;',
        label,
        Number(order),
        id
      );
    } else if (label !== undefined) {
      await prisma.$executeRawUnsafe(
        'UPDATE kanban_columns SET label = $1 WHERE id = $2;',
        label,
        id
      );
    } else if (order !== undefined) {
      await prisma.$executeRawUnsafe(
        'UPDATE kanban_columns SET order_index = $1 WHERE id = $2;',
        Number(order),
        id
      );
    }

    res.status(200).json({ success: true, message: 'Column updated successfully' });
  } catch (error: any) {
    console.error('Error updating kanban column:', error);
    res.status(500).json({ error: 'Failed to update kanban column' });
  }
};

/**
 * Delete a Kanban Column and cascade delete all its tasks
 * DELETE /api/kanban/columns/:id
 */
export const deleteColumn = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    // Delete tasks mapped to this column status
    await prisma.$executeRawUnsafe('DELETE FROM kanban_tasks WHERE status = $1;', id);
    // Delete column
    await prisma.$executeRawUnsafe('DELETE FROM kanban_columns WHERE id = $1;', id);

    res.status(200).json({ success: true, message: 'Column and its tasks deleted successfully' });
  } catch (error: any) {
    console.error('Error deleting kanban column:', error);
    res.status(500).json({ error: 'Failed to delete kanban column' });
  }
};

/**
 * Bulk reorder column order indexes in database
 * POST /api/kanban/columns/reorder
 */
export const reorderColumns = async (req: Request, res: Response) => {
  try {
    const { columns } = req.body;
    if (!Array.isArray(columns)) {
      return res.status(400).json({ error: 'Columns array is required' });
    }

    for (const col of columns) {
      await prisma.$executeRawUnsafe(
        'UPDATE kanban_columns SET order_index = $1 WHERE id = $2;',
        Number(col.order),
        col.id
      );
    }

    res.status(200).json({ success: true, message: 'Columns reordered successfully' });
  } catch (error: any) {
    console.error('Error reordering kanban columns:', error);
    res.status(500).json({ error: 'Failed to reorder kanban columns' });
  }
};

/**
 * Fetch all Tasks
 * GET /api/kanban/tasks
 */
export const getTasks = async (req: Request, res: Response) => {
  try {
    const tasks = await prisma.$queryRawUnsafe<any[]>(
      'SELECT id, title, description, priority, assignee, status, "dueDate", estimated_hours as "estimatedHours", actual_hours as "actualHours" FROM kanban_tasks ORDER BY order_index ASC;'
    );
    res.status(200).json(tasks);
  } catch (error: any) {
    console.error('Error fetching kanban tasks:', error);
    res.status(500).json({ error: 'Failed to fetch kanban tasks' });
  }
};

/**
 * Create a new Task
 * POST /api/kanban/tasks
 */
export const createTask = async (req: Request, res: Response) => {
  try {
    const { id, title, description, priority, assignee, status, dueDate, estimatedHours, actualHours } = req.body;
    if (!id || !title || !status) {
      return res.status(400).json({ error: 'ID, title and status are required' });
    }

    // Get max order index for this column to place new task at the bottom
    const maxOrderResult = await prisma.$queryRawUnsafe<any[]>(
      'SELECT COALESCE(MAX(order_index), 0) as max_order FROM kanban_tasks WHERE status = $1;',
      status
    );
    const maxOrder = Number(maxOrderResult[0]?.max_order || 0);

    await prisma.$executeRawUnsafe(
      'INSERT INTO kanban_tasks (id, title, description, priority, assignee, status, "dueDate", order_index, estimated_hours, actual_hours) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10);',
      id,
      title,
      description || '',
      priority || 'medium',
      assignee || '',
      status,
      dueDate || '',
      maxOrder + 1,
      estimatedHours || 0,
      actualHours || 0
    );

    res.status(201).json({ success: true, message: 'Task created successfully' });
  } catch (error: any) {
    console.error('Error creating kanban task:', error);
    res.status(500).json({ error: 'Failed to create kanban task' });
  }
};

/**
 * Update an existing Task
 * PUT /api/kanban/tasks/:id
 */
export const updateTask = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { title, description, priority, assignee, status, dueDate, estimatedHours, actualHours } = req.body;

    await prisma.$executeRawUnsafe(
      'UPDATE kanban_tasks SET title = $1, description = $2, priority = $3, assignee = $4, status = $5, "dueDate" = $6, estimated_hours = $7, actual_hours = $8 WHERE id = $9;',
      title,
      description || '',
      priority || 'medium',
      assignee || '',
      status,
      dueDate || '',
      estimatedHours || 0,
      actualHours || 0,
      id
    );

    res.status(200).json({ success: true, message: 'Task updated successfully' });
  } catch (error: any) {
    console.error('Error updating kanban task:', error);
    res.status(500).json({ error: 'Failed to update kanban task' });
  }
};

/**
 * Delete a Task
 * DELETE /api/kanban/tasks/:id
 */
export const deleteTask = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    await prisma.$executeRawUnsafe('DELETE FROM kanban_tasks WHERE id = $1;', id);
    res.status(200).json({ success: true, message: 'Task deleted successfully' });
  } catch (error: any) {
    console.error('Error deleting kanban task:', error);
    res.status(500).json({ error: 'Failed to delete kanban task' });
  }
};

/**
 * Handle Drag-and-drop status moves and reordering indexes
 * POST /api/kanban/tasks/move
 */
export const moveTask = async (req: Request, res: Response) => {
  try {
    const { taskId, targetStatus, taskIdsOrder } = req.body;
    if (!taskId || !targetStatus) {
      return res.status(400).json({ error: 'taskId and targetStatus are required' });
    }

    // Update status of the task
    await prisma.$executeRawUnsafe(
      'UPDATE kanban_tasks SET status = $1 WHERE id = $2;',
      targetStatus,
      taskId
    );

    // If an ordered array of task IDs in the target column is provided, save the order_index
    if (Array.isArray(taskIdsOrder)) {
      for (let i = 0; i < taskIdsOrder.length; i++) {
        await prisma.$executeRawUnsafe(
          'UPDATE kanban_tasks SET order_index = $1 WHERE id = $2;',
          i,
          taskIdsOrder[i]
        );
      }
    }

    res.status(200).json({ success: true, message: 'Task moved successfully' });
  } catch (error: any) {
    console.error('Error moving kanban task:', error);
    res.status(500).json({ error: 'Failed to move kanban task' });
  }
};

/**
 * Reset columns and tasks to initial system defaults in database
 * POST /api/kanban/reset
 */
export const resetBoard = async (req: Request, res: Response) => {
  try {
    await prisma.$executeRawUnsafe('DELETE FROM kanban_tasks;');
    await prisma.$executeRawUnsafe('DELETE FROM kanban_columns;');

    res.status(200).json({ success: true, message: 'Kanban board cleared successfully' });
  } catch (error: any) {
    console.error('Error resetting kanban board:', error);
    res.status(500).json({ error: 'Failed to reset kanban board' });
  }
};
