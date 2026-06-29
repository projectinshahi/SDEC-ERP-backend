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
 * Sales Tickets — /api/sales/tickets. Sets module='sales'; the controller scopes
 * visibility to the creator/assignee (founders see all). Gated on the independent
 * sales.tickets.* permission set. Assigning to another user additionally requires
 * sales.tickets.assign (enforced by guardAssign), keeping it a distinct capability.
 */
const router = Router();

router.use((req: Request, _res: Response, next: NextFunction) => {
  (req as any).ticketModule = 'sales';
  next();
});

// Setting/changing the assignee is an independent capability (sales.tickets.assign).
const guardAssign = (req: Request, res: Response, next: NextFunction) => {
  const a = req.body?.assigned_to;
  if (a === undefined || a === null || a === '') return next();
  return checkPermission('sales.tickets.assign')(req, res, next);
};

router.get('/', authenticate, checkPermission('sales.tickets.view'), getTickets);
router.get('/:id', authenticate, checkPermission('sales.tickets.view'), getTicketById);
router.post('/', authenticate, checkPermission('sales.tickets.create'), guardAssign, createTicket);
router.put('/:id', authenticate, checkPermission('sales.tickets.edit'), guardAssign, updateTicket);
router.delete('/:id', authenticate, checkPermission('sales.tickets.delete'), deleteTicket);

// Discussions — any user who can view the ticket can participate.
router.get('/:id/discussions', authenticate, checkPermission('sales.tickets.view'), getDiscussions);
router.post('/:id/discussions', authenticate, checkPermission('sales.tickets.view'), addMessage);
router.delete('/:id/discussions/:messageId', authenticate, checkPermission('sales.tickets.view'), deleteMessage);
router.post('/:id/discussions/read', authenticate, checkPermission('sales.tickets.view'), updateReadStatus);

// Attachments
router.get('/:id/attachments', authenticate, checkPermission('sales.tickets.view'), getTicketAttachments);
router.post('/:id/attachments', authenticate, checkAnyPermission(['sales.tickets.create', 'sales.tickets.edit']), uploadMiddleware.array('files', 10), uploadTicketAttachment);
router.delete('/:id/attachments/:attachmentId', authenticate, checkPermission('sales.tickets.view'), deleteTicketAttachment);

export default router;
