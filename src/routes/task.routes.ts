import { Router } from 'express';
import { getActiveTaskCount } from '../controllers/task.controller.js';

const router = Router();

router.get('/active-count', getActiveTaskCount);

export default router;
