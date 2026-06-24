import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware.js';
import {
  getProjectCategories,
  createProjectCategory,
  updateProjectCategory,
  deleteProjectCategory,
} from '../controllers/category.controller.js';

const router = Router();

// Any authenticated user can read the list (needed to populate dropdowns/filters).
router.get('/', authenticate, getProjectCategories);

// Mutations are Admin / SuperAdmin only — enforced in-controller via isGlobalAdmin.
router.post('/', authenticate, createProjectCategory);
router.put('/:id', authenticate, updateProjectCategory);
router.delete('/:id', authenticate, deleteProjectCategory);

export default router;
