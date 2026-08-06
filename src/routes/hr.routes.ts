import { Router } from 'express';
import { authenticate, checkPermission, checkAnyPermission } from '../middleware/auth.middleware.js';

/* =========================
   Controllers
========================= */

import {
  getEmployees,
  createEmployee,
  updateEmployee,
  deleteEmployee,
  getEmployeeById,
  getAvailableUsers,
} from '../controllers/hr/employee.controller.js';
import { createUser } from '../controllers/user.controller.js';

// Attendance (NEW Option B)
import {
  getAttendance,
  saveAttendance,
  getAttendanceSummary,
  deleteAttendance,
  getApprovedLeavesForDate,
} from '../controllers/hr/attendance.controller.js';

// Attendance Analytics (Phase 1)
import {
  getAnalyticsSummary,
  getAnalyticsStatusDistribution,
  getAnalyticsTrend,
  getAnalyticsDepartmentRanking,
  getAnalyticsRankings,
  getAnalyticsEmployeeReport,
  getAnalyticsEmployeeDetail,
  exportAnalytics,
} from '../controllers/hr/attendanceAnalytics.controller.js';

// Leave
import {
  getLeaves,
  createLeave,
  approveLeave,
  rejectLeave,
  deleteLeave,
  getLeaveStats,
} from '../controllers/hr/leave.controller.js';

// Recruitment
import {
  getCandidates,
  createCandidate,
  getCandidateById,
  updateCandidate,
  updateCandidateStage,
  deleteCandidate,
  getRecruitmentStats,
  uploadResume,
  resumeUploadMiddleware,
} from '../controllers/hr/recruitment.controller.js';

// Payroll
import {
  getPayroll,
  getPayrollAttendancePreview,
  createPayroll,
  updatePayroll,
  updatePayrollStatus,
  deletePayroll,
} from '../controllers/hr/payroll.controller.js';
import {
  getPayrollSettingsHandler,
  updatePayrollSettingsHandler,
} from '../controllers/hr/payrollSettings.controller.js';
import {
  getAttendanceSettingsHandler,
  updateAttendanceSettingsHandler,
} from '../controllers/hr/attendanceSettings.controller.js';

// Documents
import {
  getDocuments,
  getDocumentById,
  createDocument,
  updateDocumentStatus,
  deleteDocument,
  uploadDocument,
  documentUploadMiddleware,
} from '../controllers/hr/documents.controller.js';

import {
  getHRDashboardStats,
  getHRActivityFeed,
  getHRAlerts,
} from '../controllers/hr/dashboard.controller.js';

// Performance & Appraisals
import {
  getCycles,
  createCycle,
  getAppraisals,
  createAppraisal,
  getAppraisalById,
  updateAppraisal,
  updateAppraisalStatus,
  deleteAppraisal,
  submitSelfReview,
  submitManagerReview,
  approveAppraisal,
  rejectAppraisal,
  getPerformanceStats,
  getGoals,
  createGoal,
  updateGoal,
  deleteGoal,
} from '../controllers/hr/performance.controller.js';

const router = Router();

// All HR routes require login
router.use(authenticate);

/* =========================
   Test Email (Diagnostics)
========================= */
router.post('/test-email', checkPermission('hr.settings.view'), async (req, res) => {
  const testTo = (req.body?.to as string) || 'project.inshahi@gmail.com';
  console.log('[TEST-EMAIL] Route hit — sending test email to:', testTo);
  console.log('[TEST-EMAIL] SENDGRID_API_KEY present:', !!process.env.SENDGRID_API_KEY);
  console.log('[TEST-EMAIL] EMAIL_FROM:', process.env.EMAIL_FROM);
  console.log('[TEST-EMAIL] FRONTEND_URL:', process.env.FRONTEND_URL);

  try {
    const { sendWelcomeEmail } = await import('../services/email.service.js');
    const sent = await sendWelcomeEmail(testTo, 'Test User', 'TempPass@123');
    return res.json({
      success: sent,
      message: sent ? 'Test email sent successfully' : 'SendGrid rejected the email — check server logs for details',
      sentTo: testTo,
    });
  } catch (err: any) {
    const body = err?.response?.body;
    console.error('[TEST-EMAIL] Exception:', JSON.stringify(body, null, 2) || err?.message);
    return res.status(500).json({
      success: false,
      message: 'Exception thrown sending test email',
      error: body?.errors?.[0]?.message || err?.message || 'Unknown error',
      sendgrid_body: body || null,
    });
  }
});

