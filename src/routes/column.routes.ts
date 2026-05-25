import { Router } from 'express';
import { getColumns, updateColumns } from '../controllers/column.controller';

const router = Router();

router.get('/', getColumns);
router.post('/', updateColumns);

export default router;
