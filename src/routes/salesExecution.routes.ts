import express from 'express';
import { authenticate, checkPermission, checkAnyPermission } from '../middleware/auth.middleware.js';
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
  unarchiveTeam,
  deleteTeam,
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
import { getBdeDashboard, exportBdeDashboard, getMyTarget, setTarget, getTargetHistory } from '../controllers/bdeDashboard.controller.js';
import { listTargets, getTargetById, deleteTarget } from '../controllers/salesTarget.controller.js';

/**
 * Sales Execution Layer routes. Mounted under /sales (after the core sales
 * router) — every path here uses a fresh prefix (views / tasks / approvals /
 * pipeline / stage-config / bde / targets) so nothing shadows existing routes.
 */
const router = express.Router();
router.use(authenticate);

// Per-route GRANULAR permission keys (1:1 with Development). The coarse→granular
// bridge (permissionGranted) keeps roles still holding the coarse sales.view/
// create/edit/delete master keys working; granular-only roles are scoped exactly.
// Approvals/submissions are reachable by managers (sales.approve) OR submitters
// (lead/deal view/create), so they use checkAnyPermission.
const APPROVAL_VIEW = ['sales.approve', 'sales.leads.view', 'sales.deals.view'];

// ── SE-020.1 Saved Pipeline Views ────────────────────────────────────────────
router.get('/views', checkPermission('sales.pipeline.view'), getSavedViews);
router.post('/views', checkPermission('sales.pipeline.view'), createSavedView);
router.put('/views/:id', checkPermission('sales.pipeline.view'), updateSavedView);
router.delete('/views/:id', checkPermission('sales.pipeline.view'), deleteSavedView);

// ── SE-020.1 Advanced pipeline filtering (+ stalled annotation) ──────────────
router.get('/pipeline/deals', checkPermission('sales.pipeline.view'), getPipelineDeals);

// ── SE-021.1 Stalled-threshold configuration ─────────────────────────────────
router.get('/stage-config', checkPermission('sales.pipeline.view'), getStageConfig);
router.put('/stage-config', checkPermission('sales.config'), updateStageConfig);

// ── SE-023 / SE-024 / SE-026 / SE-028 Sales Tasks ────────────────────────────
// Literal sub-paths (team / recurring / complete) MUST precede the generic
// /tasks/:id routes so Express doesn't treat them as an :id.
router.get('/tasks/team', checkPermission('sales.tasks.team.view'), getTeamTasks);
router.get('/tasks/recurring', checkPermission('sales.tasks.view'), getRecurrenceRules);
router.post('/tasks/recurring', checkPermission('sales.tasks.create'), createRecurrenceRule);
router.put('/tasks/recurring/:id', checkPermission('sales.tasks.edit'), updateRecurrenceRule);
router.delete('/tasks/recurring/:id', checkPermission('sales.tasks.delete'), deleteRecurrenceRule);
router.get('/tasks', checkPermission('sales.tasks.view'), getSalesTasks);
router.post('/tasks', checkPermission('sales.tasks.create'), createSalesTask);
router.put('/tasks/:id/complete', checkPermission('sales.tasks.edit'), completeSalesTask);
router.put('/tasks/:id/block', checkPermission('sales.tasks.edit'), setSalesTaskBlocked);
router.put('/tasks/:id', checkPermission('sales.tasks.edit'), updateSalesTask);
router.delete('/tasks/:id', checkPermission('sales.tasks.delete'), deleteSalesTask);

// ── SE-022 Document Approval Workflow ────────────────────────────────────────
router.get('/approvals', checkAnyPermission(APPROVAL_VIEW), getApprovals);
router.post('/approvals', checkAnyPermission(['sales.leads.create', 'sales.deals.create']), approvalUpload.single('file'), submitApproval);
router.put('/approvals/:id/decision', checkPermission('sales.approve'), decideApproval);
router.post('/approvals/:id/resubmit', checkAnyPermission(['sales.leads.edit', 'sales.deals.edit']), approvalUpload.single('file'), resubmitApproval);
router.post('/approvals/:id/send', checkAnyPermission(['sales.approve', 'sales.leads.edit', 'sales.deals.edit']), sendApprovalToClient);
router.get('/approvals/:id', checkAnyPermission(APPROVAL_VIEW), getApprovalById);

