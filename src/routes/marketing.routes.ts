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

export default router;
