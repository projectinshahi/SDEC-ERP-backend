import { Request, Response } from 'express';
import prisma from '../config/db.js';
import { io } from '../socket.js';
import { isGlobalAdmin } from '../utils/roles.js';
import { activityService } from '../services/activity.service.js';
import { notificationService } from '../services/notification.service.js';
import { canAccessSalesTicket } from './ticket.controller.js';

export const getDiscussions = async (req: Request, res: Response) => {
  try {
    const ticketId = Number(req.params.id);
    if (isNaN(ticketId)) return res.status(400).json({ error: 'Valid Ticket ID required' });

    const ticket = await prisma.ticket.findUnique({ where: { id: ticketId } });
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
    if (!canAccessSalesTicket(ticket, Number((req as any).userId), isGlobalAdmin((req as any).userRole || ''))) {
      return res.status(403).json({ error: 'Forbidden: you do not have access to this ticket' });
    }

    const messages = await prisma.ticket_discussions.findMany({
      where: { ticket_id: ticketId },
      include: { sender: { select: { id: true, name: true, email: true } } },
      orderBy: { created_at: 'asc' },
    });

    res.status(200).json(messages);
  } catch (error) {
    console.error('Error fetching ticket discussions:', error);
    res.status(500).json({ error: 'Failed to fetch discussions' });
  }
};

export const addMessage = async (req: Request, res: Response) => {
  try {
    const ticketId = Number(req.params.id);
    const { message } = req.body;
    const userId = Number((req as any).userId);

    if (isNaN(ticketId) || !message) {
      return res.status(400).json({ error: 'Ticket ID and message are required' });
    }

    const ticket = await prisma.ticket.findUnique({ where: { id: ticketId } });
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
    if (!canAccessSalesTicket(ticket, userId, isGlobalAdmin((req as any).userRole || ''))) {
      return res.status(403).json({ error: 'Forbidden: you do not have access to this ticket' });
    }

    const newMessage = await prisma.ticket_discussions.create({
      data: { ticket_id: ticketId, sender_id: userId, message },
      include: { sender: { select: { id: true, name: true, email: true } } },
    });

    io.to(`ticket_${ticketId}`).emit('new_message', newMessage);

    await activityService.extractAndLogMentions(message, userId, undefined, undefined, `Ticket #${ticketId} Discussion`);
    await activityService.logActivity({
      actorUserId: userId,
      ticketId,
      projectId: ticket.projectId || undefined,
      leadId: ticket.leadId || undefined,
      dealId: ticket.dealId || undefined,
      type: 'ticket_comment_added',
      description: `Added a comment to Ticket #${ticketId}`,
    });

    // Notify ticket creator + assignee about the new message (excluding actor).
    const recipients = new Set<number>();
    if (ticket.createdBy !== userId) recipients.add(ticket.createdBy);
    if (ticket.assignedTo && ticket.assignedTo !== userId) recipients.add(ticket.assignedTo);
    await notificationService.createNotifications(Array.from(recipients), {
      type: 'discussion',
      title: 'New Ticket Discussion Message',
      message: `${newMessage.sender.name} sent a message in: "${ticket.title}"`,
      entityType: 'ticket',
      entityId: ticket.id,
    });

    res.status(201).json({ success: true, message: newMessage });
  } catch (error) {
    console.error('Error adding ticket message:', error);
    res.status(500).json({ error: 'Failed to add message' });
  }
};

export const deleteMessage = async (req: Request, res: Response) => {
  try {
    const ticketId = Number(req.params.id);
    const messageId = Number(req.params.messageId);
    const userId = Number((req as any).userId);

    const message = await prisma.ticket_discussions.findUnique({ where: { id: messageId } });
    if (!message) return res.status(404).json({ error: 'Message not found' });

    const isAdmin = isGlobalAdmin((req as any).userRole || '');
    if (message.sender_id !== userId && !isAdmin) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    await prisma.ticket_discussions.delete({ where: { id: messageId } });
    io.to(`ticket_${ticketId}`).emit('message_deleted', { messageId });

    res.status(200).json({ success: true, message: 'Message deleted' });
  } catch (error) {
    console.error('Error deleting ticket message:', error);
    res.status(500).json({ error: 'Failed to delete message' });
  }
};

export const updateReadStatus = async (req: Request, res: Response) => {
  try {
    const ticketId = Number(req.params.id);
    const userId = Number((req as any).userId);
    if (isNaN(ticketId)) return res.status(400).json({ error: 'Valid Ticket ID required' });

    await prisma.ticket_discussion_reads.upsert({
      where: { ticket_id_user_id: { ticket_id: ticketId, user_id: userId } },
      update: { last_read_at: new Date() },
      create: { ticket_id: ticketId, user_id: userId },
    });

    res.status(200).json({ success: true });
  } catch (error) {
    console.error('Error updating read status for ticket discussion:', error);
    res.status(500).json({ error: 'Failed to update read status' });
  }
};
