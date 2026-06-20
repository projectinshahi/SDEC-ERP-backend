import { Request, Response } from 'express';
import prisma from '../config/db.js';
import { activityService } from '../services/activity.service.js';
import { calculateSprintStatus, calculateWorkingDays, calculateTeamCapacity } from './kanban.controller.js';
import { isGlobalAdmin } from '../utils/roles.js';

/**
 * Helper to fetch a project with its members and format it for the frontend
 */
async function formatProject(project: any) {
  return {
    ...project,
    members: project.project_members ? project.project_members.map((pm: any) => pm.user?.name || `User ${pm.user_id}`) : [],
    memberDetails: project.project_members ? project.project_members.map((pm: any) => ({
      userId: pm.user_id,
      role: pm.role,
      capacityPoints: pm.capacity_points || 0,
      name: pm.user?.name || `User ${pm.user_id}`,
      email: pm.user?.email || `user${pm.user_id}@example.com`
    })) : [],
    owner: project.owner ? { id: project.owner.id, name: project.owner.name } : null
  };
}

// ── Project lifecycle status ────────────────────────────────────────────────
// Canonical statuses (mirror erp-frontend/lib/projects/projectStatus.ts).
// Stored lowercase/hyphenated; is_archived is derived from status === 'archived'.
const PROJECT_STATUS_LABELS: Record<string, string> = {
  active: 'Active', 'on-track': 'On Track', delayed: 'Delayed', 'on-hold': 'On Hold',
  completed: 'Completed', archived: 'Archived', planning: 'Planning', 'at-risk': 'At Risk', cancelled: 'Cancelled',
};
const PROJECT_STATUS_SYNONYMS: Record<string, string> = {
  active: 'active', 'in-progress': 'active', ongoing: 'active', inprogress: 'active',
  'on-track': 'on-track', ontrack: 'on-track',
  delayed: 'delayed', overdue: 'delayed',
  'on-hold': 'on-hold', onhold: 'on-hold', hold: 'on-hold', paused: 'on-hold',
  completed: 'completed', complete: 'completed', done: 'completed', closed: 'completed',
  archived: 'archived', archive: 'archived',
  planning: 'planning', planned: 'planning', new: 'planning', draft: 'planning', backlog: 'planning', todo: 'planning', 'not-started': 'planning',
  'at-risk': 'at-risk', atrisk: 'at-risk', risk: 'at-risk',
  cancelled: 'cancelled', canceled: 'cancelled',
};
function normalizeProjectStatus(raw?: string | null): string {
  const key = String(raw ?? '').trim().toLowerCase().replace(/[\s_]+/g, '-');
  return PROJECT_STATUS_SYNONYMS[key] || (PROJECT_STATUS_LABELS[key] ? key : 'active');
}
const projectStatusLabel = (raw?: string | null): string => PROJECT_STATUS_LABELS[normalizeProjectStatus(raw)] || 'Active';

export const getProjects = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    const userRole = ((req as any).userRole || '').toLowerCase();

    // Super Admin bypass
    const isSuperAdmin = isGlobalAdmin(userRole);

    const dbProjects = await prisma.projects.findMany({
      where: isSuperAdmin ? undefined : {
        project_members: {
          some: { user_id: userId }
        }
      },
      include: {
        owner: true,
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

    const { name, description, status, startDate, members, owner_id, memberDetails } = req.body as any;
    if (!name) return res.status(400).json({ success: false, message: 'Project Name is required' });

    let finalMembers: any[] = [];
    if (Array.isArray(memberDetails) && memberDetails.length > 0) {
      finalMembers = memberDetails;
    } else if (Array.isArray(members)) {
      // Fallback for legacy format
      const numericMemberIds = members.map(m => Number(m)).filter(m => !isNaN(m));
      finalMembers = numericMemberIds.map(id => ({ userId: id, role: 'editor', capacityPoints: 0 }));
    }

    const userId = (req as any).userId;
    if (userId && !finalMembers.some(m => Number(m.userId) === Number(userId))) {
      finalMembers.push({ userId, role: 'admin', capacityPoints: 0 });
    }

    if (finalMembers.length === 0) finalMembers.push({ userId: 1, role: 'admin', capacityPoints: 0 });

    const newProject = await prisma.projects.create({
      data: {
        id: `prj-${Date.now()}`,
        name,
        description: description || '',
        status: status || 'active',
        startDate: startDate || new Date().toISOString().split('T')[0],
        owner_id: owner_id ? Number(owner_id) : null,
        project_members: {
          create: finalMembers.map(m => ({
            user_id: Number(m.userId),
            role: m.role || 'viewer',
            capacity_points: Number(m.capacityPoints) || 0
          }))
        }
      },
      include: {
        owner: true,
        project_members: { include: { user: true } }
      }
    });

    if (userId) {
      await activityService.logActivity({
        actorUserId: userId,
        projectId: newProject.id,
        type: 'project_created',
        description: `Created project '${newProject.name}'`
      });
    }

    res.status(201).json({ success: true, data: await formatProject(newProject) });
  } catch (error) {
    console.error('Error creating project:', error);
    res.status(500).json({ success: false, message: 'Server error creating project' });
  }
};

export const getProjectById = async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    const userId = (req as any).userId;
    const userRole = ((req as any).userRole || '').toLowerCase();

    const isSuperAdmin = isGlobalAdmin(userRole);

    const project = await prisma.projects.findUnique({
      where: { id },
      include: { owner: true, project_members: { include: { user: true } } }
    });

    if (!project) return res.status(404).json({ error: 'Project not found' });

    if (!isSuperAdmin) {
      const isMember = project.project_members.some((pm: any) => pm.user_id === userId);
      if (!isMember) {
        return res.status(403).json({ error: 'Forbidden: You do not have access to this project' });
      }
    }

    res.status(200).json(await formatProject(project));
  } catch (error) {
    console.error('Error fetching project by ID:', error);
    res.status(500).json({ error: 'Failed to fetch project' });
  }
};

