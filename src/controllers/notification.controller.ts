import { Request, Response } from 'express';
import prisma from '../config/db.js';

export const getNotifications = async (req: Request, res: Response) => {
  try {
    const userId = Number((req as any).userId);
    const { page = 1, limit = 20, filter = 'all' } = req.query;
    
    const pageNum = Number(page);
    const limitNum = Number(limit);
    const skip = (pageNum - 1) * limitNum;

    const where: any = { user_id: userId };
    
    if (filter === 'unread') {
      where.is_read = false;
    } else if (filter === 'assignments') {
      where.type = { in: ['assignment', 'reassignment'] };
    } else if (filter === 'mentions') {
      where.type = 'mention';
    } else if (filter === 'status updates') {
      where.type = 'status_change';
    } else if (filter === 'escalations') {
      where.type = 'escalation';
    }

    const [notifications, total] = await Promise.all([
      prisma.notifications.findMany({
        where,
        orderBy: { created_at: 'desc' },
        skip,
        take: limitNum,
      }),
      prisma.notifications.count({ where })
    ]);

    const unreadCount = await prisma.notifications.count({
      where: { user_id: userId, is_read: false }
    });

    res.status(200).json({
      notifications,
      pagination: {
        total,
        page: pageNum,
        limit: limitNum,
        totalPages: Math.ceil(total / limitNum)
      },
      unreadCount
    });
  } catch (error) {
    console.error('Error fetching notifications:', error);
    res.status(500).json({ error: 'Failed to fetch notifications' });
  }
};

export const markAsRead = async (req: Request, res: Response) => {
  try {
    const notificationId = Number(req.params.id);
    const userId = Number((req as any).userId);

    if (isNaN(notificationId)) {
      return res.status(400).json({ error: 'Valid Notification ID required' });
    }

    const notification = await prisma.notifications.findUnique({
      where: { id: notificationId }
    });

    if (!notification || notification.user_id !== userId) {
      return res.status(404).json({ error: 'Notification not found' });
    }

    const updated = await prisma.notifications.update({
      where: { id: notificationId },
      data: { is_read: true }
    });

    res.status(200).json({ success: true, notification: updated });
  } catch (error) {
    console.error('Error marking notification as read:', error);
    res.status(500).json({ error: 'Failed to mark notification as read' });
  }
};

export const markAllAsRead = async (req: Request, res: Response) => {
  try {
    const userId = Number((req as any).userId);

    await prisma.notifications.updateMany({
      where: { user_id: userId, is_read: false },
      data: { is_read: true }
    });

    res.status(200).json({ success: true });
  } catch (error) {
    console.error('Error marking all notifications as read:', error);
    res.status(500).json({ error: 'Failed to mark all as read' });
  }
};
