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
} from '../controllers/marketingContent.controller.js';

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
