import { Request, Response } from 'express';
import prisma from '../config/db';

export interface Project {
  id: string;
  name: string;
  description: string;
  status: 'active' | 'completed';
  members: string[];
  updatedAt: string;
  startDate?: string;
  endDate?: string;
  is_archived?: boolean;
}

export interface ProjectMember {
  id: string | number;
  project_id: string;
  user_id: number;
  role: 'admin' | 'editor' | 'viewer';
}

// In-memory mock store for project members
let projectMembers: ProjectMember[] = [
  { id: 'mem-1', project_id: 'prj-1', user_id: 1, role: 'admin' },
  { id: 'mem-2', project_id: 'prj-1', user_id: 2, role: 'editor' },
  { id: 'mem-3', project_id: 'prj-1', user_id: 3, role: 'viewer' },
  { id: 'mem-4', project_id: 'prj-2', user_id: 2, role: 'admin' },
  { id: 'mem-5', project_id: 'prj-2', user_id: 4, role: 'editor' },
  { id: 'mem-6', project_id: 'prj-3', user_id: 1, role: 'admin' },
  { id: 'mem-7', project_id: 'prj-3', user_id: 4, role: 'editor' },
  { id: 'mem-8', project_id: 'prj-3', user_id: 5, role: 'viewer' },
];

// Seeded high-fidelity project data in memory
let projects: Project[] = [
  {
    id: 'prj-1',
    name: 'SDEC ERP Upgrade',
    description: 'Revamp the core corporate resource management software with Next.js and Neon PostgreSQL to support multi-tenant billing pipelines.',
    status: 'active',
    members: ['John Doe', 'Jane Smith', 'Alice Cooper'],
    updatedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(), // 2 days ago
    startDate: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0], // 30 days ago
    endDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0], // 30 days from now
  },
  {
    id: 'prj-2',
    name: 'Client CRM Portal',
    description: 'Develop a custom customer relationships interface for client portal updates and live support ticket tracking integrations.',
    status: 'active',
    members: ['Jane Smith', 'Bob Johnson'],
    updatedAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(), // 5 days ago
    startDate: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString().split('T')[0], // 10 days ago
    endDate: new Date(Date.now() + 15 * 24 * 60 * 60 * 1000).toISOString().split('T')[0], // 15 days from now
  },
  {
    id: 'prj-3',
    name: 'Automated Payroll Engine',
    description: 'Optimize corporate salary dispatching pipelines, tax audit calculations, and automated direct deposit banking APIs.',
    status: 'completed',
    members: ['John Doe', 'Bob Johnson', 'Charlie Brown'],
    updatedAt: new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString(), // 15 days ago
    startDate: new Date(Date.now() - 45 * 24 * 60 * 60 * 1000).toISOString().split('T')[0], // 45 days ago
    endDate: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString().split('T')[0], // 5 days ago
  },
];

/**
 * Fetch all projects (with a slight simulated network delay for skeleton loading visual effect)
 */
export const getProjects = async (req: Request, res: Response) => {
  try {
    // 500ms artificial delay to demonstrate the elegant skeleton load state
    setTimeout(() => {
      res.status(200).json(projects);
    }, 500);
  } catch (error) {
    console.error('Error fetching projects:', error);
    res.status(500).json({ error: 'Failed to fetch projects' });
  }
};

/**
 * Create a new project
 */
export const createProject = async (req: Request, res: Response) => {
  try {
    const { name, description, status, startDate, members } = req.body as any;

    if (!name) {
      return res.status(400).json({ success: false, message: 'Project Name is required' });
    }

    // Resolve member IDs to names
    let resolvedMembers: string[] = [];
    if (Array.isArray(members) && members.length > 0) {
      // Check if they are numbers or strings representing numbers
      const isNumeric = members.every((m: any) => typeof m === 'number' || !isNaN(Number(m)));
      
      if (isNumeric) {
        try {
          const numericIds = members.map((m: any) => Number(m));
          // Attempt to query user names from the database using Postgres raw query
          const users = await prisma.$queryRawUnsafe<any[]>(
            'SELECT id, name FROM users WHERE id = ANY($1::int[])',
            numericIds
          );
          if (users && users.length > 0) {
            resolvedMembers = users.map((u: any) => u.name);
          }
        } catch (dbError) {
          console.warn('Prisma query for users in createProject failed, falling back to mock user map:', dbError);
        }

        // If database query failed or returned no matches, fall back to mock members mapping
        if (resolvedMembers.length === 0) {
          const mockUsers: Record<number, string> = {
            1: 'John Doe',
            2: 'Jane Smith',
            3: 'Alice Cooper',
            4: 'Bob Johnson',
            5: 'Charlie Brown',
            6: 'Diana Prince'
          };
          resolvedMembers = members
            .map((m: any) => mockUsers[Number(m)])
            .filter((name): name is string => !!name);
        }
      } else {
        // If it's already a string array, just use it
        resolvedMembers = members.map((m: any) => String(m));
      }
    }

    if (resolvedMembers.length === 0) {
      resolvedMembers = ['John Doe']; // Default fallback if no members provided/resolved
    }

    const newProject: Project = {
      id: `prj-${Date.now()}`,
      name,
      description: description || '',
      status: status || 'active',
      members: resolvedMembers,
      updatedAt: new Date().toISOString(),
      startDate: startDate || new Date().toISOString().split('T')[0],
    };

    projects = [newProject, ...projects];

    res.status(201).json({ success: true, data: newProject });
  } catch (error) {
    console.error('Error creating project:', error);
    res.status(500).json({ success: false, message: 'Server error creating project' });
  }
};

