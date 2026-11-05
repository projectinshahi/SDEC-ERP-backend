import { Router, Request } from 'express';
import { checkPermission } from '../middleware/auth.middleware.js';
import { rateLimiter } from '../middleware/rateLimiter.js';
import { getAssistantMeta, chatWithAssistant } from '../controllers/aiAssistant.controller.js';

const router = Router();

// The ONE key that unlocks the assistant. Admin/Super Admin bypass as everywhere
// (checkPermission). Module data needs the user's own module permissions on top.
const ACCESS = 'ai.assistant.access';
const byUser = (req: Request) => String((req as any).userId ?? req.ip);

// Cost/abuse controls: per-user burst and daily caps (rate limiter runs after the
// permission check, so it is keyed by the authenticated user id).
const perMinute = rateLimiter({ keyPrefix: 'ai-assistant-min', windowMs: 60_000, max: 10, keyBy: byUser, message: 'You are sending questions too quickly. Please wait a moment.' });
const perDay = rateLimiter({ keyPrefix: 'ai-assistant-day', windowMs: 24 * 60 * 60_000, max: 200, keyBy: byUser, message: 'Daily AI Assistant limit reached. Please try again tomorrow.' });

router.get('/meta', checkPermission(ACCESS), getAssistantMeta);
router.post('/chat', checkPermission(ACCESS), perMinute, perDay, chatWithAssistant);

export default router;
