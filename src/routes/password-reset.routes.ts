import { Router } from 'express';
import { forgotPassword, resetPassword, validateResetToken } from '../controllers/password-reset.controller.js';

const router = Router();

// Forgot password endpoint
router.post('/forgot-password', forgotPassword);

// Reset password endpoint
router.post('/reset-password', resetPassword);

// Validate reset token endpoint
router.post('/validate-reset-token', validateResetToken);

export default router;
