import { Router } from 'express';
import { getInvite, acceptInvite } from '../controllers/myTaskInvites.controller.js';
import { authenticate } from '../middleware/auth.middleware.js';

/**
 * Task invite links — mounted at /api/invites. The token in the WhatsApp link is
 * the secret; the preview is public so the app can show "X assigned you Y" before
 * the person has an account. Accepting needs a login (company or External).
 */
const router = Router();

router.get('/:token', getInvite);
router.post('/:token/accept', authenticate, acceptInvite);

export default router;
