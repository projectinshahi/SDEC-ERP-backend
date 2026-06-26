import express from 'express';
import { authenticate, checkPermission } from '../middleware/auth.middleware.js';
import {
  getSavedViews,
  createSavedView,
  updateSavedView,
  deleteSavedView,
} from '../controllers/savedView.controller.js';
import {
  getSalesTasks,
  createSalesTask,
  updateSalesTask,
  setSalesTaskBlocked,
  deleteSalesTask,
  completeSalesTask,
  getTeamTasks,
} from '../controllers/salesTask.controller.js';
import {
  getRecurrenceRules,
  createRecurrenceRule,
  updateRecurrenceRule,
  deleteRecurrenceRule,
} from '../controllers/recurringTask.controller.js';
import {
  getIncentiveSlabs,
  createIncentiveSlab,
  updateIncentiveSlab,
  deleteIncentiveSlab,
} from '../controllers/incentiveSlab.controller.js';
import {
  getTeams,
  getTeamById,
  createTeam,
  updateTeam,
  archiveTeam,
  addTeamMember,
  removeTeamMember,
  getTeamsPerformance,
  getTeamPerformanceById,
} from '../controllers/salesTeam.controller.js';
import { getManagerDashboard, getExecutiveDashboard } from '../controllers/salesPerformance.controller.js';
import {
  getPipelineReport,
  getWinRateReport,
  getLostDealReport,
  getLeadSourceReport,
  getTeamTargetReport,
  getExecutiveReport,
  getForecastVsActual,
  getActivityReport,
  getDailyReport,
  getReportSchedules,
  createReportSchedule,
  updateReportSchedule,
  deleteReportSchedule,
  exportReport,
} from '../controllers/salesReports.controller.js';
import {
  approvalUpload,
  getApprovals,
  getApprovalById,
  submitApproval,
  decideApproval,
  resubmitApproval,
  sendApprovalToClient,
} from '../controllers/documentApproval.controller.js';
import {
  getPipelineDeals,
  getStageConfig,
  updateStageConfig,
} from '../controllers/pipelineFilter.controller.js';
import { getBdeDashboard, getMyTarget, setTarget, getTargetHistory } from '../controllers/bdeDashboard.controller.js';
import { listTargets, getTargetById, deleteTarget } from '../controllers/salesTarget.controller.js';

/**
 * Sales Execution Layer routes. Mounted under /sales (after the core sales
 * router) — every path here uses a fresh prefix (views / tasks / approvals /
 * pipeline / stage-config / bde / targets) so nothing shadows existing routes.
 */
const router = express.Router();
router.use(authenticate);

// ── SE-020.1 Saved Pipeline Views ────────────────────────────────────────────
router.get('/views', checkPermission('sales.view'), getSavedViews);
router.post('/views', checkPermission('sales.view'), createSavedView);
router.put('/views/:id', checkPermission('sales.view'), updateSavedView);
router.delete('/views/:id', checkPermission('sales.view'), deleteSavedView);

// ── SE-020.1 Advanced pipeline filtering (+ stalled annotation) ──────────────
router.get('/pipeline/deals', checkPermission('sales.view'), getPipelineDeals);

// ── SE-021.1 Stalled-threshold configuration ─────────────────────────────────
router.get('/stage-config', checkPermission('sales.view'), getStageConfig);
router.put('/stage-config', checkPermission('sales.config'), updateStageConfig);

// ── SE-023 / SE-024 / SE-026 / SE-028 Sales Tasks ────────────────────────────
// Literal sub-paths (team / recurring / complete) MUST precede the generic
// /tasks/:id routes so Express doesn't treat them as an :id.
router.get('/tasks/team', checkPermission('sales.view'), getTeamTasks);
router.get('/tasks/recurring', checkPermission('sales.view'), getRecurrenceRules);
router.post('/tasks/recurring', checkPermission('sales.create'), createRecurrenceRule);
router.put('/tasks/recurring/:id', checkPermission('sales.edit'), updateRecurrenceRule);
router.delete('/tasks/recurring/:id', checkPermission('sales.delete'), deleteRecurrenceRule);
router.get('/tasks', checkPermission('sales.view'), getSalesTasks);
router.post('/tasks', checkPermission('sales.create'), createSalesTask);
router.put('/tasks/:id/complete', checkPermission('sales.edit'), completeSalesTask);
router.put('/tasks/:id/block', checkPermission('sales.edit'), setSalesTaskBlocked);
router.put('/tasks/:id', checkPermission('sales.edit'), updateSalesTask);
router.delete('/tasks/:id', checkPermission('sales.delete'), deleteSalesTask);

