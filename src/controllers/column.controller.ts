import { Request, Response } from 'express';
import prisma from '../config/db.js';

/**
 * Fetch column configurations for a specific table
 * GET /api/columns?table=users
 */
export const getColumns = async (req: Request, res: Response) => {
  try {
    const { table } = req.query;
    if (!table) {
      return res.status(400).json({ error: 'Table parameter is required' });
    }

    const columns = await prisma.$queryRawUnsafe<any[]>(
      'SELECT id, table_name, column_key as key, column_label as label, is_visible as visible, order_index as "order" FROM column_config WHERE table_name = $1 ORDER BY order_index ASC;',
      table
    );

    res.status(200).json(columns);
  } catch (error: any) {
    console.error('Error fetching column configs:', error);
    res.status(500).json({ error: 'Failed to fetch column configurations' });
  }
};

/**
 * Save / Update bulk column configurations
 * POST /api/columns
 */
export const updateColumns = async (req: Request, res: Response) => {
  try {
    const { table, columns } = req.body;

    if (!table || !Array.isArray(columns)) {
      return res.status(400).json({ error: 'Table name and columns array are required' });
    }

    // Sequentially update each column's label, visibility, and order index
    for (const col of columns) {
      if (!col.key) continue;

      const isVisible = col.visible !== undefined ? Boolean(col.visible) : true;
      const orderVal = col.order !== undefined ? Number(col.order) : 0;
      const labelVal = col.label || '';

      await prisma.$executeRawUnsafe(
        'UPDATE column_config SET column_label = $1, is_visible = $2, order_index = $3 WHERE table_name = $4 AND column_key = $5;',
        labelVal,
        isVisible,
        orderVal,
        table,
        col.key
      );
    }

    res.status(200).json({ success: true, message: 'Column configurations updated successfully' });
  } catch (error: any) {
    console.error('Error updating column configs:', error);
    res.status(500).json({ error: 'Failed to update column configurations' });
  }
};