export const updateProject = async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    const { name, description, status, startDate, endDate, members, owner_id, memberDetails } = req.body as any;

    if (!name) return res.status(400).json({ success: false, message: 'Project Name is required' });
    if (!startDate) return res.status(400).json({ success: false, message: 'Start Date is required' });
    if (endDate && startDate && new Date(endDate) < new Date(startDate)) {
      return res.status(400).json({ success: false, message: 'End date must be on or after start date' });
    }

    const existingProject = await prisma.projects.findUnique({ where: { id } });
    if (!existingProject) return res.status(404).json({ success: false, message: 'Project not found' });

    // Status is manually managed (Edit Project modal) and is the single source
    // of truth for the archived flag: is_archived = (status === 'archived').
    const prevStatus = normalizeProjectStatus(existingProject.status);
    const nextStatus = normalizeProjectStatus(status ?? existingProject.status);
    const wasArchived = !!existingProject.is_archived || prevStatus === 'archived';
    const nowArchived = nextStatus === 'archived';

    const updateData: any = {
      name,
      description: description || '',
      status: nextStatus,
      is_archived: nowArchived,
      startDate,
      endDate: endDate || null,
      owner_id: owner_id !== undefined ? (owner_id ? Number(owner_id) : null) : existingProject.owner_id,
    };
    // Preserve the pre-archive status so a later restore returns it; clear it
    // whenever the project leaves the archived state.
    if (nowArchived && !wasArchived) {
      updateData.status_before_archive = prevStatus;
    } else if (!nowArchived) {
      updateData.status_before_archive = null;
    }

    let projectMembersCreate: any[] | null = null;
    if (Array.isArray(memberDetails)) {
      projectMembersCreate = memberDetails.map((m: any) => ({
        user_id: Number(m.userId),
        role: m.role || 'viewer',
        capacity_points: Number(m.capacityPoints) || 0
      }));
    } else if (Array.isArray(members)) {
      const numericMemberIds = members.map((m: any) => Number(m)).filter((m: any) => !isNaN(m));
      projectMembersCreate = numericMemberIds.map(uid => ({ user_id: uid, role: 'editor', capacity_points: 0 }));
    }

    if (projectMembersCreate) {
      updateData.project_members = {
        deleteMany: {},
        create: projectMembersCreate
      };
    }

    const updatedProject = await prisma.projects.update({
      where: { id },
      data: updateData,
      include: { owner: true, project_members: { include: { user: true } } }
    });

    const userId = (req as any).userId;
    if (userId) {
      // Dedicated status-change audit record (User · Old → New · Project).
      if (prevStatus !== nextStatus) {
        await activityService.logActivity({
          actorUserId: userId,
          projectId: updatedProject.id,
          type: 'project_status_changed',
          description: `changed project status: ${projectStatusLabel(prevStatus)} → ${projectStatusLabel(nextStatus)}`
        });
      }
      await activityService.logActivity({
        actorUserId: userId,
        projectId: updatedProject.id,
        type: 'project_updated',
        description: `Updated project '${updatedProject.name}'`
      });
    }

    res.status(200).json({ success: true, message: 'Project updated successfully', data: await formatProject(updatedProject) });
  } catch (error) {
    console.error('Error updating project:', error);
    res.status(500).json({ success: false, message: 'Server error updating project' });
  }
};

