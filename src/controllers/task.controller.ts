import { Request, Response } from 'express';
import prisma from '../config/db';

/**
 * Get the count of active tasks (where status != 'done')
 * Integrates database resilience fallback to return 45 on DB/table error.
 */
export const getActiveTaskCount = async (req: Request, res: Response) => {
  try {
    let activeTasks = 0;

    try {
      // Execute the requested raw SQL query
      const result = await prisma.$queryRawUnsafe<{ count: string | number }[]>(
        "SELECT COUNT(*) FROM tasks WHERE status != 'done';"
      );
      // PostgreSQL COUNT returns a bigint/string, so we cast it safely to a number
      activeTasks = Number(result[0]?.count || 0);
    } catch (dbError: any) {
      console.warn('\n⚠️ Raw SQL active tasks query failed. Using mock count (45) fallback.');
      console.warn('👉 Ensure a "tasks" table exists in your Neon database with a "status" column.');
      console.warn('DB Error Details:', dbError.message || dbError);
      console.warn('Displaying fallback mock active tasks count of 45 in the UI.\n');
      
      // Fallback: If table tasks doesn't exist or DB isn't configured, we use the specified mock default
      activeTasks = 45;
    }

    return res.status(200).json({ activeTasks });
  } catch (error: any) {
    console.error('Catastrophic error fetching active task count:', error);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};
