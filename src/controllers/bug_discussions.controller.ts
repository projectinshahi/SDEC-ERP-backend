import { Request, Response } from 'express';
import prisma from '../config/db.js';
import { io } from '../socket.js';
import { activityService } from '../services/activity.service.js';

export const getDiscussions = async (req: Request, res: Response) => {
  try {
    const bugId = Number(req.params.id);
    if (isNaN(bugId)) return res.status(400).json({ error: 'Valid Bug ID required' });

    // Validate access
    const bug = await prisma.bugs.findUnique({ where: { id: bugId } });
    if (!bug) return res.status(404).json({ error: 'Bug not found' });

    // Assuming any authenticated user can view bugs for now.

    const messages = await prisma.bug_discussions.findMany({
      where: { bug_id: bugId },
      include: {
        sender: {
          select: { id: true, name: true, email: true }
        }
      },
      orderBy: { created_at: 'asc' }
    });

    res.status(200).json(messages);
  } catch (error) {
    console.error('Error fetching bug discussions:', error);
    res.status(500).json({ error: 'Failed to fetch discussions' });
  }
};

export const addMessage = async (req: Request, res: Response) => {
  try {
    const bugId = Number(req.params.id);
    const { message } = req.body;
    const userId = Number((req as any).userId);

    if (isNaN(bugId) || !message) {
      return res.status(400).json({ error: 'Bug ID and message are required' });
    }

    // Validate access
    const bug = await prisma.bugs.findUnique({ where: { id: bugId } });
    if (!bug) return res.status(404).json({ error: 'Bug not found' });

    const newMessage = await prisma.bug_discussions.create({
      data: {
        bug_id: bugId,
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
    io.to(`bug_${bugId}`).emit('new_message', newMessage);

    // Parse Mentions and create activity/notification if @username is present
    await activityService.extractAndLogMentions(message, userId, undefined, undefined, `Bug #${bugId} Discussion`);

    res.status(201).json({ success: true, message: newMessage });
  } catch (error) {
    console.error('Error adding bug message:', error);
    res.status(500).json({ error: 'Failed to add message' });
  }
};

export const deleteMessage = async (req: Request, res: Response) => {
  try {
    const bugId = Number(req.params.id);
    const messageId = Number(req.params.messageId);
    const userId = Number((req as any).userId);

    const message = await prisma.bug_discussions.findUnique({ where: { id: messageId } });
    if (!message) return res.status(404).json({ error: 'Message not found' });

    const userRole = String((req as any).userRole || '').toLowerCase();
    const isGlobalAdmin = userRole === 'admin' || userRole === 'super admin';

    // Allow deletion if sender or admin
    if (message.sender_id !== userId && !isGlobalAdmin) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    await prisma.bug_discussions.delete({ where: { id: messageId } });

    io.to(`bug_${bugId}`).emit('message_deleted', { messageId });

    res.status(200).json({ success: true, message: 'Message deleted' });
  } catch (error) {
    console.error('Error deleting bug message:', error);
    res.status(500).json({ error: 'Failed to delete message' });
  }
};

export const updateReadStatus = async (req: Request, res: Response) => {
  try {
    const bugId = Number(req.params.id);
    const userId = Number((req as any).userId);

    if (isNaN(bugId)) return res.status(400).json({ error: 'Valid Bug ID required' });

    await prisma.bug_discussion_reads.upsert({
      where: {
        bug_id_user_id: {
          bug_id: bugId,
          user_id: userId
        }
      },
      update: {
        last_read_at: new Date()
      },
      create: {
        bug_id: bugId,
        user_id: userId
      }
    });

    res.status(200).json({ success: true });
  } catch (error) {
    console.error('Error updating read status for bug discussion:', error);
    res.status(500).json({ error: 'Failed to update read status' });
  }
};
