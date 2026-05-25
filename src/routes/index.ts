import { Router } from 'express';
import userRoutes from './user.routes';
import taskRoutes from './task.routes';
import authRoutes from './auth.routes';
import roleRoutes from './role.routes';
import columnRoutes from './column.routes';
import kanbanRoutes from './kanban.routes';

const router = Router();

router.use('/auth', authRoutes);
router.use('/users', userRoutes);
router.use('/tasks', taskRoutes);
router.use('/roles', roleRoutes);
router.use('/columns', columnRoutes);
router.use('/kanban', kanbanRoutes);

export default router;
