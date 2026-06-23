import { Router } from 'express';
import { login, changePassword, getMe } from '../controllers/auth.controller.js';
import { authenticate } from '../middleware/auth.middleware.js';

const router = Router();

// Endpoint for default login authentication
router.post('/login', login);

// Current user with LIVE role + permissions (for permission sync without relogin)
router.get('/me', authenticate, getMe);

// Endpoint for changing password (requires authentication). Available as POST
// (used by the forced first-login change-password flow) and PUT (Settings page).
// The handler only ever changes the AUTHENTICATED caller's own password.
router.post('/change-password', authenticate, changePassword);
router.put('/change-password', authenticate, changePassword);

export default router;
