import { Router } from 'express';
import { getBugs, getBugById, createBug, updateBug, deleteBug, getBugAnalytics } from '../controllers/bug.controller.js';
import { getDiscussions, addMessage, deleteMessage, updateReadStatus } from '../controllers/bug_discussions.controller.js';
import { uploadBugAttachment, getBugAttachments, deleteBugAttachment, uploadMiddleware } from '../controllers/bug_attachments.controller.js';
import { authenticate, checkPermission } from '../middleware/auth.middleware.js';

const router = Router();

router.get('/', authenticate, getBugs);
router.get('/analytics', authenticate, getBugAnalytics);
router.get('/:id', authenticate, getBugById);
router.post('/', authenticate, checkPermission('bugs.create'), createBug);
router.put('/:id', authenticate, checkPermission('bugs.update'), updateBug);
router.delete('/:id', authenticate, checkPermission('bugs.delete'), deleteBug);

// Discussion routes
router.get('/:id/discussions', authenticate, getDiscussions);
router.post('/:id/discussions', authenticate, addMessage);
router.delete('/:id/discussions/:messageId', authenticate, deleteMessage);
router.post('/:id/discussions/read', authenticate, updateReadStatus);

// Attachment routes
router.get('/:id/attachments', authenticate, getBugAttachments);
router.post('/:id/attachments', authenticate, uploadMiddleware.array('files', 10), uploadBugAttachment);
router.delete('/:id/attachments/:attachmentId', authenticate, deleteBugAttachment);

export default router;
