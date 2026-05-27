import { Router } from 'express';
import {
  getBlockers,
  getBlockerById,
  createBlocker,
  updateBlocker,
  deleteBlocker,
} from '../controllers/blocker.controller.js';

const router = Router();

router.get('/', getBlockers);
router.get('/:id', getBlockerById);
router.post('/', createBlocker);
router.put('/:id', updateBlocker);
router.delete('/:id', deleteBlocker);

export default router;
