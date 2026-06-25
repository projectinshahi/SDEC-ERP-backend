import { Router } from 'express';
import { getUsers, getUsersPicklist, createUser, getUserCount, updateUser, deleteUser } from '../controllers/user.controller.js';
import { authenticate, checkPermission } from '../middleware/auth.middleware.js';

const router = Router();

// Every user route requires a valid session (closes anonymous access).
//  • /picklist — slim, shared assignee/member picker (any authenticated user).
//  • /count and / (full directory) — User-Management surfaces, gated on user.read
//    so a direct API hit is 403'd for users without the directory permission.
//  • mutations — gated on the matching User-Management permission.
// SuperAdmin/Admin bypass via checkPermission's isGlobalAdmin short-circuit.
router.get('/picklist', authenticate, getUsersPicklist);
router.get('/count', authenticate, checkPermission('user.read'), getUserCount);
router.get('/', authenticate, checkPermission('user.read'), getUsers);
router.post('/', authenticate, checkPermission('user.create'), createUser);
router.put('/:id', authenticate, checkPermission('user.update'), updateUser);
router.delete('/:id', authenticate, checkPermission('user.delete'), deleteUser);

export default router;
