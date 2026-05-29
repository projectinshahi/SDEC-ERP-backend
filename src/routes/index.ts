import { Router } from 'express';

import userRoutes from './user.routes';
import taskRoutes from './task.routes';
import authRoutes from './auth.routes';
import passwordResetRoutes from './password-reset.routes';
import roleRoutes from './role.routes';
import columnRoutes from './column.routes';
import kanbanRoutes from './kanban.routes';
import projectRoutes from './project.routes';
import bugRoutes from './bug.routes';
import sprintRoutes from './sprint.routes';
import blockerRoutes from './blocker.routes';
import meetingRoutes from './meeting.routes';

import activityRoutes from './activity.routes.js';


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
router.use('/blockers', blockerRoutes);
router.use('/meetings', meetingRoutes);
router.use('/activity-feed', activityRoutes);

export default router;
