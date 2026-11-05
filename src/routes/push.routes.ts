import { Router } from 'express';
import {
  registerDevice, unregisterDevice,
  getNotificationPreferences, updateNotificationPreferences,
  runDueRemindersCron,
} from '../controllers/push.controller.js';
import { authenticate } from '../middleware/auth.middleware.js';

/**
 * Push notifications — mounted at the router root (paths carry their own prefix).
 * Device + preference endpoints are self-scoped (caller's own rows only), so they
 * are open to every authenticated user, External accounts included.
 */
const router = Router();

router.post('/devices', authenticate, registerDevice);
router.delete('/devices/:token', authenticate, unregisterDevice);

router.get('/notification-preferences', authenticate, getNotificationPreferences);
router.put('/notification-preferences', authenticate, updateNotificationPreferences);

// Not user-authenticated: guarded by the X-Cron-Secret header in the handler.
router.post('/internal/due-reminders', runDueRemindersCron);

export default router;