/* =========================
   Dashboard
========================= */
router.get(
  '/dashboard/stats',
  checkPermission('hr.dashboard.view'),
  getHRDashboardStats
);
router.get(
  '/dashboard/activity',
  checkPermission('hr.dashboard.view'),
  getHRActivityFeed
);
router.get(
  '/dashboard/alerts',
  checkPermission('hr.dashboard.view'),
  getHRAlerts
);

/* =========================
   Employees
========================= */
router.get(
  '/available-users',
  checkPermission('hr.employees.view'),
  getAvailableUsers
);

router.post(
  '/users',
  checkPermission('hr.employees.create'),
  createUser
);

router.get(
  '/employees',
  checkPermission('hr.employees.view'),
  getEmployees
);

router.get(
  '/employees/:id',
  checkPermission('hr.employees.view'),
  getEmployeeById
);

router.post(
  '/employees',
  checkPermission('hr.employees.create'),
  createEmployee
);

router.put(
  '/employees/:id',
  checkPermission('hr.employees.edit'),
  updateEmployee
);

router.delete(
  '/employees/:id',
  checkPermission('hr.employees.delete'),
  deleteEmployee
);

/* =========================
   Attendance
========================= */
router.get(
  '/attendance',
  checkPermission('hr.attendance.view'),
  getAttendance
);

// Upsert endpoint: serves BOTH the "Record Attendance" (create) and "Edit entry"
// UI actions (there is no separate PUT — save is an upsert). Justified dual-key so
// the frontend Edit button (hr.attendance.edit) and Add button (hr.attendance.create)
// both map to an API that enforces one of them.
router.post(
  '/attendance',
  checkAnyPermission(['hr.attendance.create', 'hr.attendance.edit']),
  saveAttendance
);

router.delete(
  '/attendance/:id',
  checkPermission('hr.attendance.delete'),
  deleteAttendance
);

router.get(
  '/attendance/summary',
  checkPermission('hr.attendance.view'),
  getAttendanceSummary
);

// Derived-attendance overlay: approved leaves covering a selected date.
router.get(
  '/attendance/leaves',
  checkPermission('hr.attendance.view'),
  getApprovedLeavesForDate
);

// Attendance Settings
router.get(
  '/attendance/settings',
  checkPermission('hr.settings.view'),
  getAttendanceSettingsHandler
);
router.put(
  '/attendance/settings',
  checkPermission('hr.settings.edit'),
  updateAttendanceSettingsHandler
);

/* =========================
   Attendance Analytics (Phase 1)
   Read-only; gated by hr.analytics.view (an hr.view holder passes via the hrGrants
   coarse→granular bridge, so behaviour is unchanged from the old OR check).

   ACCESS MODEL (audit decision F1 / Option A): Attendance Analytics is surfaced as
   a TAB inside the Attendance page (Attendance ├─ Daily └─ Analytics), not a
   standalone page. `hr.analytics.view` is an ADDITIONAL analytics capability for HR
   users on top of Attendance access — it broadens this API surface, but the UI is
   reached through the Attendance module. Not intended as a standalone entry point.
========================= */
router.get(
  '/analytics/summary',
  checkPermission('hr.analytics.view'),
  getAnalyticsSummary
);

router.get(
  '/analytics/status-distribution',
  checkPermission('hr.analytics.view'),
  getAnalyticsStatusDistribution
);

