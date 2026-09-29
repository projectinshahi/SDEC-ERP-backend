import { Router } from 'express';
import { authenticate, checkPermission, checkAnyPermission } from '../middleware/auth.middleware.js';
import {
  getContents,
  getContentById,
  createContent,
  updateContent,
  moveContentStage,
  setContentApproval,
  deleteContent,
  uploadContentAttachments,
  deleteContentAttachment,
  contentUploadMiddleware,
  getContentNotificationSettings,
  putContentNotificationSettings,
  getContentList,
  setContentReadiness,
  getReferenceData,
  postReferenceItem,
  putReferenceItem,
  getWorkOutputs, addWorkOutput, updateWorkOutput, deleteWorkOutput, getContentHistory,
  getReviewChecklist, setReviewChecklistItem, getRevisionHistory,
  setContentSchedule, markContentPublished,
  resubmitForReview, setContentMetrics, getPerformanceSchema,
  getMarketingAuditLog, exportContentCardsCsv, exportDeadlinesCsv,
  setContentArchived,
} from '../controllers/marketingContent.controller.js';
import {
  getProjectWorkspace, getProject, createProject,
  getProjectEvents, createProjectEvent, updateProjectEvent, deleteProjectEvent,
} from '../controllers/marketingProject.controller.js';
import {
  getAssets, createAsset, updateAsset, setAssetActive,
  getAssetRequests, createAssetRequest, decideAssetRequest, cancelAssetRequest,
  getAssetAvailability,
} from '../controllers/marketingAsset.controller.js';
import {
  getMyAttendance, checkIn, checkOut, getTeamAttendance, overrideAttendance,
} from '../controllers/marketingAttendance.controller.js';
import {
  checkoutAsset, returnAsset, getCheckouts, setAssetMaintenance, getAssetMaintenance,
} from '../controllers/marketingCheckout.controller.js';
import {
  getAttendanceMonth, getAttendanceSummary, exportAttendanceSummaryXlsx,
} from '../controllers/marketingAttendanceReport.controller.js';
import { getClientCosts, logClientCost } from '../controllers/marketingCost.controller.js';
import {
  getExpenses, getExpenseById, createExpense, updateExpense, decideExpense,
  deleteExpense, uploadExpenseReceipt, receiptUploadMiddleware,
  getFinanceSettingsHandler, putFinanceSettingsHandler,
} from '../controllers/marketingExpense.controller.js';
import {
  getExpenseReport, exportExpensesXlsx,
} from '../controllers/marketingExpenseExport.controller.js';
import {
  getCampaigns, createCampaign, updateCampaign, deleteCampaign,
  getInfluencers, createInfluencer, updateInfluencer, setInfluencerPayment, deleteInfluencer,
} from '../controllers/marketingCampaign.controller.js';

/**
 * Marketing module routes — Content Production Kanban.
 *
 * Route-level gates use the EXISTING RBAC middleware and the marketing.content.*
 * permission tree (Role Management). Granular-OR-coarse: fine-grained actions
 * accept their dedicated key OR marketing.content.edit — except approval, which
 * requires marketing.content.approve exactly. Field-level authorization inside
 * PUT /content/:id is enforced again in the controller (sectioned), so a caller
 * passing the route gate still cannot write sections they lack the key for.
 */
const router = Router();
router.use(authenticate);

/* ── MK-001 Marketing project workspace ────────────────────────────────────
 * Registered BEFORE the '/content' routes so '/projects/...' can never be
 * shadowed. Route gates are the coarse module keys; every handler additionally
 * resolves and authorizes the project id through resolveProject(), which is
 * what actually stops one project's URL from reading another's data. */
router.get('/projects', checkPermission('marketing.content.view'), getProjectWorkspace);
router.post('/projects', checkPermission('marketing.settings.manage'), createProject);
router.get('/projects/:projectId', checkPermission('marketing.content.view'), getProject);

