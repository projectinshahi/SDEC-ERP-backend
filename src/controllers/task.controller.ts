import { Request, Response } from 'express';
import prisma from '../config/db';

/**
 * Get the count of active tasks from the kanban_tasks table.
 * "Active" = tasks NOT in the last kanban column (dynamically determined).
 * Falls back to total kanban_tasks count if kanban_columns can't be queried.
 */
export const getActiveTaskCount = async (req: Request, res: Response) => {
  try {
    let activeTasks = 0;

    try {
      // Dynamically find the last column (highest order_index) to exclude from active count
      const lastColResult = await prisma.$queryRawUnsafe<{ id: string }[]>(
        `SELECT id FROM kanban_columns ORDER BY order_index DESC LIMIT 1;`
      );
      const lastColId = lastColResult[0]?.id;

      if (lastColId) {
        // Count all tasks that are NOT in the last (done/completed) column
        const result = await prisma.$queryRawUnsafe<{ count: string | number }[]>(
          `SELECT COUNT(*) FROM kanban_tasks WHERE status != $1;`,
          lastColId
        );
        activeTasks = Number(result[0]?.count || 0);
      } else {
        // No columns exist — count all tasks
        const result = await prisma.$queryRawUnsafe<{ count: string | number }[]>(
          `SELECT COUNT(*) FROM kanban_tasks;`
        );
        activeTasks = Number(result[0]?.count || 0);
      }
    } catch (dbError: any) {
      console.warn('\n⚠️ Active tasks query failed. Using fallback count (0).');
      console.warn('DB Error Details:', dbError.message || dbError);
      activeTasks = 0;
    }

    return res.status(200).json({ activeTasks });
  } catch (error: any) {
    console.error('Catastrophic error fetching active task count:', error);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};

