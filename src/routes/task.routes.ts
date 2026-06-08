import { Router } from 'express';
import { getActiveTaskCount } from '../controllers/task.controller.js';
import { authenticate } from '../middleware/auth.middleware.js';

const router = Router();

router.get('/active-count', authenticate, getActiveTaskCount);

export default router;