// Milestone 3.1
router.get(
  '/analytics/trend',
  checkPermission('hr.analytics.view'),
  getAnalyticsTrend
);

router.get(
  '/analytics/by-department',
  checkPermission('hr.analytics.view'),
  getAnalyticsDepartmentRanking
);

router.get(
  '/analytics/rankings',
  checkPermission('hr.analytics.view'),
  getAnalyticsRankings
);

// Milestone 3.2
router.get(
  '/analytics/employee-report',
  checkPermission('hr.analytics.view'),
  getAnalyticsEmployeeReport
);

// Milestone 3.3 — Employee drill-down. Note: the literal '/analytics/employee-report'
// above is a distinct single segment, so it never collides with '/employee/:id'.
router.get(
  '/analytics/employee/:id',
  checkPermission('hr.analytics.view'),
  getAnalyticsEmployeeDetail
);

// Milestone 4.1 — Excel / CSV export (read-only). Same analytics gate.
router.get(
  '/analytics/export',
  checkPermission('hr.analytics.view'),
  exportAnalytics
);

/* =========================
   Leaves (Enabled)
========================= */
// View HR Admin Leave (all records) OR View Staff Leave (own records only —
// controller scopes the query). The two leave views are independent permissions.
router.get(
  '/leaves',
  checkAnyPermission(['hr.leave.view', 'hr.leave.self']),
  getLeaves
);

router.get(
  '/leaves/stats',
  checkAnyPermission(['hr.leave.view', 'hr.leave.self']),
  getLeaveStats
);

router.post(
  '/leaves',
  checkAnyPermission(['hr.leave.view', 'hr.leave.self']),
  createLeave
);

// Approve/Reject are an HR-Admin-only action → the explicit `hr.leave.approve`
// key (viewing leave no longer implies approving it — that was the old coarse
// inconsistency this refactor removes). The HR Admin seed already holds it.
router.put(
  '/leaves/:id/approve',
  checkPermission('hr.leave.approve'),
  approveLeave
);

router.put(
  '/leaves/:id/reject',
  checkPermission('hr.leave.approve'),
  rejectLeave
);

// Delete a leave request — the JUSTIFIED dual-actor exception: HR Admins
// (hr.leave.approve) delete any; self-service staff (hr.leave.self) delete only
// their own (scoped in the controller).
router.delete(
  '/leaves/:id',
  checkAnyPermission(['hr.leave.approve', 'hr.leave.self']),
  deleteLeave
);

/* =========================
   Recruitment
========================= */
router.get(
  '/recruitment',
  checkPermission('hr.recruitment.view'),
  getCandidates
);

router.get(
  '/recruitment/stats',
  checkPermission('hr.recruitment.view'),
  getRecruitmentStats
);

router.get(
  '/recruitment/:id',
  checkPermission('hr.recruitment.view'),
  getCandidateById
);

router.post(
  '/recruitment',
  checkPermission('hr.recruitment.create'),
  createCandidate
);

router.post(
  '/recruitment/upload',
  checkPermission('hr.recruitment.create'),
  resumeUploadMiddleware.single('file'),
  uploadResume
);

router.put(
  '/recruitment/:id',
  checkPermission('hr.recruitment.edit'),
  updateCandidate
);

router.patch(
  '/recruitment/:id/stage',
  checkPermission('hr.recruitment.edit'),
  updateCandidateStage
);

router.delete(
  '/recruitment/:id',
  checkPermission('hr.recruitment.delete'),
  deleteCandidate
);

/* =========================
   Payroll
========================= */
router.get(
  '/payroll',
  checkPermission('hr.payroll.view'),
  getPayroll
);

// Read-only day snapshot + suggested 75/25 split for the generate form.
// Static path — declared before any '/payroll/:id' route so it is not shadowed.
router.get(
  '/payroll/attendance-preview',
  checkPermission('hr.payroll.view'),
  getPayrollAttendancePreview
);

