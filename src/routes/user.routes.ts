import { Router } from 'express';
import { getUsers, createUser, getUserCount, updateUser, deleteUser } from '../controllers/user.controller.js';
import { authenticate, checkPermission } from '../middleware/auth.middleware.js';

const router = Router();

// Every user route requires a valid session (closes anonymous access). The
// list/count are a shared utility (assignee pickers across modules) so they
// only require authentication; the mutations require User-Management permissions
// (SuperAdmin/Admin bypass via checkPermission's isGlobalAdmin short-circuit).
router.get('/count', authenticate, getUserCount);
router.get('/', authenticate, getUsers);
router.post('/', authenticate, checkPermission('user.create'), createUser);
router.put('/:id', authenticate, checkPermission('user.update'), updateUser);
router.delete('/:id', authenticate, checkPermission('user.delete'), deleteUser);

export default router;
