import { Router } from 'express';
import { getColumns, updateColumns } from '../controllers/column.controller.js';
import { authenticate, checkPermission } from '../middleware/auth.middleware.js';

const router = Router();

router.get('/', authenticate, getColumns);
router.post('/', checkPermission('task.column.update'), updateColumns);

export default router;
