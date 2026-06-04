import { Router } from 'express';
import { 
  getBoards,
  createBoard,
  updateBoard,
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
  getBoardAnalytics
} from '../controllers/kanban.controller.js';
import { checkPermission } from '../middleware/auth.middleware.js';

const router = Router();

// Board routes
router.get('/boards', getBoards);
router.post('/boards', checkPermission('task.board.create'), createBoard);
router.put('/boards/:id', checkPermission('task.board.edit'), updateBoard);
router.delete('/boards/:id', checkPermission('task.board.delete'), deleteBoard);
router.get('/boards/:id/sprints', getSprintsForBoard);
router.get('/boards/:id/analytics', getBoardAnalytics);
router.get('/boards/:id/tasks', getTasksByBoard); // New RESTful strict task fetcher

// Columns routes
router.get('/boards/:id/columns', getColumns);
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
