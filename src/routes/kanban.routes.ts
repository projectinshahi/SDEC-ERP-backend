import { Router } from 'express';
import { 
  getBoards,
  createBoard,
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
  resetBoard 
} from '../controllers/kanban.controller.js';
import { checkPermission } from '../middleware/auth.middleware.js';

const router = Router();

// Board routes
router.get('/boards', getBoards);
router.post('/boards', createBoard);
router.delete('/boards/:id', deleteBoard);
router.get('/boards/:id/sprints', getSprintsForBoard);
router.get('/boards/:id/tasks', getTasksByBoard); // New RESTful strict task fetcher

// Columns routes
router.get('/boards/:id/columns', getColumns);
router.post('/columns', checkPermission('task.column.create'), createColumn);
router.put('/columns/:id', checkPermission('task.column.update'), updateColumn);
router.delete('/columns/:id', checkPermission('task.column.delete'), deleteColumn);
router.post('/columns/reorder', checkPermission('task.column.update'), reorderColumns);

// Tasks routes (mutations)
router.post('/tasks', createTask);
router.put('/tasks/:id', updateTask);
router.delete('/tasks/:id', deleteTask);
router.post('/tasks/move', moveTask);

// Reset route
router.post('/reset', checkPermission('task.board.delete'), resetBoard);

export default router;
