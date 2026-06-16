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
} from '../controllers/salesTask.controller.js';
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
import { getBdeDashboard, getMyTarget, setTarget } from '../controllers/bdeDashboard.controller.js';

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

// ── SE-023 / SE-024 Sales Tasks ──────────────────────────────────────────────
router.get('/tasks', checkPermission('sales.view'), getSalesTasks);
router.post('/tasks', checkPermission('sales.create'), createSalesTask);
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

// ── SE-025.1 BDE Dashboard + Targets ─────────────────────────────────────────
router.get('/bde/dashboard', checkPermission('sales.view'), getBdeDashboard);
router.get('/targets/my', checkPermission('sales.view'), getMyTarget);
router.put('/targets', checkPermission('sales.edit'), setTarget);

export default router;
