import { Router } from 'express';
import {
  getMyTaskWorkspace, getMyTask, createMyTask, updateMyTask, updateMyTaskStatus,
  deleteMyTask, addMyTaskMembers, removeMyTaskMember, getMyTaskMessages,
  addMyTaskMessage, deleteMyTaskMessage, markMyTaskRead,
} from '../controllers/myTasks.controller.js';
import { uploadMiddleware, uploadMyTaskAttachment, deleteMyTaskAttachment } from '../controllers/myTaskAttachments.controller.js';
import { getMyTaskDashboard, getMyTaskDashboardReport } from '../controllers/myTaskDashboard.controller.js';
import { authenticate, checkPermission } from '../middleware/auth.middleware.js';

/**
 * My Tasks module routes — mounted at /api/my-tasks. Every route is gated by its
 * own dedicated `mytasks.*` permission (independent of the Development / Sales
 * task permissions). Per-task membership (creator / member / admin) is enforced
 * inside the controllers via canAccessMyTask. Global admins bypass both.
 */
const router = Router();

// Workspace + detail (Today / Inbox / Outbox live in the workspace payload).
// NOTE: '/workspace' MUST precede '/:id' so it is not captured as an id param.
//
// My Tasks is a GLOBAL feature: the personal workspace is open to EVERY
// authenticated user (it is self-scoped — getMyTaskWorkspace returns ONLY the
// caller's own tasks, and getMyTask is membership-checked in-controller), so no
// coarse `mytasks.view` gate is applied here. Mutations + chat below stay
// permission-gated, so users still only INTERACT with what they're authorized to.
router.get('/workspace', authenticate, getMyTaskWorkspace);

// Org-wide Task Dashboard aggregation. Unlike /workspace (self-scoped), this reads
// EVERY user's tasks, so it is gated by its own `mytasks.dashboard.view` permission
// (Founder/CEO/HR/Managers; SuperAdmin bypasses via checkPermission).
// NOTE: MUST precede '/:id' so it is not captured as an id param.
router.get('/dashboard', checkPermission('mytasks.dashboard.view'), getMyTaskDashboard);

// PDF report payload = the dashboard aggregation + the detailed (filtered) task list.
// Same controller, but its own permission so the raw task list stays behind the
// "Download Report" right. MUST precede '/:id'.
router.get('/dashboard/report', checkPermission('mytasks.dashboard.export'), getMyTaskDashboardReport);

router.get('/:id', authenticate, getMyTask);

// Task CRUD.
router.post('/', checkPermission('mytasks.create'), createMyTask);
router.put('/:id', checkPermission('mytasks.edit'), updateMyTask);
router.patch('/:id/status', checkPermission('mytasks.edit'), updateMyTaskStatus);
router.delete('/:id', checkPermission('mytasks.delete'), deleteMyTask);

// Members.
router.post('/:id/members', checkPermission('mytasks.assign'), addMyTaskMembers);
router.delete('/:id/members/:userId', checkPermission('mytasks.assign'), removeMyTaskMember);

// Attachments (own table + Cloudinary; membership enforced in the controller).
// UPLOAD authorization == TASK ACCESS (creator / In-Charge / assigned member / admin) —
// the SAME rule as the chat, so any active participant can share work files. Only
// `authenticate` here; the controller's canAccessMyTask.allowed does the participation
// check (non-participants get 403). This mirrors the chat routes below — no separate
// upload permission, so REST and websocket task access can never diverge.
router.post('/:id/attachments', authenticate, uploadMiddleware.array('files'), uploadMyTaskAttachment);
// DELETE stays edit-gated: removing an attachment is an owner/editor action, not a
// basic participant one (this task only extends the UPLOAD permission).
router.delete('/:id/attachments/:attachmentId', checkPermission('mytasks.edit'), deleteMyTaskAttachment);

// Chat — authorization is IDENTICAL to task access (creator / member / admin),
// enforced by canAccessMyTask inside each controller. There is deliberately NO
// separate/stricter chat permission: if a task is accessible to the user (it
// shows in their Today/Inbox/Outbox), its chat is too. This mirrors the socket
// join_mytask_room guard, so REST and websocket access can never diverge.
router.get('/:id/messages', authenticate, getMyTaskMessages);
router.post('/:id/messages', authenticate, addMyTaskMessage);
router.delete('/:id/messages/:messageId', authenticate, deleteMyTaskMessage);
router.post('/:id/read', authenticate, markMyTaskRead);

export default router;
