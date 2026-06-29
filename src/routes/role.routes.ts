import { Router } from 'express';
import { createRole, getRoles, getRolesPicklist, updateRole, deleteRole } from '../controllers/role.controller.js';
import { authenticate, checkPermission } from '../middleware/auth.middleware.js';

const router = Router();

// All role routes require a valid session.
//  • /picklist — slim id+name list for the user create/edit role dropdown
//    (any authenticated user; no permission matrix exposed).
//  • / (full list incl. permissions JSON) — gated on role.read so a direct API
//    hit is 403'd for users without Role-Management read access.
//  • mutations — gated on the matching Role-Management permission.
// SuperAdmin/Admin bypass via checkPermission's isGlobalAdmin short-circuit.
router.get('/picklist', authenticate, getRolesPicklist);
router.get('/', authenticate, checkPermission('role.read'), getRoles);
router.post('/', authenticate, checkPermission('role.create'), createRole);
router.put('/:id', authenticate, checkPermission('role.update'), updateRole);
router.delete('/:id', authenticate, checkPermission('role.delete'), deleteRole);

export default router;
