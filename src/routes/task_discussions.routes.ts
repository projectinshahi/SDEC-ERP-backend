import { Router } from 'express';
import { getDiscussions, addMessage, deleteMessage, updateReadStatus } from '../controllers/task_discussions.controller.js';
import { authenticate as authMiddleware, checkPermission } from '../middleware/auth.middleware.js';

const router = Router({ mergeParams: true });

// All routes are protected
router.use(authMiddleware);

// These routes will be mounted under /api/tasks/:id/discussions.
//
// The rows behind them are kanban_tasks, so they take the kanban module's own
// permissions: `task.read` to read, `task.update` to write. That is the split
// bug discussions already use (bug.routes.ts) and the split THIS task's own
// attachment sub-resource already uses (kanban.routes.ts). No new key.
//
// Reading also matches the Socket.IO task-room rule (utils/roomAccess), so the
// HTTP and websocket doors onto the same discussion now agree.
router.get('/', checkPermission('task.read'), getDiscussions);
router.post('/', checkPermission('task.update'), addMessage);
router.delete('/:messageId', checkPermission('task.update'), deleteMessage);
router.post('/read', checkPermission('task.read'), updateReadStatus);

export default router;
