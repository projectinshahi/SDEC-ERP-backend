import { Router } from 'express';
import { createRole, getRoles, updateRole, deleteRole } from '../controllers/role.controller.js';

const router = Router();

router.get('/', getRoles);
router.post('/', createRole);
router.put('/:id', updateRole);
router.delete('/:id', deleteRole);

export default router;