// ── SE-022 Document Approval Workflow ────────────────────────────────────────
router.get('/approvals', checkPermission('sales.view'), getApprovals);
router.post('/approvals', checkPermission('sales.create'), approvalUpload.single('file'), submitApproval);
router.put('/approvals/:id/decision', checkPermission('sales.approve'), decideApproval);
router.post('/approvals/:id/resubmit', checkPermission('sales.edit'), approvalUpload.single('file'), resubmitApproval);
router.post('/approvals/:id/send', checkPermission('sales.edit'), sendApprovalToClient);
router.get('/approvals/:id', checkPermission('sales.view'), getApprovalById);

// ── SE-025.1 BDE Dashboard + SE-040/041/043 Targets ──────────────────────────
router.get('/bde/dashboard', checkPermission('sales.view'), getBdeDashboard);
router.get('/targets/history', checkPermission('sales.view'), getTargetHistory);
router.get('/targets/my', checkPermission('sales.view'), getMyTarget);
// Target Management — list (scoped) precedes the /:id routes; literal sub-paths
// (history / my) are registered above so they are never treated as an :id.
router.get('/targets', checkPermission('sales.view'), listTargets);
// Targets are the single source of truth — only Target-Management users may
// create/edit/assign (BDEs can no longer self-set from the dashboard).
router.put('/targets', checkPermission('sales.targets.manage'), setTarget);
router.get('/targets/:id', checkPermission('sales.view'), getTargetById);
router.delete('/targets/:id', checkPermission('sales.targets.manage'), deleteTarget);

// ── SE-042 Incentive Slabs ───────────────────────────────────────────────────
router.get('/incentive-slabs', checkPermission('sales.view'), getIncentiveSlabs);
router.post('/incentive-slabs', checkPermission('sales.incentive.manage'), createIncentiveSlab);
router.put('/incentive-slabs/:id', checkPermission('sales.incentive.manage'), updateIncentiveSlab);
router.delete('/incentive-slabs/:id', checkPermission('sales.incentive.manage'), deleteIncentiveSlab);

// ── SE-044 Teams & Membership ────────────────────────────────────────────────
router.get('/teams', checkPermission('sales.view'), getTeams);
// Live team performance — the literal /teams/performance MUST precede /teams/:id.
router.get('/teams/performance', checkPermission('sales.view'), getTeamsPerformance);
router.post('/teams', checkPermission('sales.team.manage'), createTeam);
router.post('/teams/:id/members', checkPermission('sales.team.manage'), addTeamMember);
router.delete('/teams/:id/members/:userId', checkPermission('sales.team.manage'), removeTeamMember);
router.get('/teams/:id/performance', checkPermission('sales.view'), getTeamPerformanceById);
router.get('/teams/:id', checkPermission('sales.view'), getTeamById);
router.put('/teams/:id', checkPermission('sales.team.manage'), updateTeam);
router.delete('/teams/:id', checkPermission('sales.team.manage'), archiveTeam);

// ── Manager + Executive performance dashboards ───────────────────────────────
router.get('/analytics/manager-dashboard', checkPermission('sales.view'), getManagerDashboard);
router.get('/analytics/executive-dashboard', checkPermission('sales.view'), getExecutiveDashboard);

// ── SE-030..036 Reporting & Analytics ────────────────────────────────────────
// Scope is enforced in-handler (resolveReportScope): BDE=self, Manager=team,
// Director/Admin=org. Schedule config is admin/manager-level (sales.config).
router.get('/reports/export', checkPermission('sales.view'), exportReport);
router.get('/reports/pipeline', checkPermission('sales.view'), getPipelineReport);
router.get('/reports/win-rate', checkPermission('sales.view'), getWinRateReport);
router.get('/reports/lost-deals', checkPermission('sales.view'), getLostDealReport);
router.get('/reports/lead-source', checkPermission('sales.view'), getLeadSourceReport);
router.get('/reports/team-target', checkPermission('sales.view'), getTeamTargetReport);
router.get('/reports/executive', checkPermission('sales.view'), getExecutiveReport);
router.get('/reports/forecast-vs-actual', checkPermission('sales.view'), getForecastVsActual);
router.get('/reports/activity', checkPermission('sales.view'), getActivityReport);
router.get('/reports/daily', checkPermission('sales.view'), getDailyReport);
router.get('/reports/schedules', checkPermission('sales.config'), getReportSchedules);
router.post('/reports/schedules', checkPermission('sales.config'), createReportSchedule);
router.put('/reports/schedules/:id', checkPermission('sales.config'), updateReportSchedule);
router.delete('/reports/schedules/:id', checkPermission('sales.config'), deleteReportSchedule);

export default router;
