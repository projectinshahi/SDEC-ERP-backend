import { Request, Response } from 'express';
import prisma from '../config/db.js';
import { io } from '../socket.js';
import { activityService } from '../services/activity.service.js';

export const getDiscussions = async (req: Request, res: Response) => {
  try {
    const taskId = String(req.params.id);
    if (!taskId || taskId === 'undefined') return res.status(400).json({ error: 'Task ID required' });

    const userId = Number((req as any).userId);
    const userRole = String((req as any).userRole || '').toLowerCase();

    // Validate access
    const task = await prisma.kanban_tasks.findUnique({ where: { id: taskId } });
    if (!task) return res.status(404).json({ error: 'Task not found' });

    const user = await prisma.users.findUnique({ where: { id: userId } });
    const isGlobalAdmin = userRole === 'admin' || userRole === 'super admin';
    const isAssignee = task.assignee && user?.name && task.assignee.toLowerCase() === user.name.toLowerCase();

    if (!isGlobalAdmin && !isAssignee) {
      // If we had project members, we'd check project admin here. For now, we restrict to global admin & assignee.
      return res.status(403).json({ error: 'Only the assignee and admins can view this discussion.' });
    }

    const messages = await prisma.task_discussions.findMany({
      where: { task_id: taskId },
      include: {
        sender: {
          select: { id: true, name: true, email: true }
        }
      },
      orderBy: { created_at: 'asc' }
    });

    res.status(200).json(messages);
  } catch (error) {
    console.error('Error fetching discussions:', error);
    res.status(500).json({ error: 'Failed to fetch discussions' });
  }
};

export const addMessage = async (req: Request, res: Response) => {
  try {
    const taskId = String(req.params.id);
    const { message } = req.body;
    const userId = Number((req as any).userId);

    if (!taskId || taskId === 'undefined' || !message) {
      return res.status(400).json({ error: 'Task ID and message are required' });
    }

    const userRole = String((req as any).userRole || '').toLowerCase();

    // Validate access
    const task = await prisma.kanban_tasks.findUnique({ where: { id: taskId } });
    if (!task) return res.status(404).json({ error: 'Task not found' });

    const user = await prisma.users.findUnique({ where: { id: userId } });
    const isGlobalAdmin = userRole === 'admin' || userRole === 'super admin';
    const isAssignee = task.assignee && user?.name && task.assignee.toLowerCase() === user.name.toLowerCase();

    if (!isGlobalAdmin && !isAssignee) {
      return res.status(403).json({ error: 'Only the assignee and admins can participate in this discussion.' });
    }

    const newMessage = await prisma.task_discussions.create({
      data: {
        task_id: taskId,
        sender_id: userId,
        message
      },
      include: {
        sender: {
          select: { id: true, name: true, email: true }
        }
      }
    });

    // Broadcast to room
    io.to(`task_${taskId}`).emit('new_message', newMessage);

    // Parse Mentions and create activity/notification if @username is present
    await activityService.extractAndLogMentions(message, userId, undefined, taskId, `Task Discussion`);

    res.status(201).json({ success: true, message: newMessage });
  } catch (error) {
    console.error('Error adding message:', error);
    res.status(500).json({ error: 'Failed to add message' });
  }
};

export const deleteMessage = async (req: Request, res: Response) => {
  try {
    const taskId = String(req.params.id);
    const messageId = String(req.params.messageId);
    const userId = Number((req as any).userId);

    const message = await prisma.task_discussions.findUnique({ where: { id: Number(messageId) } });
    if (!message) return res.status(404).json({ error: 'Message not found' });

    const userRole = String((req as any).userRole || '').toLowerCase();
    const isGlobalAdmin = userRole === 'admin' || userRole === 'super admin';

    // Allow deletion if sender or admin
    if (message.sender_id !== userId && !isGlobalAdmin) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    await prisma.task_discussions.delete({ where: { id: Number(messageId) } });

    io.to(`task_${taskId}`).emit('message_deleted', { messageId: Number(messageId) });

    res.status(200).json({ success: true, message: 'Message deleted' });
  } catch (error) {
    console.error('Error deleting message:', error);
    res.status(500).json({ error: 'Failed to delete message' });
  }
};

export const updateReadStatus = async (req: Request, res: Response) => {
  try {
    const taskId = String(req.params.id);
    const userId = Number((req as any).userId);

    if (!taskId || taskId === 'undefined') return res.status(400).json({ error: 'Task ID required' });

    await prisma.task_discussion_reads.upsert({
      where: {
        task_id_user_id: {
          task_id: taskId,
          user_id: userId
        }
      },
      update: {
        last_read_at: new Date()
      },
      create: {
        task_id: taskId,
        user_id: userId
      }
    });

    res.status(200).json({ success: true });
  } catch (error) {
    console.error('Error updating read status:', error);
    res.status(500).json({ error: 'Failed to update read status' });
  }
};
