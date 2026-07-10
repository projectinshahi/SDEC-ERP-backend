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
import ticketRoutes from './ticket.routes.js';
import salesTicketRoutes from './salesTicket.routes.js';
import salesMeetingRoutes from './salesMeeting.routes.js';
import taskDiscussionRoutes from './task_discussions.routes.js';
import notificationRoutes from './notification.routes.js';

import activityRoutes from './activity.routes.js';
import profileRoutes from './profile.routes.js';
import salesRoutes from './sales.routes.js';
import salesExecutionRoutes from './salesExecution.routes.js';
import websiteCaptureRoutes from './websiteCapture.routes.js';
import masterDashboardRoutes from './masterDashboard.routes.js';
import hrRoutes from './hr.routes.js';
import financeRoutes from './finance.routes.js';
import myTasksRoutes from './myTasks.routes.js';
const router = Router();

// Public endpoint — no auth. Must be registered before authenticated routes.
router.use('/leads', websiteCaptureRoutes);

router.use('/profile', profileRoutes);

router.use('/auth', authRoutes);
router.use('/auth', passwordResetRoutes);
router.use('/users', userRoutes);
router.use('/tasks/:id/discussions', taskDiscussionRoutes);
router.use('/tasks', taskRoutes);
router.use('/my-tasks', myTasksRoutes);
router.use('/roles', roleRoutes);
router.use('/columns', columnRoutes);
router.use('/kanban', kanbanRoutes);
router.use('/projects', projectRoutes);
router.use('/bugs', bugRoutes);
router.use('/blockers', blockerRoutes);
router.use('/notifications', notificationRoutes);
router.use('/meetings', meetingRoutes);
// Development Tickets (project-scoped). Shares the tickets table/controller with
// the Sales variant via the module discriminator.
router.use('/tickets', ticketRoutes);
router.use('/activity-feed', activityRoutes);
// Sales Tickets & Meetings — registered before the generic '/sales' mounts so
// these specific sub-paths are matched first (sales.tickets.* / sales.meetings.*).
router.use('/sales/tickets', salesTicketRoutes);
router.use('/sales/meetings', salesMeetingRoutes);
router.use('/sales', salesRoutes);
router.use('/hr', hrRoutes);
router.use('/finance', financeRoutes);
// Sales Execution Layer (saved views, stalled config, tasks, approvals, BDE
// dashboard). Mounted after the core sales router; uses fresh path prefixes so
// unmatched requests fall through to it without shadowing existing routes.
router.use('/sales', salesExecutionRoutes);

// Master Dashboard APIs
router.use('/master-dashboard', masterDashboardRoutes);

export default router;
