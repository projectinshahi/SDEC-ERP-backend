import { Router } from 'express';
import { 
  getBoards,
  createBoard,
  updateBoard,
  updateBoardStatus,
  deleteBoard,
  getSprintsForBoard,
  getColumns, 
  createColumn, 
  updateColumn, 
  deleteColumn, 
  reorderColumns, 
  getTasksByBoard, 
  createTask, 
  updateTask, 
  deleteTask, 
  moveTask, 
  cloneTask,
  resetBoard,
  getBoardAnalytics,
  createSprint,
  updateSprint,
  updateSprintStatus
} from '../controllers/kanban.controller.js';
import { checkPermission, authenticate } from '../middleware/auth.middleware.js';

const router = Router();

// Sprint management — gated INSIDE the controller on `sprints.status.manage`
// (or SuperAdmin), separate from the shared board endpoints below so the Boards
// page is unaffected. These power Project Details → Sprint Management.
router.post('/sprints', authenticate, createSprint);
router.put('/sprints/:id', authenticate, updateSprint);
router.patch('/sprints/:id/status', authenticate, updateSprintStatus);

// Board routes — reads now require authentication (these GETs were previously
// fully OPEN to anonymous callers); board mutations require the board permission.
router.get('/boards', authenticate, checkPermission('task.read'), getBoards);
router.post('/boards', checkPermission('task.board.create'), createBoard);
router.put('/boards/:id', authenticate, checkPermission('task.board.edit'), updateBoard);
router.patch('/boards/:id/status', authenticate, checkPermission('task.board.edit'), updateBoardStatus);
router.delete('/boards/:id', authenticate, checkPermission('task.board.delete'), deleteBoard);
router.get('/boards/:id/sprints', authenticate, checkPermission('task.read'), getSprintsForBoard);
router.get('/boards/:id/analytics', authenticate, checkPermission('task.read'), getBoardAnalytics);
router.get('/boards/:id/tasks', authenticate, checkPermission('task.read'), getTasksByBoard); // New RESTful strict task fetcher

// Columns routes
router.get('/boards/:id/columns', authenticate, checkPermission('task.read'), getColumns);
router.post('/columns', checkPermission('task.column.create'), createColumn);
router.put('/columns/:id', checkPermission('task.column.update'), updateColumn);
router.delete('/columns/:id', checkPermission('task.column.delete'), deleteColumn);
router.post('/columns/reorder', checkPermission('task.column.update'), reorderColumns);

// Tasks routes (mutations)
router.post('/tasks', checkPermission('task.create'), createTask);
router.put('/tasks/:id', checkPermission('task.update'), updateTask);
router.delete('/tasks/:id', checkPermission('task.delete'), deleteTask);
router.post('/tasks/move', checkPermission('task.update'), moveTask);
router.post('/tasks/:id/clone', checkPermission('task.create'), cloneTask);

// Task Attachments
import { uploadTaskAttachment, deleteTaskAttachment, uploadMiddleware } from '../controllers/task_attachments.controller.js';
router.post('/tasks/:id/attachments', checkPermission('task.update'), uploadMiddleware.array('files'), uploadTaskAttachment);
router.delete('/tasks/:id/attachments/:attachmentId', checkPermission('task.update'), deleteTaskAttachment);

// Reset route
router.post('/reset', checkPermission('task.board.delete'), resetBoard);

export default router;
