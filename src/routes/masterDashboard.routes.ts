import { Router } from 'express';
import { getMasterDashboardAnalytics } from '../controllers/masterDashboard.controller.js';
import {
  getMasterProjects,
  getMasterTickets,
  getMasterTicketDetail,
  getMasterSales,
  getMasterMeetings,
  getMasterAudit,
} from '../controllers/masterDashboardModules.controller.js';
import { authenticate } from '../middleware/auth.middleware.js';

const router = Router();

// Master Dashboard live analytics. All endpoints are guarded by `authenticate`;
// each controller additionally verifies SuperAdmin/Admin role and returns
// strictly organization-wide data (never scoped to the caller).
router.get('/analytics', authenticate, getMasterDashboardAnalytics);

// Per-module organization-wide endpoints powering the standalone SuperAdmin
// modules under /master-dashboard/*.
router.get('/projects', authenticate, getMasterProjects);
router.get('/tickets', authenticate, getMasterTickets);
router.get('/tickets/:id', authenticate, getMasterTicketDetail);
router.get('/sales', authenticate, getMasterSales);
router.get('/meetings', authenticate, getMasterMeetings);
router.get('/audit', authenticate, getMasterAudit);

export default router;
