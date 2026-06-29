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
  deleteLead,
  importLeads,
  previewLeadImport,
  getLeadSourceAnalytics,
  getLeadStageAnalytics,
  getLeadStages,
  createLeadStage,
  updateLeadStage,
  deleteLeadStage,
  reorderLeadStages,
  moveLeadStage,
  getLeadNotes,
  createLeadNote,
  updateLeadNote,
  deleteLeadNote,
  getAssignableUsers,
  getDeals,
  createDeal,
  getCustomers,
  getCustomerById,
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
  createDealStage,
  updateDealStage,
  deleteDealStage,
  reorderDealStages,
  moveDealStage,
  getDealById,
  updateDeal,
  logDealActivity,
  getDealAnalytics,
  getDealNotes,
  createDealNote,
  updateDealNote,
  deleteDealNote,
  deleteDeal,
} from '../controllers/deal.controller.js';
import {
  getSalesDashboard,
  getManagerWorkspace,
} from '../controllers/salesDashboard.controller.js';
import { authenticate, checkPermission, checkAnyPermission } from '../middleware/auth.middleware.js';

const router = express.Router();

// In-memory storage for CSV uploads (parsed immediately, not persisted to disk).
const upload = multer({ storage: multer.memoryStorage() });

// Apply auth middleware to all sales routes
router.use(authenticate);

// Shared helper picklist — reachable by any role with a Sales VIEW permission
// (owner dropdowns on leads / deals / tasks / targets / teams).
const SALES_VIEW_KEYS = [
  'sales.leads.view', 'sales.deals.view', 'sales.contacts.view', 'sales.followups.view',
  'sales.tasks.view', 'sales.targets.view', 'sales.teams.view', 'sales.dashboard.view',
];

// Per-route GRANULAR permission keys (1:1 with the Development module). The
// coarse→granular bridge (permissionGranted) means a role still holding the
// coarse sales.view/create/edit/delete master keys keeps passing, while a role
// with ONLY granular keys is scoped exactly to them.

// Leads Routes
router.get('/leads', checkPermission('sales.leads.view'), getLeads);
router.get('/leads/analytics/source', checkPermission('sales.leads.view'), getLeadSourceAnalytics);
router.get('/leads/analytics/stage', checkPermission('sales.leads.view'), getLeadStageAnalytics);
// The dedicated Lead Analytics dashboard's sole endpoint — its own independent
// permission (NOT sales.leads.view). The /source + /stage endpoints above stay on
// sales.leads.view (they feed the Leads list summary, not the analytics page).
router.get('/leads/analytics/overview', checkPermission('sales.leads.analytics'), getLeadOverviewAnalytics);
// Premium Sales Command Center + Manager Workspace analytics.
router.get('/analytics/dashboard', checkPermission('sales.dashboard.view'), getSalesDashboard);
router.get('/analytics/manager', checkPermission('sales.dashboard.view'), getManagerWorkspace);
// Deal pipeline & forecast analytics.
router.get('/analytics/deals', checkPermission('sales.deals.view'), getDealAnalytics);
// Pipeline stages (board columns) + assignable users for the owner dropdown.
router.get('/lead-stages', checkPermission('sales.leads.view'), getLeadStages);
// Stage management (add / rename / reorder / delete). `reorder` is registered
// before the `:id` routes so it is never captured as a stage id.
// Pipeline COLUMN management is its own dedicated permission (independent of
// editing leads): manage = add/rename/reorder, delete = remove a column.
router.post('/lead-stages', checkPermission('sales.leads.pipeline.manage'), createLeadStage);
router.put('/lead-stages/reorder', checkPermission('sales.leads.pipeline.manage'), reorderLeadStages);
router.put('/lead-stages/:id', checkPermission('sales.leads.pipeline.manage'), updateLeadStage);
router.delete('/lead-stages/:id', checkPermission('sales.leads.pipeline.delete'), deleteLeadStage);
router.get('/assignable-users', checkAnyPermission(SALES_VIEW_KEYS), getAssignableUsers);

// Lead Scoring Criteria (Admin only — scoring rules are business-owned).
router.get('/scoring-criteria', checkPermission('sales.scoring'), getScoringCriteria);
router.post('/scoring-criteria', checkPermission('sales.scoring'), createScoringCriterion);
router.put('/scoring-criteria/:id', checkPermission('sales.scoring'), updateScoringCriterion);
router.delete('/scoring-criteria/:id', checkPermission('sales.scoring'), deleteScoringCriterion);

