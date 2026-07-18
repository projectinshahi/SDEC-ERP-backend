import { Router } from 'express';
import {
  getNoticeDashboard, listNotices, createNotice, updateNotice, deleteNotice, markNoticeRead,
  acknowledgeNotice, getNoticeAcknowledgements, getAudienceDepartments,
  publishNotice, archiveNotice,
} from '../controllers/notice.controller.js';
import {
  getNoticeCategories, createNoticeCategory, updateNoticeCategory,
  reorderNoticeCategories, deleteNoticeCategory,
} from '../controllers/noticeCategory.controller.js';
import {
  uploadMiddleware, uploadNoticeAttachment, addNoticeLink, deleteNoticeAttachment,
} from '../controllers/noticeAttachments.controller.js';
import { checkPermission, checkAnyPermission } from '../middleware/auth.middleware.js';

/**
 * Notice module routes — mounted at /api/notices.
 * Reads are gated by `notice.view` (module visibility); publishing by
 * `notice.create`; edit/delete by `notice.manage`; category admin by
 * `notice.categories.manage`. checkPermission runs authenticate internally.
 *
 * Route ORDER matters (Express): the static '/dashboard' and '/categories*'
 * paths MUST precede '/:id', and '/categories/reorder' MUST precede
 * '/categories/:id', or they would be captured as an :id param.
 */
const router = Router();

// Dashboard + list (any notice viewer).
router.get('/dashboard', checkPermission('notice.view'), getNoticeDashboard);

// Audience department list (the HR-derived master) — for the create/edit selector.
// Static path MUST precede '/:id'.
router.get('/audience/departments', checkPermission('notice.view'), getAudienceDepartments);

// Categories — list open to viewers; mutations admin-only. Reorder before :id.
router.get('/categories', checkPermission('notice.view'), getNoticeCategories);
router.post('/categories', checkPermission('notice.categories.manage'), createNoticeCategory);
router.put('/categories/reorder', checkPermission('notice.categories.manage'), reorderNoticeCategories);
router.put('/categories/:id', checkPermission('notice.categories.manage'), updateNoticeCategory);
router.delete('/categories/:id', checkPermission('notice.categories.manage'), deleteNoticeCategory);

router.get('/', checkPermission('notice.view'), listNotices);
router.post('/', checkPermission('notice.create'), createNotice);

// Per-notice — mark-read + acknowledge are self-scoped (any viewer).
router.post('/:id/read', checkPermission('notice.view'), markNoticeRead);
router.post('/:id/acknowledge', checkPermission('notice.view'), acknowledgeNotice);
// Acknowledgement tracking is a management view.
router.get('/:id/acknowledgements', checkPermission('notice.manage'), getNoticeAcknowledgements);

// Attachments — a publisher (notice.create) OR a manager (editing) can attach
// files/links; removal needs manage.
router.post('/:id/attachments', checkAnyPermission(['notice.create', 'notice.manage']), uploadMiddleware.array('files'), uploadNoticeAttachment);
router.post('/:id/links', checkAnyPermission(['notice.create', 'notice.manage']), addNoticeLink);
router.delete('/:id/attachments/:attachmentId', checkPermission('notice.manage'), deleteNoticeAttachment);

// Lifecycle transitions (owner-or-admin enforced in-controller).
router.post('/:id/publish', checkPermission('notice.manage'), publishNotice);
router.post('/:id/archive', checkPermission('notice.manage'), archiveNotice);

router.put('/:id', checkPermission('notice.manage'), updateNotice);
router.delete('/:id', checkPermission('notice.manage'), deleteNotice);

export default router;
