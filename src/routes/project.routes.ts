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
  removeProjectMember,
  getProjectBoards,
  getProjectTasks,
  getProjectBugs,
  getProjectDashboardStats,
  getProjectActivities,
  importProjectBacklog
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

// Backlog Import
router.post('/:id/import', checkProjectRole(['admin', 'editor']), importProjectBacklog);

// Member Management Routes
router.get('/:id/members', authenticate, getProjectMembers);
router.post('/:id/members', checkProjectRole(['admin']), addProjectMember);
router.put('/:id/members/:memberId', checkProjectRole(['admin']), updateProjectMemberRole);
router.delete('/:id/members/:memberId', checkProjectRole(['admin']), removeProjectMember);

// Scoped Data Routes (Accessible by any member)
router.get('/:id/boards', checkProjectRole(['admin', 'editor', 'viewer']), getProjectBoards);
router.get('/:id/tasks', checkProjectRole(['admin', 'editor', 'viewer']), getProjectTasks);
router.get('/:id/bugs', checkProjectRole(['admin', 'editor', 'viewer']), getProjectBugs);
router.get('/:id/dashboard-stats', checkProjectRole(['admin', 'editor', 'viewer']), getProjectDashboardStats);
router.get('/:id/activities', checkProjectRole(['admin', 'editor', 'viewer']), getProjectActivities);

export default router;
