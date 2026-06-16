import { Router } from 'express';

import userRoutes from './user.routes.js';
import taskRoutes from './task.routes.js';
import authRoutes from './auth.routes.js';
import passwordResetRoutes from './password-reset.routes.js';
import roleRoutes from './role.routes.js';
import columnRoutes from './column.routes.js';
import kanbanRoutes from './kanban.routes.js';
import projectRoutes from './project.routes.js';
import bugRoutes from './bug.routes.js';
import blockerRoutes from './blocker.routes.js';
import meetingRoutes from './meeting.routes.js';
import taskDiscussionRoutes from './task_discussions.routes.js';
import notificationRoutes from './notification.routes.js';

import activityRoutes from './activity.routes.js';
import profileRoutes from './profile.routes.js';
import salesRoutes from './sales.routes.js';
import websiteCaptureRoutes from './websiteCapture.routes.js';

const router = Router();

// Public endpoint — no auth. Must be registered before authenticated routes.
router.use('/leads', websiteCaptureRoutes);

router.use('/profile', profileRoutes);

router.use('/auth', authRoutes);
router.use('/auth', passwordResetRoutes);
router.use('/users', userRoutes);
router.use('/tasks/:id/discussions', taskDiscussionRoutes);
router.use('/tasks', taskRoutes);
router.use('/roles', roleRoutes);
router.use('/columns', columnRoutes);
router.use('/kanban', kanbanRoutes);
router.use('/projects', projectRoutes);
router.use('/bugs', bugRoutes);
router.use('/blockers', blockerRoutes);
router.use('/notifications', notificationRoutes);
router.use('/meetings', meetingRoutes);
router.use('/activity-feed', activityRoutes);
router.use('/sales', salesRoutes);

export default router;