router.get('/projects/:projectId/events', checkPermission('marketing.content.view'), getProjectEvents);
router.post(
  '/projects/:projectId/events',
  checkAnyPermission(['marketing.content.edit', 'marketing.content.create']),
  createProjectEvent,
);
router.put(
  '/projects/:projectId/events/:eventId',
  checkAnyPermission(['marketing.content.edit', 'marketing.content.create']),
  updateProjectEvent,
);
router.delete(
  '/projects/:projectId/events/:eventId',
  checkAnyPermission(['marketing.content.edit', 'marketing.content.create']),
  deleteProjectEvent,
);

/* ── MK-002 Asset registry + booking workflow ──────────────────────────────
 * Registry mutation is Admin-controlled (assets.manage); requesting and
 * approving are SEPARATE authorities, so an approver is never implied by the
 * ability to request. Every handler re-checks its own key, so a direct API call
 * is refused exactly like the hidden UI control.
 *
 * '/assets/availability' is registered before '/assets/:id' so the literal is
 * never parsed as an id. */
router.get('/assets/availability', checkPermission('marketing.assets.view'), getAssetAvailability);
router.get('/assets', checkPermission('marketing.assets.view'), getAssets);
router.post('/assets', checkPermission('marketing.assets.manage'), createAsset);
router.put('/assets/:id', checkPermission('marketing.assets.manage'), updateAsset);
router.patch('/assets/:id/active', checkPermission('marketing.assets.manage'), setAssetActive);

router.get('/asset-requests', checkPermission('marketing.assets.view'), getAssetRequests);
router.post('/asset-requests', checkPermission('marketing.assets.request'), createAssetRequest);
router.patch('/asset-requests/:id/decision', checkPermission('marketing.assets.approve'), decideAssetRequest);
// Cancel is route-gated on VIEW because a requester owns their own booking; the
// controller enforces the real rule (own request, or approve/Admin authority).
router.patch('/asset-requests/:id/cancel', checkPermission('marketing.assets.view'), cancelAssetRequest);

/* ── MK-002.3 Physical checkout / return ───────────────────────────────────
 * Gated on the REQUEST authority: whoever may book equipment is whoever
 * physically collects it. The ledger is READ-ONLY — there is deliberately no
 * update or delete route for a checkout row, for any role. */
router.post('/asset-requests/:id/checkout', checkPermission('marketing.assets.request'), checkoutAsset);
router.post('/asset-checkouts/:id/return', checkPermission('marketing.assets.request'), returnAsset);
router.get('/asset-checkouts', checkPermission('marketing.assets.view'), getCheckouts);

/* ── MK-002.5 Condition / maintenance ──────────────────────────────────────
 * Route-gated on VIEW because ANY team member may report a fault; the
 * controller enforces the real split (flag = view, restore = manage) and the
 * active-booking admin override. */
router.get('/assets/:id/maintenance', checkPermission('marketing.assets.view'), getAssetMaintenance);
router.patch('/assets/:id/maintenance', checkPermission('marketing.assets.view'), setAssetMaintenance);

/* ── MK-003 Marketing attendance ───────────────────────────────────────────
 * Self check-in/out is gated on the SELF key and always resolves to today + the
 * caller; neither the date nor the user id is read from the request. */
router.get('/attendance/me', checkPermission('marketing.attendance.self'), getMyAttendance);
router.post('/attendance/check-in', checkPermission('marketing.attendance.self'), checkIn);
router.post('/attendance/check-out', checkPermission('marketing.attendance.self'), checkOut);
router.get('/attendance', checkPermission('marketing.attendance.view'), getTeamAttendance);
/* ── MK-003.3/.4 Monthly calendar, summary and XLSX export ─────────────────
 * Registered BEFORE '/attendance/:userId/:date' so these literal paths are
 * never parsed as a userId. Gated on the SELF key: a member may always report
 * on their own month, and the controller widens the scope to the whole roster
 * only for a caller holding the team key. */