// ── SE-025.1 BDE Dashboard + SE-040/041/043 Targets ──────────────────────────
router.get('/bde/dashboard', checkPermission('sales.dashboard.view'), getBdeDashboard);
router.get('/bde/dashboard/export', checkPermission('sales.dashboard.view'), exportBdeDashboard);
router.get('/targets/history', checkPermission('sales.targets.history.view'), getTargetHistory);
router.get('/targets/my', checkPermission('sales.targets.view'), getMyTarget);
// Target Management — list (scoped) precedes the /:id routes; literal sub-paths
// (history / my) are registered above so they are never treated as an :id.
router.get('/targets', checkPermission('sales.targets.view'), listTargets);
// Targets are the single source of truth — only Target-Management users may
// create/edit/assign (BDEs can no longer self-set from the dashboard).
router.put('/targets', checkPermission('sales.targets.manage'), setTarget);
router.get('/targets/:id', checkPermission('sales.targets.view'), getTargetById);
router.delete('/targets/:id', checkPermission('sales.targets.manage'), deleteTarget);

// ── SE-042 Incentive Slabs ───────────────────────────────────────────────────
router.get('/incentive-slabs', checkPermission('sales.incentive.manage'), getIncentiveSlabs);
router.post('/incentive-slabs', checkPermission('sales.incentive.manage'), createIncentiveSlab);
router.put('/incentive-slabs/:id', checkPermission('sales.incentive.manage'), updateIncentiveSlab);
router.delete('/incentive-slabs/:id', checkPermission('sales.incentive.manage'), deleteIncentiveSlab);

// ── SE-044 Teams & Membership ────────────────────────────────────────────────
router.get('/teams', checkPermission('sales.teams.view'), getTeams);
// Live team performance — the literal /teams/performance MUST precede /teams/:id.
router.get('/teams/performance', checkPermission('sales.teams.view'), getTeamsPerformance);
router.post('/teams', checkPermission('sales.team.manage'), createTeam);
router.post('/teams/:id/members', checkPermission('sales.team.manage'), addTeamMember);
router.delete('/teams/:id/members/:userId', checkPermission('sales.team.manage'), removeTeamMember);
router.get('/teams/:id/performance', checkPermission('sales.teams.view'), getTeamPerformanceById);
router.get('/teams/:id', checkPermission('sales.teams.view'), getTeamById);
router.put('/teams/:id', checkPermission('sales.team.manage'), updateTeam);
// Archive (soft delete — keeps members/history) + restore stay on sales.team.manage.
router.post('/teams/:id/archive', checkPermission('sales.team.manage'), archiveTeam);
router.post('/teams/:id/unarchive', checkPermission('sales.team.manage'), unarchiveTeam);
// Hard delete is its own independent permission (sales.teams.delete); full team
// managers (sales.team.manage) qualify too. Dependency-validated in the handler.
router.delete('/teams/:id', checkAnyPermission(['sales.teams.delete', 'sales.team.manage']), deleteTeam);

// ── Manager + Executive performance dashboards (reporting tier) ───────────────
router.get('/analytics/manager-dashboard', checkPermission('sales.reports.view'), getManagerDashboard);
router.get('/analytics/executive-dashboard', checkPermission('sales.reports.view'), getExecutiveDashboard);

// ── SE-030..036 Reporting & Analytics ────────────────────────────────────────
// Scope is enforced in-handler (resolveReportScope): BDE=self, Manager=team,
// Director/Admin=org. Schedule config is admin/manager-level (sales.config).
router.get('/reports/export', checkAnyPermission(['sales.reports.export', 'sales.reports.view']), exportReport);
router.get('/reports/pipeline', checkPermission('sales.reports.view'), getPipelineReport);
router.get('/reports/win-rate', checkPermission('sales.reports.view'), getWinRateReport);
router.get('/reports/lost-deals', checkPermission('sales.reports.view'), getLostDealReport);
router.get('/reports/lead-source', checkPermission('sales.reports.view'), getLeadSourceReport);
router.get('/reports/team-target', checkPermission('sales.reports.view'), getTeamTargetReport);
router.get('/reports/executive', checkPermission('sales.reports.view'), getExecutiveReport);
router.get('/reports/forecast-vs-actual', checkPermission('sales.reports.view'), getForecastVsActual);
router.get('/reports/activity', checkPermission('sales.reports.view'), getActivityReport);
router.get('/reports/daily', checkPermission('sales.reports.view'), getDailyReport);
router.get('/reports/schedules', checkPermission('sales.config'), getReportSchedules);
router.post('/reports/schedules', checkPermission('sales.config'), createReportSchedule);
router.put('/reports/schedules/:id', checkPermission('sales.config'), updateReportSchedule);
router.delete('/reports/schedules/:id', checkPermission('sales.config'), deleteReportSchedule);

export default router;
