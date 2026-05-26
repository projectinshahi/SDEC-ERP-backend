import { Router } from 'express';
import { getBugs, getBugById, createBug, updateBug, deleteBug } from '../controllers/bug.controller';

const router = Router();

router.get('/', getBugs);
router.get('/:id', getBugById);
router.post('/', createBug);
router.put('/:id', updateBug);
router.delete('/:id', deleteBug);

export default router;
