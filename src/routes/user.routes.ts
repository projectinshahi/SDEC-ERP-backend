import { Router } from 'express';
import { getUsers, getUsersPicklist, createUser, getUserCount, updateUser, deleteUser } from '../controllers/user.controller.js';
import { lookupUsersByPhone } from '../controllers/userLookup.controller.js';
import { authenticate, checkPermission } from '../middleware/auth.middleware.js';
import { rateLimiter } from '../middleware/rateLimiter.js';

const router = Router();

// Every user route requires a valid session (closes anonymous access).
//  • /picklist — slim, shared assignee/member picker (any authenticated user).
//  • /count and / (full directory) — User-Management surfaces, gated on user.read
//    so a direct API hit is 403'd for users without the directory permission.
//  • mutations — gated on the matching User-Management permission.
// SuperAdmin/Admin bypass via checkPermission's isGlobalAdmin short-circuit.
router.get('/picklist', authenticate, getUsersPicklist);
// Contact matching for the My Task mobile app (Phase 2.2). Distinct from
// /picklist: that LISTS users to pick from, this CONFIRMS which of the caller's
// own contacts are ERP users. Same visibility scope (any authenticated user may
// discover active users), so it grants nothing /picklist doesn't already.
//
// Rate limited because it is the one endpoint that can test attacker-supplied
// phone numbers. Keyed by USER, not IP — app.ts sets no `trust proxy`, so behind
// Render's proxy an IP key would put every client in one bucket. The limiter sits
// AFTER authenticate so req.userId exists. 20 requests × 100 numbers per 15 min.
router.post(
  '/lookup-by-phone',
  authenticate,
  rateLimiter({
    windowMs: 15 * 60 * 1000,
    max: 20,
    keyPrefix: 'users:lookup-by-phone',
    keyBy: (req) => String((req as any).userId ?? req.ip),
    headers: false,
    message: 'Too many lookup requests. Please try again later.',
  }),
  lookupUsersByPhone,
);
router.get('/count', authenticate, checkPermission('user.read'), getUserCount);
router.get('/', authenticate, checkPermission('user.read'), getUsers);
router.post('/', authenticate, checkPermission('user.create'), createUser);
router.put('/:id', authenticate, checkPermission('user.update'), updateUser);
router.delete('/:id', authenticate, checkPermission('user.delete'), deleteUser);

export default router;
