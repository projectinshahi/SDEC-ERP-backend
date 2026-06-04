import { Router } from 'express';
import { getProfile, updateProfile, changePassword } from '../controllers/profile.controller.js';
import { authenticate } from '../middleware/auth.middleware.js';

const router = Router();

// Profile routes (all require authentication)
router.get('/', authenticate, getProfile);
router.put('/', authenticate, updateProfile);
router.post('/change-password', authenticate, changePassword);

export default router;
