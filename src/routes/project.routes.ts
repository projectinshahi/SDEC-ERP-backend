import { Router } from 'express';
import { 
  getProjects, 
  createProject, 
  getProjectById, 
  updateProject, 
  archiveProject, 
  restoreProject,
  deleteProject,
  getProjectMembers,
  addProjectMember,
  updateProjectMemberRole,
  removeProjectMember
} from '../controllers/project.controller.js';

import { authenticate, checkProjectRole } from '../middleware/auth.middleware.js';

const router = Router();

router.get('/', authenticate, getProjects);
// Only global Admins can create projects, which is enforced in createProject
router.post('/', authenticate, createProject);
router.get('/:id', authenticate, getProjectById);

// Project Settings / Details
router.put('/:id', checkProjectRole(['admin', 'editor']), updateProject);
router.patch('/:id/archive', checkProjectRole(['admin']), archiveProject);
router.patch('/:id/restore', checkProjectRole(['admin']), restoreProject);
router.delete('/:id', checkProjectRole(['admin']), deleteProject);

// Member Management Routes
router.get('/:id/members', authenticate, getProjectMembers);
router.post('/:id/members', checkProjectRole(['admin']), addProjectMember);
router.put('/:id/members/:memberId', checkProjectRole(['admin']), updateProjectMemberRole);
router.delete('/:id/members/:memberId', checkProjectRole(['admin']), removeProjectMember);

export default router;