export const archiveProject = async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;

    const existing = await prisma.projects.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ success: false, message: 'Project not found' });

    // Preserve the pre-archive status exactly once — if it's already archived,
    // keep whatever was stored so re-archiving never clobbers the real status.
    const priorStatus = existing.is_archived
      ? ((existing as any).status_before_archive ?? null)
      : existing.status;

    const project = await prisma.projects.update({
      where: { id },
      // Data integrity: an archived project ALWAYS has status = 'archived'.
      data: { is_archived: true, status: 'archived', status_before_archive: priorStatus },
      include: { owner: true, project_members: { include: { user: true } } }
    });

    const userId = (req as any).userId;
    if (userId) {
      await activityService.logActivity({
        actorUserId: userId,
        projectId: project.id,
        type: 'project_archived',
        description: `Archived project '${project.name}'`
      });
    }

    res.status(200).json({ success: true, message: 'Project archived successfully', data: await formatProject(project) });
  } catch (error) {
    console.error('Error archiving project:', error);
    res.status(500).json({ error: 'Failed to archive project' });
  }
};

export const restoreProject = async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;

    const existing = await prisma.projects.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ success: false, message: 'Project not found' });

    // Restore the status captured at archive time. Fall back to 'active' when
    // there's nothing valid to restore (never leave it as 'archived').
    let restoredStatus = (existing as any).status_before_archive as string | null;
    if (!restoredStatus || restoredStatus.toLowerCase() === 'archived') restoredStatus = 'active';

    const project = await prisma.projects.update({
      where: { id },
      data: { is_archived: false, status: restoredStatus, status_before_archive: null },
      include: { owner: true, project_members: { include: { user: true } } }
    });

    const userId = (req as any).userId;
    if (userId) {
      await activityService.logActivity({
        actorUserId: userId,
        projectId: project.id,
        type: 'project_restored',
        description: `Restored project '${project.name}'`
      });
    }

    res.status(200).json({ success: true, message: 'Project restored successfully', data: await formatProject(project) });
  } catch (error) {
    console.error('Error restoring project:', error);
    res.status(500).json({ error: 'Failed to restore project' });
  }
};

export const deleteProject = async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;

    // Get project name before deletion for the log message
    const project = await prisma.projects.findUnique({
      where: { id },
      select: { name: true }
    });

    await prisma.projects.delete({ where: { id } });

    const userId = (req as any).userId;
    if (userId && project) {
      await activityService.logActivity({
        actorUserId: userId,
        projectId: undefined,
        type: 'project_deleted',
        description: `Deleted project '${project.name}'`
      });
    }

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

    const result = members.map((pm: any) => ({
      id: pm.id,
      project_id: pm.project_id,
      userId: pm.user_id,
      role: pm.role,
      capacityPoints: pm.capacity_points,
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

    const actorId = (req as any).userId;
    if (actorId) {
      await activityService.logActivity({
        actorUserId: actorId,
        targetUserId: Number(userId),
        projectId: id,
        type: 'member_added',
        description: `Added a member to the project`
      });
    }

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
    const projectId = req.params.id as string;
    const memberId = req.params.memberId as string;

    await prisma.project_members.delete({
      where: { id: Number(memberId) }
    });

    const actorId = (req as any).userId;
    if (actorId) {
      await activityService.logActivity({
        actorUserId: actorId,
        projectId: projectId,
        type: 'member_removed',
        description: `Removed a member from the project`
      });
    }

    res.status(200).json({ success: true, message: 'Member removed successfully' });
  } catch (error: any) {
    if (error.code === 'P2025') return res.status(404).json({ error: 'Member not found' });
    console.error('Error removing member:', error);
    res.status(500).json({ error: 'Failed to remove member' });
  }
};

export const bulkUpdateProjectMembers = async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    const { members } = req.body;

    await prisma.$transaction(async (tx) => {
      // Clear existing members
      await tx.project_members.deleteMany({ where: { project_id: id } });

      // Insert new members
      if (members && members.length > 0) {
        await tx.project_members.createMany({
          data: members.map((m: any) => ({
            project_id: id,
            user_id: Number(m.userId),
            role: m.role || 'viewer',
            capacity_points: Number(m.capacityPoints) || 0
          }))
        });
      }
    });

    const actorId = (req as any).userId;
    if (actorId) {
      await activityService.logActivity({
        actorUserId: actorId,
        projectId: id,
        type: 'member_updated',
        description: `Bulk updated project members`
      });
    }

    res.status(200).json({ success: true, message: 'Members updated successfully' });
  } catch (error) {
    console.error('Error bulk updating project members:', error);
    res.status(500).json({ error: 'Failed to bulk update members' });
  }
};

// --- Scoped Data Controllers ---

export const getProjectBoards = async (req: Request, res: Response) => {
  try {
    const projectId = req.params.id as string;
    const boards = await prisma.kanban_boards.findMany({
      where: { projectId },
      orderBy: { createdAt: 'desc' }
    });
    res.status(200).json(boards);
  } catch (error) {
    console.error('Error fetching project boards:', error);
    res.status(500).json({ error: 'Failed to fetch project boards' });
  }
};

