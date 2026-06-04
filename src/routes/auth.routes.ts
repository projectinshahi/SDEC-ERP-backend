import { Router } from 'express';
import { login, changePassword } from '../controllers/auth.controller.js';
import { authenticate } from '../middleware/auth.middleware.js';

const router = Router();

// Endpoint for default login authentication
router.post('/login', login);

// Endpoint for changing password (requires authentication)
router.post('/change-password', authenticate, changePassword);

export default router;
