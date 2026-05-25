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
} from '../controllers/project.controller';

const router = Router();

router.get('/', getProjects);
router.post('/', createProject);
router.get('/:id', getProjectById);
router.put('/:id', updateProject);
router.patch('/:id/archive', archiveProject);
router.patch('/:id/restore', restoreProject);
router.delete('/:id', deleteProject);

// Member Management Routes
router.get('/:id/members', getProjectMembers);
router.post('/:id/members', addProjectMember);
router.put('/:id/members/:memberId', updateProjectMemberRole);
router.delete('/:id/members/:memberId', removeProjectMember);

export default router;
