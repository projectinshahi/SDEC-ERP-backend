import { Router } from 'express';
import { getBugs, getBugById, createBug, updateBug, deleteBug, getBugAnalytics } from '../controllers/bug.controller.js';
import { getDiscussions, addMessage, deleteMessage, updateReadStatus } from '../controllers/bug_discussions.controller.js';
import { uploadBugAttachment, getBugAttachments, deleteBugAttachment, uploadMiddleware } from '../controllers/bug_attachments.controller.js';
import { authenticate, checkPermission } from '../middleware/auth.middleware.js';

const router = Router();

router.get('/', authenticate, checkPermission('bugs.read'), getBugs);
router.get('/analytics', authenticate, checkPermission('bugs.read'), getBugAnalytics);
router.get('/:id', authenticate, checkPermission('bugs.read'), getBugById);
router.post('/', authenticate, checkPermission('bugs.create'), createBug);
router.put('/:id', authenticate, checkPermission('bugs.update'), updateBug);
router.delete('/:id', authenticate, checkPermission('bugs.delete'), deleteBug);

// Discussion routes — reading requires bugs.read; writing/deleting requires bugs.update.
router.get('/:id/discussions', authenticate, checkPermission('bugs.read'), getDiscussions);
router.post('/:id/discussions', authenticate, checkPermission('bugs.update'), addMessage);
router.delete('/:id/discussions/:messageId', authenticate, checkPermission('bugs.update'), deleteMessage);
router.post('/:id/discussions/read', authenticate, checkPermission('bugs.read'), updateReadStatus);

// Attachment routes — reading requires bugs.read; uploading/deleting requires bugs.update.
router.get('/:id/attachments', authenticate, checkPermission('bugs.read'), getBugAttachments);
router.post('/:id/attachments', authenticate, checkPermission('bugs.update'), uploadMiddleware.array('files', 10), uploadBugAttachment);
router.delete('/:id/attachments/:attachmentId', authenticate, checkPermission('bugs.update'), deleteBugAttachment);

export default router;
