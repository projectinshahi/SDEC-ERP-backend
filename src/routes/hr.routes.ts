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
} from '../controllers/hr/recruitment.controller.js';

// Payroll
import {
  getPayroll,
  generatePayroll,
  processPayroll,
} from '../controllers/hr/payroll.controller.js';

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
  '/payroll/generate',
  checkPermission('hr.payroll.process'),
  generatePayroll
);

router.post(
  '/payroll/process',
  checkPermission('hr.payroll.process'),
  processPayroll
);

export default router;