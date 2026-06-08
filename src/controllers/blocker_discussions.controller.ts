import { Request, Response } from 'express';
import prisma from '../config/db.js';
import { io } from '../socket.js';
import { activityService } from '../services/activity.service.js';
import { notificationService } from '../services/notification.service.js';

export const getDiscussions = async (req: Request, res: Response) => {
  try {
    const blockerId = Number(req.params.id);
    if (isNaN(blockerId)) return res.status(400).json({ error: 'Valid Blocker ID required' });

    // Validate access
    const blocker = await prisma.blocker.findUnique({ where: { id: blockerId } });
    if (!blocker) return res.status(404).json({ error: 'Blocker not found' });

    const messages = await prisma.blocker_discussions.findMany({
      where: { blocker_id: blockerId },
      include: {
        sender: {
          select: { id: true, name: true, email: true }
        }
      },
      orderBy: { created_at: 'asc' }
    });

    res.status(200).json(messages);
  } catch (error) {
    console.error('Error fetching blocker discussions:', error);
    res.status(500).json({ error: 'Failed to fetch discussions' });
  }
};

export const addMessage = async (req: Request, res: Response) => {
  try {
    const blockerId = Number(req.params.id);
    const { message } = req.body;
    const userId = Number((req as any).userId);

    if (isNaN(blockerId) || !message) {
      return res.status(400).json({ error: 'Blocker ID and message are required' });
    }

    // Validate access
    const blocker = await prisma.blocker.findUnique({ where: { id: blockerId } });
    if (!blocker) return res.status(404).json({ error: 'Blocker not found' });

    const newMessage = await prisma.blocker_discussions.create({
      data: {
        blocker_id: blockerId,
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
    io.to(`blocker_${blockerId}`).emit('new_message', newMessage);

    // Parse Mentions and create activity/notification if @username is present
    await activityService.extractAndLogMentions(message, userId, undefined, undefined, `Blocker #${blockerId} Discussion`);

    // Log the message activity
    await activityService.logActivity({
      actorUserId: userId,
      projectId: blocker.projectId,
      type: 'blocker_comment_added',
      description: `Added a comment to Blocker #${blockerId}`
    });

    // Notify blocker reporter and assignee about the new message
    const notifyUsers = new Set<number>();
    if (blocker.loggedById !== userId) notifyUsers.add(blocker.loggedById);
    if (blocker.helpNeededFromId && blocker.helpNeededFromId !== userId) notifyUsers.add(blocker.helpNeededFromId);
    
    await notificationService.createNotifications(Array.from(notifyUsers), {
      type: 'discussion',
      title: 'New Blocker Discussion Message',
      message: `${newMessage.sender.name} sent a message in: "${blocker.title}"`,
      entityType: 'blocker',
      entityId: blocker.id
    });

    res.status(201).json({ success: true, message: newMessage });
  } catch (error) {
    console.error('Error adding blocker message:', error);
    res.status(500).json({ error: 'Failed to add message' });
  }
};

export const deleteMessage = async (req: Request, res: Response) => {
  try {
    const blockerId = Number(req.params.id);
    const messageId = Number(req.params.messageId);
    const userId = Number((req as any).userId);

    const message = await prisma.blocker_discussions.findUnique({ where: { id: messageId } });
    if (!message) return res.status(404).json({ error: 'Message not found' });

    const userRole = String((req as any).userRole || '').toLowerCase();
    const isGlobalAdmin = userRole === 'admin' || userRole === 'super admin';

    // Allow deletion if sender or admin
    if (message.sender_id !== userId && !isGlobalAdmin) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    await prisma.blocker_discussions.delete({ where: { id: messageId } });

    io.to(`blocker_${blockerId}`).emit('message_deleted', { messageId });

    res.status(200).json({ success: true, message: 'Message deleted' });
  } catch (error) {
    console.error('Error deleting blocker message:', error);
    res.status(500).json({ error: 'Failed to delete message' });
  }
};

export const updateReadStatus = async (req: Request, res: Response) => {
  try {
    const blockerId = Number(req.params.id);
    const userId = Number((req as any).userId);

    if (isNaN(blockerId)) return res.status(400).json({ error: 'Valid Blocker ID required' });

    await prisma.blocker_discussion_reads.upsert({
      where: {
        blocker_id_user_id: {
          blocker_id: blockerId,
          user_id: userId
        }
      },
      update: {
        last_read_at: new Date()
      },
      create: {
        blocker_id: blockerId,
        user_id: userId
      }
    });

    res.status(200).json({ success: true });
  } catch (error) {
    console.error('Error updating read status for blocker discussion:', error);
    res.status(500).json({ error: 'Failed to update read status' });
  }
};
