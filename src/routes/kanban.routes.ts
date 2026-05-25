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
} from '../controllers/kanban.controller';

const router = Router();

// Columns routes
router.get('/columns', getColumns);
router.post('/columns', createColumn);
router.put('/columns/:id', updateColumn);
router.delete('/columns/:id', deleteColumn);
router.post('/columns/reorder', reorderColumns);

// Tasks routes
router.get('/tasks', getTasks);
router.post('/tasks', createTask);
router.put('/tasks/:id', updateTask);
router.delete('/tasks/:id', deleteTask);
router.post('/tasks/move', moveTask);

// Reset route
router.post('/reset', resetBoard);

export default router;