export const getProjectTasks = async (req: Request, res: Response) => {
  try {
    const projectId = req.params.id as string;
    // Fetch tasks where the board belongs to this project
    const tasks = await prisma.kanban_tasks.findMany({
      where: {
        board: { projectId }
      },
      orderBy: { order_index: 'asc' }
    });

    const formatted = tasks.map((t: any) => ({
      id: t.id,
      title: t.title,
      description: t.description,
      priority: t.priority,
      assignee: t.assignee,
      status: t.status,
      dueDate: t.dueDate,
      storyPoints: t.storyPoints,
      boardId: t.board_id,
      originTaskId: t.originTaskId
    }));

    res.status(200).json(formatted);
  } catch (error) {
    console.error('Error fetching project tasks:', error);
    res.status(500).json({ error: 'Failed to fetch project tasks' });
  }
};

export const getProjectBugs = async (req: Request, res: Response) => {
  try {
    const projectId = req.params.id as string;
    const bugs = await prisma.bugs.findMany({
      where: { project_id: projectId },
      orderBy: { createdAt: 'desc' }
    });
    res.status(200).json({ success: true, data: bugs });
  } catch (error) {
    console.error('Error fetching project bugs:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch project bugs' });
  }
};

export const getProjectDashboardStats = async (req: Request, res: Response) => {
  try {
    const projectId = req.params.id as string;

    const [totalTasks, activeTasks, completedTasks, openBugs, teamMembers] = await Promise.all([
      prisma.kanban_tasks.count({
        where: { board: { projectId } }
      }),
      prisma.kanban_tasks.count({
        where: {
          board: { projectId },
          NOT: {
            OR: [
              { status: { equals: 'done', mode: 'insensitive' } },
              { status: { equals: 'completed', mode: 'insensitive' } },
              { status: { equals: 'closed', mode: 'insensitive' } },
              { status: { equals: 'resolved', mode: 'insensitive' } }
            ]
          }
        }
      }),
      prisma.kanban_tasks.count({
        where: {
          board: { projectId },
          OR: [
            { status: { equals: 'done', mode: 'insensitive' } },
            { status: { equals: 'completed', mode: 'insensitive' } },
            { status: { equals: 'closed', mode: 'insensitive' } },
            { status: { equals: 'resolved', mode: 'insensitive' } }
          ]
        }
      }),
      prisma.bugs.count({
        where: {
          project_id: projectId,
          OR: [
            { status: { equals: 'open', mode: 'insensitive' } },
            { status: { equals: 'new', mode: 'insensitive' } }
          ]
        }
      }),
      prisma.project_members.count({
        where: { project_id: projectId }
      })
    ]);

    res.status(200).json({
      totalTasks,
      activeTasks,
      completedTasks,
      openBugs,
      teamMembers
    });
  } catch (error) {
    console.error('Error fetching dashboard stats:', error);
    res.status(500).json({ error: 'Failed to fetch dashboard stats' });
  }
};

export const getProjectActivities = async (req: Request, res: Response) => {
  try {
    const projectId = req.params.id as string;
    const limit = parseInt((req.query.limit as string) || '20');

    // Find all board IDs belonging to this project
    const projectBoards = await prisma.kanban_boards.findMany({
      where: { projectId },
      select: { id: true }
    });
    const boardIds = projectBoards.map((b: any) => b.id);

    // Find all task IDs belonging to those boards
    let taskIds: string[] = [];
    if (boardIds.length > 0) {
      const projectTasks = await prisma.kanban_tasks.findMany({
        where: { board_id: { in: boardIds } },
        select: { id: true }
      });
      taskIds = projectTasks.map((t: any) => t.id);
    }

    // Find all blocker IDs belonging to this project
    const projectBlockers = await prisma.blocker.findMany({
      where: { projectId },
      select: { id: true }
    });
    const blockerIds = projectBlockers.map((b: any) => b.id);

    // Build OR conditions: activities directly tagged with project_id,
    // OR linked to tasks in this project, OR linked to blockers in this project
    const orConditions: any[] = [
      { project_id: projectId }
    ];
    if (taskIds.length > 0) {
      orConditions.push({ task_id: { in: taskIds } });
    }
    if (blockerIds.length > 0) {
      orConditions.push({ blocker_id: { in: blockerIds } });
    }

    const activities = await prisma.activity_logs.findMany({
      where: { OR: orConditions },
      orderBy: { created_at: 'desc' },
      take: limit,
      include: {
        actor: { select: { id: true, name: true, email: true } },
        target: { select: { id: true, name: true, email: true } },
        project: { select: { id: true, name: true } },
        task: { select: { id: true, title: true } }
      }
    });

    res.status(200).json(activities);
  } catch (error) {
    console.error('Error fetching project activities:', error);
    res.status(500).json({ error: 'Failed to fetch activities' });
  }
};

