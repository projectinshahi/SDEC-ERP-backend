import express from 'express';
import multer from 'multer';
import {
  getLeads,
  getLeadById,
  createLead,
  createManualLead,
  validateManualLeadHandler,
  checkDuplicateLead,
  updateLead,
  importLeads,
  previewLeadImport,
  getLeadSourceAnalytics,
  getLeadStageAnalytics,
  getLeadStages,
  moveLeadStage,
  getLeadNotes,
  createLeadNote,
  updateLeadNote,
  deleteLeadNote,
  getAssignableUsers,
  getDeals,
  createDeal,
  getCustomers,
  createCustomer,
} from '../controllers/sales.controller.js';
import {
  getScoringCriteria,
  createScoringCriterion,
  updateScoringCriterion,
  deleteScoringCriterion,
  getLeadScoreBreakdown,
  getLeadInteractions,
  createLeadInteraction,
  assignLead,
  getMyFollowUps,
  completeFollowUp,
  createManualFollowUp,
  getLeadOverviewAnalytics,
} from '../controllers/leadQualification.controller.js';
import {
  getLeadHistory,
  disqualifyLead,
  convertLeadToDeal,
  getLeadAging,
} from '../controllers/leadLifecycle.controller.js';
import {
  getDealStages,
  moveDealStage,
  getDealById,
  updateDeal,
  logDealActivity,
  getDealAnalytics,
} from '../controllers/deal.controller.js';
import {
  getSalesDashboard,
  getManagerWorkspace,
} from '../controllers/salesDashboard.controller.js';
import { authenticate, checkPermission } from '../middleware/auth.middleware.js';

const router = express.Router();

// In-memory storage for CSV uploads (parsed immediately, not persisted to disk).
const upload = multer({ storage: multer.memoryStorage() });

// Apply auth middleware to all sales routes
router.use(authenticate);

// Leads Routes
router.get('/leads', checkPermission('sales.view'), getLeads);
router.get('/leads/analytics/source', checkPermission('sales.view'), getLeadSourceAnalytics);
router.get('/leads/analytics/stage', checkPermission('sales.view'), getLeadStageAnalytics);
router.get('/leads/analytics/overview', checkPermission('sales.view'), getLeadOverviewAnalytics);
// Premium Sales Command Center + Manager Workspace analytics.
router.get('/analytics/dashboard', checkPermission('sales.view'), getSalesDashboard);
router.get('/analytics/manager', checkPermission('sales.view'), getManagerWorkspace);
// Deal pipeline & forecast analytics.
router.get('/analytics/deals', checkPermission('sales.view'), getDealAnalytics);
// Pipeline stages (board columns) + assignable users for the owner dropdown.
router.get('/lead-stages', checkPermission('sales.view'), getLeadStages);
router.get('/assignable-users', checkPermission('sales.view'), getAssignableUsers);

// Lead Scoring Criteria (Admin only — scoring rules are business-owned).
router.get('/scoring-criteria', checkPermission('sales.scoring'), getScoringCriteria);
router.post('/scoring-criteria', checkPermission('sales.scoring'), createScoringCriterion);
router.put('/scoring-criteria/:id', checkPermission('sales.scoring'), updateScoringCriterion);
router.delete('/scoring-criteria/:id', checkPermission('sales.scoring'), deleteScoringCriterion);

// My follow-up reminders (dashboard widget) + completion.
router.get('/follow-ups/my', checkPermission('sales.view'), getMyFollowUps);
router.put('/follow-ups/:id/complete', checkPermission('sales.edit'), completeFollowUp);
router.post('/leads', checkPermission('sales.create'), createLead);
// Manual Lead Capture (phone / email enquiries). Validation + duplicate-check
// helpers gate on view; actually creating a lead requires create permission.
router.post('/leads/validate', checkPermission('sales.view'), validateManualLeadHandler);
router.post('/leads/check-duplicate', checkPermission('sales.view'), checkDuplicateLead);
router.post('/leads/manual', checkPermission('sales.create'), createManualLead);
// Bulk import: preview (validate, no write) then import with optional field mapping.
router.post('/leads/import/preview', checkPermission('sales.create'), upload.single('file'), previewLeadImport);
router.post('/leads/import', checkPermission('sales.create'), upload.single('file'), importLeads);

// Lead aging report (inactive leads). View permission.
router.get('/leads/aging', checkPermission('sales.view'), getLeadAging);

// Lead Notes (timeline). View gated on sales.view; create/edit on sales.edit.
router.get('/leads/:id/notes', checkPermission('sales.view'), getLeadNotes);
router.post('/leads/:id/notes', checkPermission('sales.edit'), createLeadNote);
router.put('/leads/:leadId/notes/:noteId', checkPermission('sales.edit'), updateLeadNote);
router.delete('/leads/:leadId/notes/:noteId', checkPermission('sales.delete'), deleteLeadNote);

// Drag-and-drop stage move. Requires edit permission.
router.put('/leads/:id/stage', checkPermission('sales.edit'), moveLeadStage);

// Score breakdown (view) for a lead.
router.get('/leads/:id/score-breakdown', checkPermission('sales.view'), getLeadScoreBreakdown);

// Interactions (Call / Email / Meeting). View gated on sales.view; logging on sales.edit.
router.get('/leads/:id/interactions', checkPermission('sales.view'), getLeadInteractions);
router.post('/leads/:id/interactions', checkPermission('sales.edit'), createLeadInteraction);

// Manual follow-up reminder for a lead.
router.post('/leads/:id/follow-ups', checkPermission('sales.edit'), createManualFollowUp);

// Unified follow-up history timeline for a lead.
router.get('/leads/:id/history', checkPermission('sales.view'), getLeadHistory);

// Disqualify a lead (requires reason + 3 call attempts). Edit permission.
router.put('/leads/:id/disqualify', checkPermission('sales.edit'), disqualifyLead);

// Convert a lead to a deal. Edit permission (Manager/Admin via role perms).
router.post('/leads/:id/convert', checkPermission('sales.edit'), convertLeadToDeal);

// Assign / reassign a lead to a BDE. Manager/Admin only.
router.put('/leads/:id/assign', checkPermission('sales.assign'), assignLead);

router.get('/leads/:id', checkPermission('sales.view'), getLeadById);
// Editing a lead (including its source) requires the dedicated edit permission.
router.put('/leads/:id', checkPermission('sales.edit'), updateLead);

// Deals Routes
router.get('/deal-stages', checkPermission('sales.view'), getDealStages);
router.get('/deals', checkPermission('sales.view'), getDeals);
router.post('/deals', checkPermission('sales.create'), createDeal);
// Per-deal sub-routes registered before the /deals/:id catch-all.
router.put('/deals/:id/stage', checkPermission('sales.edit'), moveDealStage);
router.post('/deals/:id/activity', checkPermission('sales.edit'), logDealActivity);
router.get('/deals/:id', checkPermission('sales.view'), getDealById);
router.put('/deals/:id', checkPermission('sales.edit'), updateDeal);

// Customers Routes
router.get('/customers', checkPermission('sales.view'), getCustomers);
router.post('/customers', checkPermission('sales.create'), createCustomer);

export default router;