/**
 * Fetch a single project by ID
 */
export const getProjectById = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const project = projects.find((p) => p.id === id);
    
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }
    
    res.status(200).json(project);
  } catch (error) {
    console.error('Error fetching project by ID:', error);
    res.status(500).json({ error: 'Failed to fetch project' });
  }
};

/**
 * Update an existing project
 * PUT /api/projects/:id
 */
export const updateProject = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { name, description, status, startDate, endDate, members } = req.body as any;

    if (!name) {
      return res.status(400).json({ success: false, message: 'Project Name is required' });
    }

    if (!startDate) {
      return res.status(400).json({ success: false, message: 'Start Date is required' });
    }

    // Validation: End date must be >= Start date if both are provided
    if (endDate && startDate && new Date(endDate) < new Date(startDate)) {
      return res.status(400).json({ success: false, message: 'End date must be on or after start date' });
    }

    const projectIndex = projects.findIndex((p) => p.id === id);
    if (projectIndex === -1) {
      return res.status(404).json({ success: false, message: 'Project not found' });
    }

    const currentProject = projects[projectIndex];

    // Resolve member IDs to names if members list is provided
    let resolvedMembers = currentProject.members;
    if (Array.isArray(members)) {
      if (members.length > 0) {
        const isNumeric = members.every((m: any) => typeof m === 'number' || !isNaN(Number(m)));
        if (isNumeric) {
          try {
            const numericIds = members.map((m: any) => Number(m));
            // Postgres query
            const users = await prisma.$queryRawUnsafe<any[]>(
              'SELECT id, name FROM users WHERE id = ANY($1::int[])',
              numericIds
            );
            if (users && users.length > 0) {
              resolvedMembers = users.map((u: any) => u.name);
            } else {
              // Mock fallback
              const mockUsers: Record<number, string> = {
                1: 'John Doe',
                2: 'Jane Smith',
                3: 'Alice Cooper',
                4: 'Bob Johnson',
                5: 'Charlie Brown',
                6: 'Diana Prince'
              };
              resolvedMembers = members
                .map((m: any) => mockUsers[Number(m)])
                .filter((name): name is string => !!name);
            }
          } catch (dbError) {
            console.warn('Prisma query for users in updateProject failed, falling back to mock mapping:', dbError);
            const mockUsers: Record<number, string> = {
              1: 'John Doe',
              2: 'Jane Smith',
              3: 'Alice Cooper',
              4: 'Bob Johnson',
              5: 'Charlie Brown',
              6: 'Diana Prince'
            };
            resolvedMembers = members
              .map((m: any) => mockUsers[Number(m)])
              .filter((name): name is string => !!name);
          }
        } else {
          resolvedMembers = members.map((m: any) => String(m));
        }
      } else {
        resolvedMembers = ['John Doe'];
      }
    }

    const updatedProject: Project = {
      ...currentProject,
      name,
      description: description || '',
      status: status || currentProject.status,
      members: resolvedMembers,
      updatedAt: new Date().toISOString(),
      startDate,
      endDate: endDate || undefined,
    };

    projects[projectIndex] = updatedProject;

    res.status(200).json({ success: true, message: 'Project updated successfully', data: updatedProject });
  } catch (error) {
    console.error('Error updating project:', error);
    res.status(500).json({ success: false, message: 'Server error updating project' });
  }
};

/**
 * Archive a project (soft-delete)
 * PATCH /api/projects/:id/archive
 */
