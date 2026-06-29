import { Router } from 'express';
import { authenticate, checkPermission } from '../middleware/auth.middleware.js';

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
// import {
//   getLeaves,
//   createLeave,
//   approveLeave,
//   rejectLeave,
//   getLeaveStats,
// } from '../controllers/hr/leave.controller.js';

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

// Dashboard
import {
  getHRDashboardStats,
} from '../controllers/hr/dashboard.controller.js';

const router = Router();

// All HR routes require login
router.use(authenticate);

/* =========================
   Dashboard
========================= */
router.get(
  '/dashboard/stats',
  checkPermission('hr.view'),
  getHRDashboardStats
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
   Leaves (Disabled)
========================= */
// router.get(
//   '/leaves',
//   checkPermission('hr.view'),
//   getLeaves
// );
// 
// router.get(
//   '/leaves/stats',
//   checkPermission('hr.view'),
//   getLeaveStats
// );
// 
// router.post(
//   '/leaves',
//   checkPermission('hr.create'),
//   createLeave
// );
// 
// router.put(
//   '/leaves/:id/approve',
//   checkPermission('hr.leave.approve'),
//   approveLeave
// );
// 
// router.put(
//   '/leaves/:id/reject',
//   checkPermission('hr.leave.approve'),
//   rejectLeave
// );

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

export default router;