import { Router } from 'express';
import { getDiscussions, addMessage, deleteMessage, updateReadStatus } from '../controllers/task_discussions.controller.js';
import { authenticate as authMiddleware } from '../middleware/auth.middleware.js';

const router = Router({ mergeParams: true });

// All routes are protected
router.use(authMiddleware);

// These routes will be mounted under /api/tasks/:id/discussions
router.get('/', getDiscussions);
router.post('/', addMessage);
router.delete('/:messageId', deleteMessage);
router.post('/read', updateReadStatus);

export default router;