export const archiveProject = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const projectIndex = projects.findIndex((p) => p.id === id);
    
    if (projectIndex === -1) {
      return res.status(404).json({ error: 'Project not found' });
    }
    
    projects[projectIndex] = {
      ...projects[projectIndex],
      is_archived: true,
      updatedAt: new Date().toISOString(),
    };
    
    res.status(200).json({ success: true, message: 'Project archived successfully', data: projects[projectIndex] });
  } catch (error) {
    console.error('Error archiving project:', error);
    res.status(500).json({ error: 'Failed to archive project' });
  }
};

/**
 * Restore an archived project
 * PATCH /api/projects/:id/restore
 */
export const restoreProject = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const projectIndex = projects.findIndex((p) => p.id === id);
    
    if (projectIndex === -1) {
      return res.status(404).json({ error: 'Project not found' });
    }
    
    projects[projectIndex] = {
      ...projects[projectIndex],
      is_archived: false,
      updatedAt: new Date().toISOString(),
    };
    
    res.status(200).json({ success: true, message: 'Project restored successfully', data: projects[projectIndex] });
  } catch (error) {
    console.error('Error restoring project:', error);
    res.status(500).json({ error: 'Failed to restore project' });
  }
};

/**
 * Permanently delete a project
 * DELETE /api/projects/:id
 */
export const deleteProject = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const projectIndex = projects.findIndex((p) => p.id === id);
    
    if (projectIndex === -1) {
      return res.status(404).json({ error: 'Project not found' });
    }
    
    projects = projects.filter((p) => p.id !== id);
    
    res.status(200).json({ success: true, message: 'Project permanently deleted successfully' });
  } catch (error) {
    console.error('Error permanently deleting project:', error);
    res.status(500).json({ error: 'Failed to permanently delete project' });
  }
};

/**
 * Fetch project members for a specific project
 * GET /api/projects/:id/members
 */
export const getProjectMembers = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    
    try {
      const members = await prisma.$queryRawUnsafe<any[]>(
        `SELECT pm.id, pm.project_id, pm.user_id as "userId", pm.role, u.name, u.email 
         FROM project_members pm 
         JOIN users u ON pm.user_id = u.id 
         WHERE pm.project_id = $1`,
        id
      );
      
      if (members && members.length > 0) {
        return res.status(200).json(members);
      }
      
      const countResult = await prisma.$queryRawUnsafe<any[]>('SELECT COUNT(*) FROM project_members');
      if (countResult) {
        return res.status(200).json(members);
      }
    } catch (dbError) {
      console.warn('Database query for project_members failed, falling back to mock memory.');
    }
    
    // Fallback logic
    const mockUsers: Record<number, any> = {
      1: { name: 'John Doe', email: 'john@example.com' },
      2: { name: 'Jane Smith', email: 'jane@example.com' },
      3: { name: 'Alice Cooper', email: 'alice@example.com' },
      4: { name: 'Bob Johnson', email: 'bob@example.com' },
      5: { name: 'Charlie Brown', email: 'charlie@example.com' },
      6: { name: 'Diana Prince', email: 'diana@example.com' }
    };
    
    const projectMembs = projectMembers.filter(pm => pm.project_id === id);
    const result = projectMembs.map(pm => {
      const user = mockUsers[pm.user_id] || { name: `User ${pm.user_id}`, email: `user${pm.user_id}@example.com` };
      return {
        id: pm.id,
        project_id: pm.project_id,
        userId: pm.user_id,
        role: pm.role,
        name: user.name,
        email: user.email
      };
    });
    
    res.status(200).json(result);
  } catch (error) {
    console.error('Error fetching project members:', error);
    res.status(500).json({ error: 'Failed to fetch project members' });
  }
};

/**
 * Add a member to a project
 * POST /api/projects/:id/members
 */
