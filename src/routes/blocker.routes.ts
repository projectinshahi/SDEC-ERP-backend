import { Router } from 'express';
import {
  getBlockers,
  getBlockerById,
  createBlocker,
  updateBlocker,
  deleteBlocker,
} from '../controllers/blocker.controller.js';
import { getDiscussions, addMessage, deleteMessage, updateReadStatus } from '../controllers/blocker_discussions.controller.js';
import { uploadBlockerAttachment, getBlockerAttachments, deleteBlockerAttachment, uploadMiddleware } from '../controllers/blocker_attachments.controller.js';
import { authenticate, checkPermission } from '../middleware/auth.middleware.js';
import { checkBlockerProjectAccess } from '../middleware/blocker.middleware.js';

const router = Router();

// Listing required the Tickets/Blockers view permission (the list previously
// returned every blocker org-wide to any authenticated caller). Creating a
// blocker was entirely ungated — now requires the create permission.
router.get('/', authenticate, checkPermission('blockers.read'), getBlockers);
router.get('/:id', authenticate, checkBlockerProjectAccess(), getBlockerById);
router.post('/', authenticate, checkPermission('blockers.create'), createBlocker);
router.put('/:id', authenticate, checkBlockerProjectAccess(['admin', 'manager', 'editor']), updateBlocker);
router.delete('/:id', authenticate, checkBlockerProjectAccess(['admin']), deleteBlocker);

// Discussion routes
router.get('/:id/discussions', authenticate, checkBlockerProjectAccess(), getDiscussions);
router.post('/:id/discussions', authenticate, checkBlockerProjectAccess(['admin', 'manager', 'editor', 'member']), addMessage);
router.delete('/:id/discussions/:messageId', authenticate, checkBlockerProjectAccess(['admin']), deleteMessage);
router.post('/:id/discussions/read', authenticate, checkBlockerProjectAccess(), updateReadStatus);

// Attachment routes
router.get('/:id/attachments', authenticate, checkBlockerProjectAccess(), getBlockerAttachments);
router.post('/:id/attachments', authenticate, checkBlockerProjectAccess(['admin', 'manager', 'editor', 'member']), uploadMiddleware.array('files', 10), uploadBlockerAttachment);
router.delete('/:id/attachments/:attachmentId', authenticate, checkBlockerProjectAccess(['admin']), deleteBlockerAttachment);

export default router;
