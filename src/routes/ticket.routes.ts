import { Router, Request, Response, NextFunction } from 'express';
import {
  getTickets,
  getTicketById,
  createTicket,
  updateTicket,
  deleteTicket,
} from '../controllers/ticket.controller.js';
import { getDiscussions, addMessage, deleteMessage, updateReadStatus } from '../controllers/ticket_discussions.controller.js';
import { uploadTicketAttachment, getTicketAttachments, deleteTicketAttachment, uploadMiddleware } from '../controllers/ticket_attachments.controller.js';
import { authenticate, checkPermission, checkAnyPermission } from '../middleware/auth.middleware.js';

/**
 * Development Tickets — /api/tickets. Project-scoped (the /dashboard/tickets
 * page). Sets module='development' so it shares the tickets table + controller
 * with the Sales variant. Gated on the Development tickets.* permission set.
 */
const router = Router();

// Tag every request with the development module before the controllers run.
router.use((req: Request, _res: Response, next: NextFunction) => {
  (req as any).ticketModule = 'development';
  next();
});

router.get('/', authenticate, checkPermission('tickets.read'), getTickets);
router.get('/:id', authenticate, checkPermission('tickets.read'), getTicketById);
router.post('/', authenticate, checkPermission('tickets.create'), createTicket);
router.put('/:id', authenticate, checkPermission('tickets.update'), updateTicket);
router.delete('/:id', authenticate, checkPermission('tickets.delete'), deleteTicket);

// Discussions
router.get('/:id/discussions', authenticate, checkPermission('tickets.read'), getDiscussions);
router.post('/:id/discussions', authenticate, checkPermission('tickets.read'), addMessage);
router.delete('/:id/discussions/:messageId', authenticate, checkPermission('tickets.read'), deleteMessage);
router.post('/:id/discussions/read', authenticate, checkPermission('tickets.read'), updateReadStatus);

// Attachments
router.get('/:id/attachments', authenticate, checkPermission('tickets.read'), getTicketAttachments);
router.post('/:id/attachments', authenticate, checkAnyPermission(['tickets.create', 'tickets.update']), uploadMiddleware.array('files', 10), uploadTicketAttachment);
router.delete('/:id/attachments/:attachmentId', authenticate, checkPermission('tickets.read'), deleteTicketAttachment);

export default router;
