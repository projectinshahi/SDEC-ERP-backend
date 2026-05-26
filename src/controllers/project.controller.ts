import { Request, Response } from 'express';
import prisma from '../config/db';

/**
 * Helper to fetch a project with its members and format it for the frontend
 */
async function formatProject(project: any) {
  return {
    ...project,
    members: project.project_members ? project.project_members.map((pm: any) => pm.user?.name || `User ${pm.user_id}`) : [],
  };
}

export const getProjects = async (req: Request, res: Response) => {
  try {
    const dbProjects = await prisma.projects.findMany({
      include: {
        project_members: {
          include: { user: true }
        }
      },
      orderBy: { createdAt: 'desc' }
    });

    const formatted = await Promise.all(dbProjects.map(formatProject));
    res.status(200).json(formatted);
  } catch (error) {
    console.error('Error fetching projects:', error);
    res.status(500).json({ error: 'Failed to fetch projects' });
  }
};

export const createProject = async (req: Request, res: Response) => {
  try {
    const { name, description, status, startDate, members } = req.body as any;
    if (!name) return res.status(400).json({ success: false, message: 'Project Name is required' });

    let numericMemberIds: number[] = [];
    if (Array.isArray(members)) {
      numericMemberIds = members.map(m => Number(m)).filter(m => !isNaN(m));
    }
    if (numericMemberIds.length === 0) numericMemberIds = [1];

    const newProject = await prisma.projects.create({
      data: {
        id: `prj-${Date.now()}`,
        name,
        description: description || '',
        status: status || 'active',
        startDate: startDate || new Date().toISOString().split('T')[0],
        project_members: {
          create: numericMemberIds.map(uid => ({
            user_id: uid,
            role: 'editor'
          }))
        }
      },
      include: {
        project_members: { include: { user: true } }
      }
    });

    res.status(201).json({ success: true, data: await formatProject(newProject) });
  } catch (error) {
    console.error('Error creating project:', error);
    res.status(500).json({ success: false, message: 'Server error creating project' });
  }
};

export const getProjectById = async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    const project = await prisma.projects.findUnique({
      where: { id },
      include: { project_members: { include: { user: true } } }
    });
    
    if (!project) return res.status(404).json({ error: 'Project not found' });
    res.status(200).json(await formatProject(project));
  } catch (error) {
    console.error('Error fetching project by ID:', error);
    res.status(500).json({ error: 'Failed to fetch project' });
  }
};

export const updateProject = async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    const { name, description, status, startDate, endDate, members } = req.body as any;

    if (!name) return res.status(400).json({ success: false, message: 'Project Name is required' });
    if (!startDate) return res.status(400).json({ success: false, message: 'Start Date is required' });
    if (endDate && startDate && new Date(endDate) < new Date(startDate)) {
      return res.status(400).json({ success: false, message: 'End date must be on or after start date' });
    }

    const existingProject = await prisma.projects.findUnique({ where: { id } });
    if (!existingProject) return res.status(404).json({ success: false, message: 'Project not found' });

    const updateData: any = {
      name,
      description: description || '',
      status: status || existingProject.status,
      startDate,
      endDate: endDate || null,
    };

    if (Array.isArray(members)) {
      const numericMemberIds = members.map(m => Number(m)).filter(m => !isNaN(m));
      updateData.project_members = {
        deleteMany: {},
        create: numericMemberIds.map(uid => ({ user_id: uid, role: 'editor' }))
      };
    }

    const updatedProject = await prisma.projects.update({
      where: { id },
      data: updateData,
      include: { project_members: { include: { user: true } } }
    });

    res.status(200).json({ success: true, message: 'Project updated successfully', data: await formatProject(updatedProject) });
  } catch (error) {
    console.error('Error updating project:', error);
    res.status(500).json({ success: false, message: 'Server error updating project' });
  }
};

export const archiveProject = async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    const project = await prisma.projects.update({
      where: { id },
      data: { is_archived: true },
      include: { project_members: { include: { user: true } } }
    });
    res.status(200).json({ success: true, message: 'Project archived successfully', data: await formatProject(project) });
  } catch (error) {
    console.error('Error archiving project:', error);
    res.status(500).json({ error: 'Failed to archive project' });
  }
};

export const restoreProject = async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    const project = await prisma.projects.update({
      where: { id },
      data: { is_archived: false },
      include: { project_members: { include: { user: true } } }
    });
    res.status(200).json({ success: true, message: 'Project restored successfully', data: await formatProject(project) });
  } catch (error) {
    console.error('Error restoring project:', error);
    res.status(500).json({ error: 'Failed to restore project' });
  }
};

export const deleteProject = async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    await prisma.projects.delete({ where: { id } });
    res.status(200).json({ success: true, message: 'Project permanently deleted successfully' });
  } catch (error: any) {
    if (error.code === 'P2025') return res.status(404).json({ error: 'Project not found' });
    console.error('Error permanently deleting project:', error);
    res.status(500).json({ error: 'Failed to permanently delete project' });
  }
};

export const getProjectMembers = async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    const members = await prisma.project_members.findMany({
      where: { project_id: id },
      include: { user: true }
    });

    const result = members.map(pm => ({
      id: pm.id,
      project_id: pm.project_id,
      userId: pm.user_id,
      role: pm.role,
      name: pm.user?.name || `User ${pm.user_id}`,
      email: pm.user?.email || `user${pm.user_id}@example.com`
    }));
    
    res.status(200).json(result);
  } catch (error) {
    console.error('Error fetching project members:', error);
    res.status(500).json({ error: 'Failed to fetch project members' });
  }
};

export const addProjectMember = async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    const { userId, role } = req.body;
    
    if (!userId || !role) return res.status(400).json({ error: 'User ID and role are required' });
    if (!['admin', 'editor', 'viewer'].includes(role)) return res.status(400).json({ error: 'Invalid role' });
    
    const existing = await prisma.project_members.findUnique({
      where: {
        project_id_user_id: { project_id: id, user_id: Number(userId) }
      }
    });

    if (existing) return res.status(400).json({ error: 'User is already a member of this project' });
    
    const newMember = await prisma.project_members.create({
      data: { project_id: id, user_id: Number(userId), role }
    });
    
    res.status(201).json({ success: true, message: 'Member added successfully', data: { id: newMember.id, project_id: id, userId: Number(userId), role } });
  } catch (error) {
    console.error('Error adding project member:', error);
    res.status(500).json({ error: 'Failed to add project member' });
  }
};

export const updateProjectMemberRole = async (req: Request, res: Response) => {
  try {
    const memberId = req.params.memberId as string;
    const { role } = req.body;
    
    if (!role || !['admin', 'editor', 'viewer'].includes(role)) return res.status(400).json({ error: 'Invalid role' });
    
    await prisma.project_members.update({
      where: { id: Number(memberId) },
      data: { role }
    });
    
    res.status(200).json({ success: true, message: 'Role updated successfully' });
  } catch (error: any) {
    if (error.code === 'P2025') return res.status(404).json({ error: 'Member not found' });
    console.error('Error updating member role:', error);
    res.status(500).json({ error: 'Failed to update member role' });
  }
};

export const removeProjectMember = async (req: Request, res: Response) => {
  try {
    const memberId = req.params.memberId as string;
    
    await prisma.project_members.delete({
      where: { id: Number(memberId) }
    });
    
    res.status(200).json({ success: true, message: 'Member removed successfully' });
  } catch (error: any) {
    if (error.code === 'P2025') return res.status(404).json({ error: 'Member not found' });
    console.error('Error removing member:', error);
    res.status(500).json({ error: 'Failed to remove member' });
  }
};
