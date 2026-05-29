import { Router } from 'express';
import { getSprints, getSprintById, createSprint, updateSprint, deleteSprint } from '../controllers/sprint.controller.js';

const router = Router();

router.get('/', getSprints);
router.get('/:id', getSprintById);
router.post('/', createSprint);
router.put('/:id', updateSprint);
router.delete('/:id', deleteSprint);

export default router;
