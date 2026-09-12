import { Router } from 'express';
import {
  getThreads,
  getUnreadCount,
  getConversation,
  sendMessage,
  markConversationRead,
} from '../controllers/directMessages.controller.js';
import { authenticate } from '../middleware/auth.middleware.js';
import { rateLimiter } from '../middleware/rateLimiter.js';

/**
 * Direct 1:1 messaging routes — mounted at /api/messages (Phase 2.6B).
 *
 * NO new permission key. Like the My Tasks personal workspace, every endpoint
 * here is SELF-SCOPED: the service bounds every query by the authenticated user
 * id, so a caller can only ever reach their own conversations. The one outward
 * decision — who may be messaged — reuses the existing visible-user predicate,
 * the same rule that already governs the user picklist and phone lookup.
 * Gating this behind a coarse `messages.*` permission would lock out exactly the
 * Developers/BDEs/Employees the feature is for, and would grant nothing extra.
 */
const router = Router();

/**
 * Send is the only endpoint that creates rows on someone else's screen, so it is
 * the one that needs abuse protection. Keyed by USER id, not IP: app.ts sets no
 * `trust proxy`, so behind Render every client would otherwise share one bucket,
 * and a per-user key also stops one account evading the limit by changing network.
 * Runs after authenticate so req.userId exists.
 */
const sendLimiter = rateLimiter({
  windowMs: 60_000,
  max: 30,
  keyPrefix: 'messages-send',
  keyBy: (req) => String((req as any).userId ?? req.ip),
  message: 'You are sending messages too quickly. Please slow down.',
});

// Literal paths MUST precede '/:userId' or they are captured as an id.
router.get('/threads', authenticate, getThreads);
router.get('/unread-count', authenticate, getUnreadCount);

router.get('/:userId', authenticate, getConversation);
router.post('/:userId', authenticate, sendLimiter, sendMessage);
router.post('/:userId/read', authenticate, markConversationRead);

export default router;