router.get('/attendance/month', checkPermission('marketing.attendance.self'), getAttendanceMonth);
router.get('/attendance/summary.xlsx', checkPermission('marketing.attendance.self'), exportAttendanceSummaryXlsx);
router.get('/attendance/summary', checkPermission('marketing.attendance.self'), getAttendanceSummary);

router.put('/attendance/:userId/:date', checkPermission('marketing.attendance.override'), overrideAttendance);

/* ── MK-004.1 Production cost dashboard ────────────────────────────────────
 * Financial visibility is its own key, separate from operational Marketing
 * access, so a role can be granted one without the other. */
router.get(
  '/costs',
  checkAnyPermission(['marketing.costs.view', 'marketing.financials.view']),
  getClientCosts,
);
// The costs page's quick-log. Same handler as POST /expenses, so a cost logged
// from either screen goes through the same validation and approval threshold.
router.post(
  '/costs',
  checkAnyPermission(['marketing.costs.manage', 'marketing.expenses.create']),
  logClientCost,
);

/* ── MK-004.2 / MK-004.3 Expense logger + approval workflow ────────────────────
 * Every gate below is an EXISTING key from the Marketing permission tree.
 * Approval is `marketing.expenses.approve` exactly — never implied by create or
 * edit — matching the 1:1 rule this module already applies to content.approve
 * and assets.approve. Every handler re-checks its own key so a direct API call
 * is refused exactly like the hidden UI control.
 *
 * The literal '/expenses/export...' paths are registered BEFORE '/expenses/:id'
 * so they can never be parsed as an id. */
router.get(
  '/expenses/export.xlsx',
  checkAnyPermission(['marketing.reports.export', 'marketing.reports.download']),
  exportExpensesXlsx,
);
router.get(
  '/expenses/export',
  checkAnyPermission(['marketing.reports.export', 'marketing.reports.download']),
  getExpenseReport,
);
router.get(
  '/expenses',
  checkAnyPermission(['marketing.costs.view', 'marketing.financials.view']),
  getExpenses,
);
router.post(
  '/expenses',
  checkAnyPermission(['marketing.expenses.create', 'marketing.costs.manage']),
  createExpense,
);
router.get(
  '/expenses/:id',
  checkAnyPermission(['marketing.costs.view', 'marketing.financials.view']),
  getExpenseById,
);
router.put(
  '/expenses/:id',
  checkAnyPermission(['marketing.expenses.edit', 'marketing.costs.manage']),
  updateExpense,
);
router.patch('/expenses/:id/decision', checkPermission('marketing.expenses.approve'), decideExpense);
router.post(
  '/expenses/:id/receipt',
  checkAnyPermission(['marketing.expenses.create', 'marketing.expenses.edit', 'marketing.costs.manage']),
  receiptUploadMiddleware.single('receipt'),
  uploadExpenseReceipt,
);
router.delete('/expenses/:id', checkPermission('marketing.expenses.delete'), deleteExpense);

// Thresholds. READ is open to anyone who may log an expense (the form needs the
// number to know when to confirm); WRITE is admin-only, enforced server-side.
router.get(
  '/finance-settings',
  checkAnyPermission([
    'marketing.costs.view', 'marketing.financials.view',
    'marketing.expenses.create', 'marketing.costs.manage',
  ]),
  getFinanceSettingsHandler,
);
router.put('/finance-settings', checkPermission('marketing.settings.manage'), putFinanceSettingsHandler);

/* ── MK-004.4 Performance marketing tracker ────────────────────────────────── */
router.get(
  '/ad-campaigns',
  checkAnyPermission(['marketing.campaigns.view', 'marketing.financials.view']),
  getCampaigns,
);
router.post(
  '/ad-campaigns',
  checkAnyPermission(['marketing.campaigns.create', 'marketing.campaigns.edit']),
  createCampaign,
);
router.put(
  '/ad-campaigns/:id',
  checkAnyPermission(['marketing.campaigns.edit', 'marketing.campaigns.create']),
  updateCampaign,
);
router.delete('/ad-campaigns/:id', checkPermission('marketing.campaigns.delete'), deleteCampaign);

