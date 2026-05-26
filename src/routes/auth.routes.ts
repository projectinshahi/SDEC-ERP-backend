import { Router } from 'express';
import { login } from '../controllers/auth.controller.js';

const router = Router();

// Endpoint for default login authentication
router.post('/login', login);

export default router;
