import { Router } from 'express';
import { createRole, getRoles, updateRole, deleteRole } from '../controllers/role.controller.js';
import { authenticate, checkPermission } from '../middleware/auth.middleware.js';

const router = Router();

// All role routes require a valid session. Listing is a shared utility (the
// role-assignment dropdown in User Management) so it's authenticate-only; the
// mutations require Role-Management permissions (SuperAdmin/Admin bypass via
// checkPermission's isGlobalAdmin short-circuit).
router.get('/', authenticate, getRoles);
router.post('/', authenticate, checkPermission('role.create'), createRole);
router.put('/:id', authenticate, checkPermission('role.update'), updateRole);
router.delete('/:id', authenticate, checkPermission('role.delete'), deleteRole);

export default router;