// My follow-up reminders (dashboard widget) + completion.
router.get('/follow-ups/my', checkPermission('sales.followups.view'), getMyFollowUps);
router.put('/follow-ups/:id/complete', checkPermission('sales.followups.edit'), completeFollowUp);
router.post('/leads', checkPermission('sales.leads.create'), createLead);
// Manual Lead Capture (phone / email enquiries). Validation + duplicate-check
// helpers gate on view; actually creating a lead requires create permission.
router.post('/leads/validate', checkPermission('sales.leads.view'), validateManualLeadHandler);
router.post('/leads/check-duplicate', checkPermission('sales.leads.view'), checkDuplicateLead);
router.post('/leads/manual', checkPermission('sales.leads.create'), createManualLead);
// Bulk import: preview (validate, no write) then import with optional field mapping.
router.post('/leads/import/preview', checkPermission('sales.leads.create'), upload.single('file'), previewLeadImport);
router.post('/leads/import', checkPermission('sales.leads.create'), upload.single('file'), importLeads);

// Lead aging report (inactive leads). View permission.
router.get('/leads/aging', checkPermission('sales.leads.view'), getLeadAging);

// Lead Notes (timeline).
router.get('/leads/:id/notes', checkPermission('sales.leads.view'), getLeadNotes);
router.post('/leads/:id/notes', checkPermission('sales.leads.edit'), createLeadNote);
router.put('/leads/:leadId/notes/:noteId', checkPermission('sales.leads.edit'), updateLeadNote);
router.delete('/leads/:leadId/notes/:noteId', checkPermission('sales.leads.delete'), deleteLeadNote);

// Drag-and-drop stage move. Requires edit permission.
router.put('/leads/:id/stage', checkPermission('sales.leads.edit'), moveLeadStage);

// Score breakdown (view) for a lead.
router.get('/leads/:id/score-breakdown', checkPermission('sales.leads.view'), getLeadScoreBreakdown);

// Interactions (Call / Email / Meeting).
router.get('/leads/:id/interactions', checkPermission('sales.leads.view'), getLeadInteractions);
router.post('/leads/:id/interactions', checkPermission('sales.leads.edit'), createLeadInteraction);

// Manual follow-up reminder for a lead.
router.post('/leads/:id/follow-ups', checkPermission('sales.followups.create'), createManualFollowUp);

// Unified follow-up history timeline for a lead.
router.get('/leads/:id/history', checkPermission('sales.leads.view'), getLeadHistory);

// Disqualify a lead (requires reason + 3 call attempts). Edit permission.
router.put('/leads/:id/disqualify', checkPermission('sales.leads.edit'), disqualifyLead);

// Convert a lead to a deal. Edit permission (Manager/Admin via role perms).
router.post('/leads/:id/convert', checkPermission('sales.leads.edit'), convertLeadToDeal);

// Assign / reassign a lead to a BDE. Manager/Admin only.
router.put('/leads/:id/assign', checkPermission('sales.assign'), assignLead);

router.get('/leads/:id', checkPermission('sales.leads.view'), getLeadById);
// Editing a lead (including its source) requires the dedicated edit permission.
router.put('/leads/:id', checkPermission('sales.leads.edit'), updateLead);
// Deleting a lead requires the dedicated, independent delete permission.
router.delete('/leads/:id', checkPermission('sales.leads.delete'), deleteLead);

// Deals Routes
router.get('/deal-stages', checkPermission('sales.deals.view'), getDealStages);
// Deal pipeline COLUMN management — dedicated permissions (independent of editing
// deals). `reorder` precedes `:id` so it is never captured as a stage id.
router.post('/deal-stages', checkPermission('sales.deals.pipeline.manage'), createDealStage);
router.put('/deal-stages/reorder', checkPermission('sales.deals.pipeline.manage'), reorderDealStages);
router.put('/deal-stages/:id', checkPermission('sales.deals.pipeline.manage'), updateDealStage);
router.delete('/deal-stages/:id', checkPermission('sales.deals.pipeline.delete'), deleteDealStage);
router.get('/deals', checkPermission('sales.deals.view'), getDeals);
router.post('/deals', checkPermission('sales.deals.create'), createDeal);
// Per-deal sub-routes registered before the /deals/:id catch-all.
router.put('/deals/:id/stage', checkPermission('sales.deals.edit'), moveDealStage);
router.post('/deals/:id/activity', checkPermission('sales.deals.edit'), logDealActivity);
// Deal notes (editable add/edit/delete) — MUST precede the /deals/:id catch-all.
router.get('/deals/:id/notes', checkPermission('sales.deals.view'), getDealNotes);
router.post('/deals/:id/notes', checkPermission('sales.deals.edit'), createDealNote);
router.put('/deals/:dealId/notes/:noteId', checkPermission('sales.deals.edit'), updateDealNote);
router.delete('/deals/:dealId/notes/:noteId', checkPermission('sales.deals.delete'), deleteDealNote);
router.get('/deals/:id', checkPermission('sales.deals.view'), getDealById);
router.put('/deals/:id', checkPermission('sales.deals.edit'), updateDeal);
router.delete('/deals/:id', checkPermission('sales.deals.delete'), deleteDeal);

// Customers Routes
router.get('/customers', checkPermission('sales.contacts.view'), getCustomers);
router.get('/customers/:id', checkPermission('sales.contacts.view'), getCustomerById);
router.post('/customers', checkPermission('sales.contacts.create'), createCustomer);

export default router;