// Payroll Settings (configurable rules: PF%, ESI%, + reserved). Static paths,
// declared before '/payroll/:id'. Read: settings viewer OR payroll viewer.
// Write: settings editor only. Changes apply to NEW payrolls only.
router.get(
  '/payroll/settings',
  checkAnyPermission(['hr.settings.view', 'hr.payroll.view']),
  getPayrollSettingsHandler
);
router.put(
  '/payroll/settings',
  checkPermission('hr.settings.edit'),
  updatePayrollSettingsHandler
);

router.post(
  '/payroll',
  checkPermission('hr.payroll.process'),
  createPayroll
);

router.put(
  '/payroll/:id',
  checkPermission('hr.payroll.process'),
  updatePayroll
);

router.patch(
  '/payroll/:id/status',
  checkPermission('hr.payroll.process'),
  updatePayrollStatus
);

router.delete(
  '/payroll/:id',
  checkPermission('hr.payroll.process'),
  deletePayroll
);

/* =========================
   Documents
========================= */
router.get(
  '/documents',
  checkPermission('hr.documents.view'),
  getDocuments
);

router.get(
  '/documents/:id',
  checkPermission('hr.documents.view'),
  getDocumentById
);

router.post(
  '/documents',
  checkPermission('hr.documents.create'),
  createDocument
);

router.post(
  '/documents/upload',
  checkPermission('hr.documents.create'),
  documentUploadMiddleware.single('file'),
  uploadDocument
);

router.patch(
  '/documents/:id/status',
  checkPermission('hr.documents.edit'),
  updateDocumentStatus
);

router.delete(
  '/documents/:id',
  checkPermission('hr.documents.delete'),
  deleteDocument
);

/* =========================
   Performance & Appraisals
========================= */

// Cycles
router.get(
  '/performance/cycles',
  checkPermission('hr.performance.view'),
  getCycles
);

router.post(
  '/performance/cycles',
  checkPermission('hr.performance.create'),
  createCycle
);

// Performance Stats
router.get(
  '/performance/stats',
  checkPermission('hr.performance.view'),
  getPerformanceStats
);

// Goals (placed before /performance/:id to avoid parameter shadowing)
router.get(
  '/performance/goals',
  checkPermission('hr.performance.view'),
  getGoals
);

// Goal mutations are write operations (accept an arbitrary employee_id and can
// recalculate appraisal ratings) — require the write permission, consistent with
// cycles/appraisals. Reading goals stays on hr.performance.view above.
router.post(
  '/performance/goals',
  checkPermission('hr.performance.create'),
  createGoal
);

router.put(
  '/performance/goals/:id',
  checkPermission('hr.performance.create'),
  updateGoal
);

router.delete(
  '/performance/goals/:id',
  checkPermission('hr.performance.create'),
  deleteGoal
);

// Appraisals
router.get(
  '/performance',
  checkPermission('hr.performance.view'),
  getAppraisals
);

router.post(
  '/performance',
  checkPermission('hr.performance.create'),
  createAppraisal
);

router.get(
  '/performance/:id',
  checkPermission('hr.performance.view'),
  getAppraisalById
);

router.put(
  '/performance/:id',
  checkPermission('hr.performance.create'),
  updateAppraisal
);

router.patch(
  '/performance/:id/status',
  checkPermission('hr.performance.approve'),
  updateAppraisalStatus
);

router.delete(
  '/performance/:id',
  checkPermission('hr.performance.create'),
  deleteAppraisal
);

router.patch(
  '/performance/:id/self-review',
  checkPermission('hr.performance.view'),
  submitSelfReview
);

router.patch(
  '/performance/:id/manager-review',
  checkPermission('hr.performance.review'),
  submitManagerReview
);

router.patch(
  '/performance/:id/approve',
  checkPermission('hr.performance.approve'),
  approveAppraisal
);

router.patch(
  '/performance/:id/reject',
  checkPermission('hr.performance.review'),
  rejectAppraisal
);

export default router;