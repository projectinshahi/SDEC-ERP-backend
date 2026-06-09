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
  importProjectBacklog,
  getProjectSprintAnalytics
} from '../controllers/project.controller.js';

import { authenticate, checkProjectRole, checkPermission } from '../middleware/auth.middleware.js';
import { 
  getDocuments, 
  uploadDocument, 
  updateDocument, 
  deleteDocument,
  uploadMiddleware 
} from '../controllers/project_documents.controller.js';

const router = Router();

router.get('/', authenticate, getProjects);
// Only global Admins can create projects, which is enforced in createProject
router.post('/', checkPermission('project.create'), createProject);
router.get('/:id', authenticate, getProjectById);

// Project Settings / Details
router.put('/:id', checkPermission('project.edit'), checkProjectRole(['admin', 'editor']), updateProject);
router.patch('/:id/archive', checkPermission('project.delete'), checkProjectRole(['admin']), archiveProject);
router.patch('/:id/restore', checkPermission('project.delete'), checkProjectRole(['admin']), restoreProject);
router.delete('/:id', checkPermission('project.delete'), checkProjectRole(['admin']), deleteProject);

// Backlog Import
router.post('/:id/import', checkPermission('project.edit'), checkProjectRole(['admin', 'editor']), importProjectBacklog);

// Member Management Routes
router.get('/:id/members', checkProjectRole(['admin', 'editor', 'viewer']), getProjectMembers);
router.post('/:id/members', checkPermission('project.manage_members'), checkProjectRole(['admin']), addProjectMember);
router.put('/:id/members/:memberId', checkPermission('project.manage_members'), checkProjectRole(['admin']), updateProjectMemberRole);
router.delete('/:id/members/:memberId', checkPermission('project.manage_members'), checkProjectRole(['admin']), removeProjectMember);

// Scoped Data Routes (Accessible by any member)
router.get('/:id/boards', checkPermission('project.view'), checkProjectRole(['admin', 'editor', 'viewer']), getProjectBoards);
router.get('/:id/tasks', checkPermission('project.view'), checkProjectRole(['admin', 'editor', 'viewer']), getProjectTasks);
router.get('/:id/bugs', checkPermission('project.view'), checkProjectRole(['admin', 'editor', 'viewer']), getProjectBugs);
router.get('/:id/dashboard-stats', checkPermission('project.analytics'), checkProjectRole(['admin', 'editor', 'viewer']), getProjectDashboardStats);
router.get('/:id/activities', checkPermission('project.view'), checkProjectRole(['admin', 'editor', 'viewer']), getProjectActivities);
router.get('/:id/sprint-analytics', checkPermission('project.analytics'), checkProjectRole(['admin', 'editor', 'viewer']), getProjectSprintAnalytics);

// Project Documents Routes
router.get('/:id/documents', checkPermission('project.view'), checkProjectRole(['admin', 'editor', 'viewer']), getDocuments);
router.post('/:id/documents', checkPermission('project.edit'), checkProjectRole(['admin', 'editor']), uploadMiddleware.single('file'), uploadDocument);
router.put('/:id/documents/:documentId', checkPermission('project.edit'), checkProjectRole(['admin', 'editor']), updateDocument);
router.delete('/:id/documents/:documentId', checkPermission('project.edit'), checkProjectRole(['admin', 'editor']), deleteDocument);

export default router;