export const addProjectMember = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { userId, role } = req.body;
    
    if (!userId || !role) {
      return res.status(400).json({ error: 'User ID and role are required' });
    }
    
    if (!['admin', 'editor', 'viewer'].includes(role)) {
      return res.status(400).json({ error: 'Invalid role' });
    }
    
    let newMemberId: string | number;
    
    try {
      const existing = await prisma.$queryRawUnsafe<any[]>(
        'SELECT id FROM project_members WHERE project_id = $1 AND user_id = $2',
        id, Number(userId)
      );
      if (existing && existing.length > 0) {
        return res.status(400).json({ error: 'User is already a member of this project' });
      }
      
      const insertResult = await prisma.$queryRawUnsafe<any[]>(
        'INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, $3) RETURNING id',
        id, Number(userId), role
      );
      if (insertResult && insertResult.length > 0) {
        newMemberId = insertResult[0].id;
      } else {
        newMemberId = `mem-${Date.now()}`;
      }
    } catch (dbError) {
      const isDuplicate = projectMembers.some(pm => pm.project_id === id && pm.user_id === Number(userId));
      if (isDuplicate) {
        return res.status(400).json({ error: 'User is already a member of this project' });
      }
      newMemberId = `mem-${Date.now()}`;
      projectMembers.push({
        id: newMemberId,
        project_id: id as string,
        user_id: Number(userId),
        role
      });
    }
    
    const projectIndex = projects.findIndex(p => p.id === id);
    if (projectIndex !== -1) {
      let userName = `User ${userId}`;
      try {
        const uRes = await prisma.$queryRawUnsafe<any[]>('SELECT name FROM users WHERE id = $1', Number(userId));
        if (uRes && uRes.length > 0) userName = uRes[0].name;
      } catch (err) {
        const mockUsers: Record<number, string> = { 1: 'John Doe', 2: 'Jane Smith', 3: 'Alice Cooper', 4: 'Bob Johnson', 5: 'Charlie Brown', 6: 'Diana Prince' };
        userName = mockUsers[Number(userId)] || userName;
      }
      if (!projects[projectIndex].members.includes(userName)) {
        projects[projectIndex].members.push(userName);
      }
    }
    
    res.status(201).json({ success: true, message: 'Member added successfully', data: { id: newMemberId, project_id: id, userId: Number(userId), role } });
  } catch (error) {
    console.error('Error adding project member:', error);
    res.status(500).json({ error: 'Failed to add project member' });
  }
};

/**
 * Update member role
 * PUT /api/projects/:id/members/:memberId
 */
export const updateProjectMemberRole = async (req: Request, res: Response) => {
  try {
    const { id, memberId } = req.params;
    const { role } = req.body;
    
    if (!role || !['admin', 'editor', 'viewer'].includes(role)) {
      return res.status(400).json({ error: 'Invalid role' });
    }
    
    try {
      const isNumeric = !isNaN(Number(memberId));
      if (isNumeric) {
        await prisma.$executeRawUnsafe(
          'UPDATE project_members SET role = $1 WHERE id = $2 AND project_id = $3',
          role, Number(memberId), id
        );
      } else {
        throw new Error('Fallback');
      }
    } catch (dbError) {
      const idx = projectMembers.findIndex(pm => String(pm.id) === String(memberId));
      if (idx !== -1) {
        projectMembers[idx].role = role as any;
      } else {
        return res.status(404).json({ error: 'Member not found' });
      }
    }
    
    res.status(200).json({ success: true, message: 'Role updated successfully' });
  } catch (error) {
    console.error('Error updating member role:', error);
    res.status(500).json({ error: 'Failed to update member role' });
  }
};

/**
 * Remove a member from a project
 * DELETE /api/projects/:id/members/:memberId
 */
export const removeProjectMember = async (req: Request, res: Response) => {
  try {
    const { id, memberId } = req.params;
    let removedUserId: number | null = null;
    
    try {
      const isNumeric = !isNaN(Number(memberId));
      if (isNumeric) {
        const pm = await prisma.$queryRawUnsafe<any[]>('SELECT user_id FROM project_members WHERE id = $1', Number(memberId));
        if (pm && pm.length > 0) removedUserId = pm[0].user_id;
        
        await prisma.$executeRawUnsafe(
          'DELETE FROM project_members WHERE id = $1 AND project_id = $2',
          Number(memberId), id
        );
      } else {
        throw new Error('Fallback');
      }
    } catch (dbError) {
      const idx = projectMembers.findIndex(pm => String(pm.id) === String(memberId));
      if (idx !== -1) {
        removedUserId = projectMembers[idx].user_id;
        projectMembers = projectMembers.filter(pm => String(pm.id) !== String(memberId));
      } else {
        return res.status(404).json({ error: 'Member not found' });
      }
    }
    
    if (removedUserId) {
      const projectIndex = projects.findIndex(p => p.id === id);
      if (projectIndex !== -1) {
        let userName = `User ${removedUserId}`;
        try {
          const uRes = await prisma.$queryRawUnsafe<any[]>('SELECT name FROM users WHERE id = $1', removedUserId);
          if (uRes && uRes.length > 0) userName = uRes[0].name;
        } catch (err) {
          const mockUsers: Record<number, string> = { 1: 'John Doe', 2: 'Jane Smith', 3: 'Alice Cooper', 4: 'Bob Johnson', 5: 'Charlie Brown', 6: 'Diana Prince' };
          userName = mockUsers[removedUserId] || userName;
        }
        projects[projectIndex].members = projects[projectIndex].members.filter(m => m !== userName);
      }
    }
    
    res.status(200).json({ success: true, message: 'Member removed successfully' });
  } catch (error) {
    console.error('Error removing member:', error);
    res.status(500).json({ error: 'Failed to remove member' });
  }
};
