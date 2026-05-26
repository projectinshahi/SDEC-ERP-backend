import { Router } from 'express';
import { getColumns, updateColumns } from '../controllers/column.controller';
import { checkPermission } from '../middleware/auth.middleware';

const router = Router();

router.get('/', getColumns);
router.post('/', checkPermission('task.column.update'), updateColumns);

export default router;