/* ── MK-004.5 Influencer marketing tracker ─────────────────────────────────────
 * The payment transition has its own route so the legal-state rule lives in one
 * handler and an ordinary edit cannot move money state as a side effect. */
router.get(
  '/influencers',
  checkAnyPermission(['marketing.campaigns.view', 'marketing.financials.view']),
  getInfluencers,
);
router.post(
  '/influencers',
  checkAnyPermission(['marketing.campaigns.create', 'marketing.campaigns.edit']),
  createInfluencer,
);
router.put(
  '/influencers/:id',
  checkAnyPermission(['marketing.campaigns.edit', 'marketing.campaigns.create']),
  updateInfluencer,
);
router.patch(
  '/influencers/:id/payment',
  checkAnyPermission(['marketing.campaigns.edit', 'marketing.campaigns.create']),
  setInfluencerPayment,
);
router.delete('/influencers/:id', checkPermission('marketing.campaigns.delete'), deleteInfluencer);

// Admin reference data behind the Content Card classification dropdowns.
// READ needs only Content view (the form needs the options); WRITE requires the
// admin settings permission, enforced server-side.
router.get('/reference-data', checkPermission('marketing.content.view'), getReferenceData);
router.post('/reference-data/:table', checkPermission('marketing.settings.manage'), postReferenceItem);
router.put('/reference-data/:table/:id', checkPermission('marketing.settings.manage'), putReferenceItem);

// Content Card LIST (table view) - active cards only. Registered BEFORE
// '/content/:id' so the literal path is matched first.
router.get('/content/list', checkPermission('marketing.content.view'), getContentList);

// Kanban dataset + detail
router.get('/content', checkPermission('marketing.content.view'), getContents);
router.get('/content/:id', checkPermission('marketing.content.view'), getContentById);

// Create / update / delete
router.post('/content', checkPermission('marketing.content.create'), createContent);
router.put(
  '/content/:id',
  // Any of the write keys may legitimately hit this endpoint; the controller
  // enforces the exact per-section key (edit / assign / schedule / publish / analytics).
  checkAnyPermission([
    'marketing.content.edit',
    'marketing.content.assign',
    'marketing.content.schedule',
    'marketing.content.publish',
    'marketing.content.analytics',
  ]),
  updateContent,
);
router.delete('/content/:id', checkPermission('marketing.content.delete'), deleteContent);

// MK-001.5 — Archive / restore. Soft and reversible, so it rides the module's
// granular-OR-coarse pattern rather than requiring the hard-delete key.
router.patch(
  '/content/:id/archive',
  checkAnyPermission(['marketing.content.delete', 'marketing.content.edit']),
  setContentArchived,
);

// Kanban stage movement (persisted + audited)
router.patch(
  '/content/:id/stage',
  checkAnyPermission(['marketing.content.move', 'marketing.content.edit']),
  moveContentStage,
);

// Approval — its own authority, never implied by edit.
router.patch('/content/:id/approval', checkPermission('marketing.content.approve'), setContentApproval);

// M03 readiness gates. Route-gated on the workflow-authority key; the service
// re-checks the actor AND the legality of the transition, so neither the gate
// nor the workflow order can be bypassed by calling the API directly.
router.patch('/content/:id/readiness', checkPermission('marketing.content.approve'), setContentReadiness);

// Attachments (shared multer → Cloudinary infra)
router.post(
  '/content/:id/attachments',
  checkPermission('marketing.content.edit'),
  contentUploadMiddleware.array('files', 10),
  uploadContentAttachments,
);
router.delete(
  '/content/:id/attachments/:attachmentId',
  checkPermission('marketing.content.edit'),
  deleteContentAttachment,
);

