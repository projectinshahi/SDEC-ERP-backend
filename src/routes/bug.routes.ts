import { Router } from 'express';
import { getBugs, getBugById, createBug, updateBug, deleteBug } from '../controllers/bug.controller.js';
import { getDiscussions, addMessage, deleteMessage, updateReadStatus } from '../controllers/bug_discussions.controller.js';
import { uploadBugAttachment, getBugAttachments, deleteBugAttachment, uploadMiddleware } from '../controllers/bug_attachments.controller.js';
import { authenticate } from '../middleware/auth.middleware.js';

const router = Router();

router.get('/', getBugs);
router.get('/:id', getBugById);
router.post('/', createBug);
router.put('/:id', updateBug);
router.delete('/:id', deleteBug);

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
