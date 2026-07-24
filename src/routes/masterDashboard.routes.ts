import { Router } from 'express';
import { getMasterDashboardAnalytics } from '../controllers/masterDashboard.controller.js';
import {
  getMasterProjects,
  getMasterTickets,
  getMasterTicketDetail,
  getMasterSales,
  getMasterMeetings,
  getMasterAudit,
  getMasterHR,
  getMasterHRAttendance,
  getMasterHRLeave,
  getMasterHRRecruitment,
  getMasterHRPayroll,
  getMasterHRPerformance,
} from '../controllers/masterDashboardModules.controller.js';
import { getRevenueParity } from '../controllers/revenueParity.controller.js';
import { requireSuperAdmin } from '../middleware/auth.middleware.js';

const router = Router();

// Hard gate: EVERY Master Dashboard endpoint is SuperAdmin/Admin-only at the
// route layer (in addition to each controller's own org-wide guard). A regular
// authenticated user can never reach organization-wide data.
router.use(requireSuperAdmin);

// Master Dashboard live analytics — strictly organization-wide data.
router.get('/analytics', getMasterDashboardAnalytics);

// Phase 3 · Stage 3B — revenue parity diagnostic (Deal vs Pipeline). Verification-only;
// removed with the Deal table in Stage 3C.
router.get('/revenue-parity', getRevenueParity);

// Per-module organization-wide endpoints powering the standalone SuperAdmin
// modules under /master-dashboard/*.
router.get('/projects', getMasterProjects);
router.get('/tickets', getMasterTickets);
router.get('/tickets/:id', getMasterTicketDetail);
router.get('/sales', getMasterSales);
router.get('/hr', getMasterHR);
// HR tab endpoints (server-side filtered + searched).
router.get('/hr/attendance', getMasterHRAttendance);
router.get('/hr/leave', getMasterHRLeave);
router.get('/hr/recruitment', getMasterHRRecruitment);
router.get('/hr/payroll', getMasterHRPayroll);
router.get('/hr/performance', getMasterHRPerformance);
router.get('/meetings', getMasterMeetings);
router.get('/audit', getMasterAudit);

export default router;