// M04 #27 — Work Output links. Route-gated only on VIEW, because the assigned
// Designer / Editor roles legitimately hold nothing more; the real authorization
// (assignment on THIS card, authorship for edit/remove, Admin override) lives in
// the controller, so a direct API call is checked exactly like the UI path.
router.get('/content/:id/work-outputs', checkPermission('marketing.content.view'), getWorkOutputs);

// M06 #29 — stage history (reads the existing activity_logs audit rows).
router.get('/content/:id/history', checkPermission('marketing.content.view'), getContentHistory);

// M07 #34 - internal review checklist. Route-gated on VIEW; the controller
// enforces the real rule (card in Review, and edit rights or the assigned
// Approver), so a direct API call is checked exactly like the UI path.
router.get('/content/:id/review-checklist', checkPermission('marketing.content.view'), getReviewChecklist);
router.patch('/content/:id/review-checklist', checkPermission('marketing.content.view'), setReviewChecklistItem);

// M07 #37 - revision history. READ ONLY BY DESIGN: no create/update/delete route
// exists for this resource, for any role including Admin.
router.get('/content/:id/revisions', checkPermission('marketing.content.view'), getRevisionHistory);

// M08 #38/#39 — scheduling record and the publication event. Route-gated on the
// dedicated key OR the coarse edit key (the module's existing granular-OR-coarse
// pattern); the controller re-checks the exact rule, the CURRENT stage and the
// already-published state, so a direct API call is validated like the UI path.
router.patch(
  '/content/:id/schedule',
  checkAnyPermission(['marketing.content.schedule', 'marketing.content.edit']),
  setContentSchedule,
);
router.patch(
  '/content/:id/publish',
  checkAnyPermission(['marketing.content.publish', 'marketing.content.edit']),
  markContentPublished,
);

// M09 #40 - resubmission after Changes Requested. Route-gated on VIEW because the
// Content Owner is not guaranteed any write key; the controller enforces the real
// rule (owner of THIS card, in Editing, previously sent back for changes).
router.patch('/content/:id/resubmit', checkPermission('marketing.content.view'), resubmitForReview);

// M09 #41 - performance metrics. The controller re-checks the stage, so an
// earlier-stage card cannot be given numbers through a direct call.
router.get('/content/:id/performance', checkPermission('marketing.content.view'), getPerformanceSchema);
router.patch(
  '/content/:id/metrics',
  checkAnyPermission(['marketing.content.analytics', 'marketing.content.edit']),
  setContentMetrics,
);
router.post('/content/:id/work-outputs', checkPermission('marketing.content.view'), addWorkOutput);
router.put('/content/:id/work-outputs/:workOutputId', checkPermission('marketing.content.view'), updateWorkOutput);
router.delete('/content/:id/work-outputs/:workOutputId', checkPermission('marketing.content.view'), deleteWorkOutput);

// Admin notification event toggles. READ is open to anyone who can see Content
// (the UI reflects the current state); WRITE requires an admin-only settings
// permission, enforced server-side — a Content role user calling this API
// directly is rejected, not merely hidden in the UI.
// M10 #46 - audit log. ADMIN-ONLY at the route, and read-only by design: there
// is no create/update/delete counterpart for any role.
router.get('/audit', checkPermission('marketing.settings.manage'), getMarketingAuditLog);

// M10 #47/#48 - CSV exports. Gated on the same VIEW permission as the lists they
// mirror, and scoped by the same shared filter builder, so an export can never
// return rows the caller could not already see in the UI.
router.get('/export/content-cards', checkPermission('marketing.content.view'), exportContentCardsCsv);
router.get('/export/deadlines', checkPermission('marketing.content.view'), exportDeadlinesCsv);

router.get('/notification-settings', checkPermission('marketing.content.view'), getContentNotificationSettings);
router.put('/notification-settings', checkPermission('marketing.settings.manage'), putContentNotificationSettings);

export default router;