export const importProjectBacklog = async (req: Request, res: Response) => {
  try {
    const projectId = req.params.id as string;
    const { tasks } = req.body;

    if (!Array.isArray(tasks) || tasks.length === 0) {
      return res.status(400).json({ error: 'No tasks provided for import' });
    }

    const boardNames = [...new Set(tasks.map((t: any) => t.Board).filter(Boolean))] as string[];
    let boardsCreated = 0;
    let columnsCreated = 0;
    let tasksImported = 0;
    let skippedTasks = 0;
    let skippedDueToInvalidDate = 0;

    await prisma.$transaction(async (tx) => {
      const boardMap = new Map<string, number>();
      const inProgressColumnMap = new Map<number, string>();

      for (const boardName of boardNames) {
        let board = await tx.kanban_boards.findFirst({
          where: { projectId, name: boardName }
        });

        if (!board) {
          board = await tx.kanban_boards.create({
            data: { name: boardName, projectId, createdAt: new Date() }
          });
          boardsCreated++;
        }

        boardMap.set(boardName, board.id);

        let inProgressCol = await tx.kanban_columns.findFirst({
          where: { board_id: board.id, label: 'Not Started' }
        });

        if (!inProgressCol) {
          const colId = `col-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
          inProgressCol = await tx.kanban_columns.create({
            data: { id: colId, label: 'Not Started', order_index: 1, board_id: board.id }
          });
          columnsCreated++;
        }

        inProgressColumnMap.set(board.id, inProgressCol.id);
      }

      const tasksToCreate: any[] = [];

      for (const task of tasks) {
        console.log('[Import Debug] Processing row:', JSON.stringify(task));
        if (!task.Board || !task['Task Title']) {
          console.log('[Import Debug] SKIPPED - Missing Board or Task Title');
          skippedTasks++;
          continue;
        }

        const boardName = String(task.Board).trim();
        const title = String(task['Task Title']).trim();
        const boardId = boardMap.get(boardName);
        const statusColId = inProgressColumnMap.get(boardId!);

        if (!boardId || !statusColId) {
          skippedTasks++;
          continue;
        }

        const taskId = `task-${Date.now()}-${Math.floor(Math.random() * 1000000)}`;
        const originTaskId = `TID-${Math.floor(10000 + Math.random() * 90000)}`;
        let priority = String(task.Priority || 'Medium').toLowerCase();
        priority = priority.charAt(0).toUpperCase() + priority.slice(1);

        const dueDateRaw = task['Due Date'];
        let dueDateStr: string | null = null;
        let isInvalidDate = false;

        if (dueDateRaw) {
          const rawStr = String(dueDateRaw).trim();

          // 1. Try YYYY-MM-DD first
          const isoMatch = rawStr.match(/\b(\d{4})[/. -](\d{1,2})[/. -](\d{1,2})\b/);
          if (isoMatch) {
            const year = parseInt(isoMatch[1], 10);
            const month = parseInt(isoMatch[2], 10);
            const day = parseInt(isoMatch[3], 10);
            const check = new Date(year, month - 1, day);
            if (check.getFullYear() === year && check.getMonth() === month - 1 && check.getDate() === day) {
              dueDateStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
            }
          }

          // 2. Then try DD-MM-YY(YY) or MM-DD-YY(YY)
          if (!dueDateStr) {
            const ddmmMatch = rawStr.match(/\b(\d{1,2})[/. -](\d{1,2})[/. -](\d{2}|\d{4})\b/);
            if (ddmmMatch) {
              let p1 = parseInt(ddmmMatch[1], 10);
              let p2 = parseInt(ddmmMatch[2], 10);
              let year = parseInt(ddmmMatch[3], 10);
              if (year < 100) year += 2000;

              let check = new Date(year, p2 - 1, p1);
              if (check.getFullYear() === year && check.getMonth() === p2 - 1 && check.getDate() === p1) {
                dueDateStr = `${year}-${String(p2).padStart(2, '0')}-${String(p1).padStart(2, '0')}`;
              }

              if (!dueDateStr) {
                check = new Date(year, p1 - 1, p2);
                if (check.getFullYear() === year && check.getMonth() === p1 - 1 && check.getDate() === p2) {
                  dueDateStr = `${year}-${String(p1).padStart(2, '0')}-${String(p2).padStart(2, '0')}`;
                }
              }
            }
          }

          // 3. Fallback: try native Date parsing for other valid formats
          if (!dueDateStr) {
            const fallback = new Date(rawStr);
            if (!isNaN(fallback.getTime())) {
              dueDateStr = fallback.toISOString().split('T')[0];
            } else {
              isInvalidDate = true;
            }
          }
        }

        if (isInvalidDate) {
          skippedDueToInvalidDate++;
          // Instead of skipping the task completely, we will just count it
          // and let the code below fallback to today's date
        }

        if (!dueDateStr) {
          dueDateStr = new Date().toISOString().split('T')[0];
        }

        const assigneeRaw = task['Assign User'];
        const assigneeStr = (typeof assigneeRaw === 'string' && assigneeRaw.trim()) ? assigneeRaw.trim() : 'Unassigned';

        let storyPoints = 0;
        if (task.Points !== undefined && task.Points !== null) {
          const parsed = parseFloat(String(task.Points));
          if (!isNaN(parsed)) storyPoints = parsed;
        }

        tasksToCreate.push({
          id: taskId,
          title,
          description: task.Description ? String(task.Description) : null,
          priority,
          assignee: assigneeStr,
          status: statusColId,
          dueDate: dueDateStr,
          board_id: boardId,
          storyPoints,
          originTaskId,
        });
      }

      if (tasksToCreate.length > 0) {
        await tx.kanban_tasks.createMany({
          data: tasksToCreate
        });
        tasksImported = tasksToCreate.length;
      }
    }, {
      maxWait: 10000,
      timeout: 60000
    });

    const userId = (req as any).userId;
    if (userId) {
      await prisma.activity_logs.create({
        data: {
          actor_user_id: userId,
          project_id: projectId,
          type: 'backlog_imported',
          description: `Imported ${tasksImported} tasks into ${boardsCreated} sprints`,
        }
      });
    }

    console.log('[Import Debug] SUMMARY:', { boardsCreated, columnsCreated, tasksImported, skippedTasks, skippedDueToInvalidDate, totalRowsReceived: tasks.length });
    res.json({ success: true, summary: { boardsCreated, columnsCreated, tasksImported, skippedTasks, skippedDueToInvalidDate } });
  } catch (error: any) {
    console.error('Import Error:', error);
    res.status(500).json({ error: `Failed to import project backlog: ${String(error?.message || error)}` });
  }
};

export const getProjectSprintAnalytics = async (req: Request, res: Response) => {
  try {
    const projectId = req.params.id as string;

    // Fetch sprints for project (which are now kanban_boards)
    const sprints = await prisma.kanban_boards.findMany({
      where: { projectId },
      include: {
        tasks: {
          include: {
            board: {
              include: { columns: true }
            }
          }
        }
      },
      orderBy: { createdAt: 'asc' }
    });

    // Dynamically update status
    const sprintsWithDynamicStatus = sprints.map(s => ({
      ...s,
      status: calculateSprintStatus(s.startDate, s.endDate)
    }));

    const totalSprints = sprintsWithDynamicStatus.length;
    let activeSprint: any = sprintsWithDynamicStatus.find(s => s.status === 'Active');
    if (!activeSprint && sprintsWithDynamicStatus.length > 0) {
      // Fallback to the most recent sprint
      activeSprint = sprintsWithDynamicStatus[sprintsWithDynamicStatus.length - 1];
    }
    activeSprint = activeSprint || null;

    const allProjectTasks = await prisma.kanban_tasks.findMany({
      where: { board: { projectId } },
      include: { board: { include: { columns: true } } }
    });

    // Helper to determine if a task is "Done"
    const isTaskDone = (task: any) => {
      const statusId = String(task.status).toLowerCase();
      if (statusId === 'done' || statusId === 'completed' || statusId === 'resolved') return true;
      if (task.board && task.board.columns) {
        const col = task.board.columns.find((c: any) => c.id === task.status);
        if (col && (col.label.toLowerCase().includes('done') || col.label.toLowerCase().includes('completed'))) {
          return true;
        }
      }
      return false;
    };

    // Helper to get general status bucket
    const getTaskBucket = (task: any) => {
      if (isTaskDone(task)) return 'done';
      let label = String(task.status).toLowerCase();
      if (task.board && task.board.columns) {
        const col = task.board.columns.find((c: any) => c.id === task.status);
        if (col) label = col.label.toLowerCase();
      }
      if (label.includes('backlog')) return 'backlog';
      if (label.includes('review') || label.includes('qa') || label.includes('test')) return 'review';
      if (label.includes('progress') || label.includes('doing') || label.includes('active')) return 'inProgress';
      return 'todo'; // default
    };

    const totalTasksCount = allProjectTasks.length;
    const completedTasksCount = allProjectTasks.filter(isTaskDone).length;

    const today = new Date().toISOString().split('T')[0];
    const overdueTasksCount = allProjectTasks.filter(t => !isTaskDone(t) && t.dueDate && t.dueDate < today).length;

    const completionRate = totalTasksCount > 0 ? Math.round((completedTasksCount / totalTasksCount) * 100) : 0;

    // Sprint Progress
    const sprintProgress = sprintsWithDynamicStatus.map(s => {
      const sprintTasks = s.tasks || [];
      const tTotal = sprintTasks.length;
      const tDone = sprintTasks.filter(isTaskDone).length;
      return {
        sprintId: s.id,
        sprintName: s.name,
        startDate: s.startDate ? s.startDate.toISOString() : null,
        endDate: s.endDate ? s.endDate.toISOString() : null,
        progressPercent: tTotal > 0 ? Math.round((tDone / tTotal) * 100) : 0
      };
    });

    // Sprint Status Distribution
    const sprintStatusDistribution = sprintsWithDynamicStatus.map(s => {
      const sprintTasks = s.tasks || [];
      const dist = { backlog: 0, todo: 0, inProgress: 0, review: 0, done: 0 };
      sprintTasks.forEach(t => {
        const bucket = getTaskBucket(t);
        dist[bucket as keyof typeof dist]++;
      });
      return {
        sprintName: s.name,
        ...dist
      };
    });

    // Team Contribution & Workload Distribution
    const contributionMap: Record<string, number> = {};
    const workloadMap: Record<string, number> = {};

    allProjectTasks.forEach(t => {
      const assignee = t.assignee && t.assignee.trim() !== '' ? t.assignee : 'Unassigned';
      if (isTaskDone(t)) {
        contributionMap[assignee] = (contributionMap[assignee] || 0) + 1;
      } else {
        workloadMap[assignee] = (workloadMap[assignee] || 0) + 1;
      }
    });

    const teamContribution = Object.keys(contributionMap)
      .map(userName => ({ userName, completedTasks: contributionMap[userName] }))
      .sort((a, b) => b.completedTasks - a.completedTasks);

    const workloadDistribution = Object.keys(workloadMap)
      .map(userName => ({ userName, activeTasks: workloadMap[userName] }))
      .sort((a, b) => b.activeTasks - a.activeTasks);

    // Sprint Velocity (Story points per sprint)
    const sprintVelocity = sprintsWithDynamicStatus.map(s => {
      const sprintTasks = s.tasks || [];
      const completedPoints = sprintTasks
        .filter(isTaskDone)
        .reduce((sum, t) => sum + (t.storyPoints || 0), 0);
      return {
        sprintName: s.name,
        storyPoints: completedPoints
      };
    });

    // Burndown for Active Sprint
    let burndown: any[] = [];
    if (activeSprint) {
      const activeSprintTasks = activeSprint.tasks || [];
      const totalActiveTasks = activeSprintTasks.length;
      const doneActiveTasks = activeSprintTasks.filter(isTaskDone).length;
      burndown = [
        { date: 'Start', remaining: totalActiveTasks, completed: 0 },
        { date: 'Current', remaining: totalActiveTasks - doneActiveTasks, completed: doneActiveTasks }
      ];
    }

    // Health Indicator
    let healthStatus = 'Healthy';
    const overdueRate = totalTasksCount > 0 ? (overdueTasksCount / totalTasksCount) * 100 : 0;
    if (completionRate < 50 || overdueRate > 30) {
      healthStatus = 'Critical';
    } else if (completionRate < 80 || overdueRate > 10) {
      healthStatus = 'At Risk';
    }

    // Recent Activity (activity_logs)
    const rawActivity = await prisma.activity_logs.findMany({
      where: { project_id: projectId, type: { startsWith: 'sprint_' } },
      include: { actor: true },
      orderBy: { created_at: 'desc' },
      take: 10
    });

    const recentActivity = rawActivity.map(a => {
      const isSystemEvent = ['system_job', 'cleanup', 'automated_sync', 'cron'].includes(a.type);
      return {
        actor: a.actor?.name || (isSystemEvent ? 'System' : 'Unknown User'),
        action: a.description,
        timestamp: a.created_at?.toISOString() || new Date().toISOString()
      };
    });

    const projectMembers = await prisma.project_members.findMany({
      where: { project_id: projectId },
      select: { capacity_points: true }
    });
    const totalDailyCapacity = projectMembers.reduce((sum, member) => sum + (Number(member.capacity_points) || 0), 0);

    const sprintsList = sprintsWithDynamicStatus.map(s => {
      const workingDays = calculateWorkingDays(s.startDate, s.endDate);
      const computedCapacity = calculateTeamCapacity(workingDays, totalDailyCapacity);
      const sprintTasks = s.tasks || [];
      const totalPoints = sprintTasks.reduce((sum, t) => sum + (Number(t.storyPoints) || 0), 0);

      return {
        id: String(s.id),
        name: s.name,
        status: s.status,
        startDate: s.startDate ? s.startDate.toISOString() : null,
        endDate: s.endDate ? s.endDate.toISOString() : null,
        estimatedHours: totalPoints,
        capacity: computedCapacity,
        tasksCount: sprintTasks.length
      };
    });

    res.status(200).json({
      overview: {
        totalSprints,
        activeSprintName: activeSprint ? activeSprint.name : null,
        activeSprintStartDate: activeSprint?.startDate ? activeSprint.startDate.toISOString() : null,
        activeSprintEndDate: activeSprint?.endDate ? activeSprint.endDate.toISOString() : null,
        completionRate,
        totalTasks: totalTasksCount,
        completedTasks: completedTasksCount,
        overdueTasks: overdueTasksCount
      },
      sprintProgress,
      sprintStatusDistribution,
      teamContribution,
      workloadDistribution,
      sprintVelocity,
      burndown,
      health: {
        status: healthStatus,
        completionRate,
        overdueRate
      },
      recentActivity,
      sprintsList
    });

  } catch (error) {
    console.error('Error fetching sprint analytics:', error);
    res.status(500).json({ error: 'Failed to fetch sprint analytics' });
  }
};

export const getGlobalAnalytics = async (req: Request, res: Response) => {
  try {
    const userId = Number((req as any).userId);
    const userRole = ((req as any).userRole || '').toLowerCase();

    let projectIds: string[] = [];

    if (userRole !== 'super admin') {
      const userProjects = await prisma.project_members.findMany({
        where: { user_id: userId },
        select: { project_id: true }
      });
      projectIds = userProjects.map(p => p.project_id);

      if (projectIds.length === 0) {
        return res.status(200).json({
          totalProjects: 0,
          totalTasks: 0,
          activeTasks: 0,
          completedTasks: 0,
          openBugs: 0,
          teamMembers: 0
        });
      }
    }

    const whereClause = isGlobalAdmin(userRole) ? {} : { id: { in: projectIds } };
    const totalProjects = await prisma.projects.count({ where: whereClause });

    const taskWhere = isGlobalAdmin(userRole) ? {} : { board: { projectId: { in: projectIds } } };
    const bugWhere = isGlobalAdmin(userRole) ? {} : { project_id: { in: projectIds } };

    const totalTasks = await prisma.kanban_tasks.count({ where: taskWhere });
    const openBugs = await prisma.bugs.count({
      where: { ...bugWhere, status: { in: ['open', 'new', 'in_progress'] } }
    });

    const columns = await prisma.kanban_columns.findMany({
      where: isGlobalAdmin(userRole) ? {} : { board: { projectId: { in: projectIds } } },
      select: { id: true, label: true }
    });

    const activeColumnIds = columns
      .filter(c => !c.label.toLowerCase().includes('done') && !c.label.toLowerCase().includes('complete') && !c.label.toLowerCase().includes('resolved'))
      .map(c => c.id);

    const completedColumnIds = columns
      .filter(c => c.label.toLowerCase().includes('done') || c.label.toLowerCase().includes('complete') || c.label.toLowerCase().includes('resolved'))
      .map(c => c.id);

    const activeTasks = await prisma.kanban_tasks.count({
      where: { ...taskWhere, status: { in: activeColumnIds } }
    });

    const completedTasks = await prisma.kanban_tasks.count({
      where: { ...taskWhere, status: { in: completedColumnIds } }
    });

    const teamMembersDist = await prisma.project_members.findMany({
      where: isGlobalAdmin(userRole) ? {} : { project_id: { in: projectIds } },
      select: { user_id: true },
      distinct: ['user_id']
    });
    const teamMembers = teamMembersDist.length;

    res.status(200).json({
      totalProjects,
      totalTasks,
      activeTasks,
      completedTasks,
      openBugs,
      teamMembers
    });
  } catch (error) {
    console.error('Error fetching global analytics:', error);
    res.status(500).json({ error: 'Failed to fetch global analytics' });
  }
};

export const getProjectAnalytics = async (req: Request, res: Response) => {
  try {
    const projectId = req.params.id as string;

    // Find active and completed columns
    const columns = await prisma.kanban_columns.findMany({
      where: { board: { projectId: projectId } },
      select: { id: true, label: true }
    });

    const activeColumnIds = columns
      .filter(c => !c.label.toLowerCase().includes('done') && !c.label.toLowerCase().includes('complete') && !c.label.toLowerCase().includes('resolved'))
      .map(c => c.id);

    const completedColumnIds = columns
      .filter(c => c.label.toLowerCase().includes('done') || c.label.toLowerCase().includes('complete') || c.label.toLowerCase().includes('resolved'))
      .map(c => c.id);

    const [totalTasks, activeTasks, completedTasks, openBugs, teamMembers] = await Promise.all([
      prisma.kanban_tasks.count({
        where: { board: { projectId } }
      }),
      prisma.kanban_tasks.count({
        where: {
          board: { projectId },
          status: { in: activeColumnIds }
        }
      }),
      prisma.kanban_tasks.count({
        where: {
          board: { projectId },
          status: { in: completedColumnIds }
        }
      }),
      prisma.bugs.count({
        where: {
          project_id: projectId,
          status: { in: ['open', 'new', 'in progress', 'in_progress'] }
        }
      }),
      prisma.project_members.count({
        where: { project_id: projectId }
      })
    ]);

    res.status(200).json({
      totalTasks: totalTasks || 0,
      activeTasks: activeTasks || 0,
      completedTasks: completedTasks || 0,
      openBugs: openBugs || 0,
      teamMembers: teamMembers || 0
    });
  } catch (error) {
    console.error('Error fetching project analytics:', error);
    res.status(500).json({ error: 'Failed to fetch project analytics' });
  }
};
