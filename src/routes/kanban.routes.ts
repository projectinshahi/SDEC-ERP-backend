import { Router } from 'express';
import { 
  getColumns, 
  createColumn, 
  updateColumn, 
  deleteColumn, 
  reorderColumns, 
  getTasks, 
  createTask, 
  updateTask, 
  deleteTask, 
  moveTask, 
  resetBoard 
} from '../controllers/kanban.controller.js';
import { checkPermission } from '../middleware/auth.middleware';

const router = Router();

// Columns routes
router.get('/columns', getColumns);
router.post('/columns', checkPermission('task.column.create'), createColumn);
router.put('/columns/:id', checkPermission('task.column.update'), updateColumn);
router.delete('/columns/:id', checkPermission('task.column.delete'), deleteColumn);
router.post('/columns/reorder', checkPermission('task.column.update'), reorderColumns);

// Tasks routes
router.get('/tasks', getTasks);
router.post('/tasks', createTask);
router.put('/tasks/:id', updateTask);
router.delete('/tasks/:id', deleteTask);
router.post('/tasks/move', moveTask);

// Reset route
router.post('/reset', checkPermission('task.board.delete'), resetBoard);

export default router;
