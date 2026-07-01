import { Router } from 'express';
import { authenticate, checkPermission, checkAnyPermission } from '../middleware/auth.middleware.js';

/* =========================
   Controllers
========================= */

// Employee
import {
  getEmployees,
  createEmployee,
  updateEmployee,
  deleteEmployee,
  getEmployeeById,
} from '../controllers/hr/employee.controller.js';

// Attendance (NEW Option B)
import {
  getAttendance,
  saveAttendance,
  getAttendanceSummary,
  deleteAttendance,
} from '../controllers/hr/attendance.controller.js';

// Leave
import {
  getLeaves,
  createLeave,
  approveLeave,
  rejectLeave,
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
  createPayroll,
  updatePayroll,
  updatePayrollStatus,
  deletePayroll,
} from '../controllers/hr/payroll.controller.js';

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
router.post('/test-email', checkPermission('hr.view'), async (req, res) => {
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
  checkPermission('hr.view'),
  getHRDashboardStats
);
router.get(
  '/dashboard/activity',
  checkPermission('hr.view'),
  getHRActivityFeed
);
router.get(
  '/dashboard/alerts',
  checkPermission('hr.view'),
  getHRAlerts
);

/* =========================
   Employees
========================= */
router.get(
  '/employees',
  checkPermission('hr.view'),
  getEmployees
);

router.get(
  '/employees/:id',
  checkPermission('hr.view'),
  getEmployeeById
);

router.post(
  '/employees',
  checkPermission('hr.create'),
  createEmployee
);

router.put(
  '/employees/:id',
  checkPermission('hr.edit'),
  updateEmployee
);

router.delete(
  '/employees/:id',
  checkPermission('hr.delete'),
  deleteEmployee
);

/* =========================
   Attendance
========================= */
router.get(
  '/attendance',
  checkPermission('hr.view'),
  getAttendance
);

router.post(
  '/attendance',
  checkPermission('hr.attendance'),
  saveAttendance
);

router.delete(
  '/attendance/:id',
  checkPermission('hr.delete'),
  deleteAttendance
);

router.get(
  '/attendance/summary',
  checkPermission('hr.view'),
  getAttendanceSummary
);

/* =========================
   Leaves (Enabled)
========================= */
router.get(
  '/leaves',
  checkAnyPermission(['hr.view', 'hr.leave.self']),
  getLeaves
);

router.get(
  '/leaves/stats',
  checkAnyPermission(['hr.view', 'hr.leave.self']),
  getLeaveStats
);

router.post(
  '/leaves',
  checkAnyPermission(['hr.create', 'hr.leave.self']),
  createLeave
);

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

/* =========================
   Recruitment
========================= */
router.get(
  '/recruitment',
  checkPermission('hr.view'),
  getCandidates
);

router.get(
  '/recruitment/stats',
  checkPermission('hr.view'),
  getRecruitmentStats
);

router.get(
  '/recruitment/:id',
  checkPermission('hr.view'),
  getCandidateById
);

router.post(
  '/recruitment',
  checkPermission('hr.create'),
  createCandidate
);

router.post(
  '/recruitment/upload',
  checkPermission('hr.create'),
  resumeUploadMiddleware.single('file'),
  uploadResume
);

router.put(
  '/recruitment/:id',
  checkPermission('hr.edit'),
  updateCandidate
);

router.patch(
  '/recruitment/:id/stage',
  checkPermission('hr.edit'),
  updateCandidateStage
);

router.delete(
  '/recruitment/:id',
  checkPermission('hr.delete'),
  deleteCandidate
);

/* =========================
   Payroll
========================= */
router.get(
  '/payroll',
  checkPermission('hr.view'),
  getPayroll
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
  checkPermission('hr.delete'),
  deletePayroll
);

/* =========================
   Documents
========================= */
router.get(
  '/documents',
  checkPermission('hr.view'),
  getDocuments
);

router.get(
  '/documents/:id',
  checkPermission('hr.view'),
  getDocumentById
);

router.post(
  '/documents',
  checkPermission('hr.create'),
  createDocument
);

router.post(
  '/documents/upload',
  checkPermission('hr.create'),
  documentUploadMiddleware.single('file'),
  uploadDocument
);

router.patch(
  '/documents/:id/status',
  checkPermission('hr.edit'),
  updateDocumentStatus
);

router.delete(
  '/documents/:id',
  checkPermission('hr.delete'),
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

router.post(
  '/performance/goals',
  checkPermission('hr.performance.view'),
  createGoal
);

router.put(
  '/performance/goals/:id',
  checkPermission('hr.performance.view'),
  updateGoal
);

router.delete(
  '/performance/goals/:id',
  checkPermission('hr.performance.view'),
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