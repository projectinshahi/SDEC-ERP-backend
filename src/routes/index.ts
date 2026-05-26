import { Router } from 'express';
import userRoutes from './user.routes.js';
import taskRoutes from './task.routes.js';
import authRoutes from './auth.routes.js';
import passwordResetRoutes from './password-reset.routes.js';
import roleRoutes from './role.routes.js';
import columnRoutes from './column.routes.js';
import kanbanRoutes from './kanban.routes.js';
import projectRoutes from './project.routes.js';

const router = Router();

router.use('/auth', authRoutes);
router.use('/auth', passwordResetRoutes);
router.use('/users', userRoutes);
router.use('/tasks', taskRoutes);
router.use('/roles', roleRoutes);
router.use('/columns', columnRoutes);
router.use('/kanban', kanbanRoutes);
router.use('/projects', projectRoutes);
router.use('/bugs', bugRoutes);
router.use('/sprints', sprintRoutes);

export default router;
