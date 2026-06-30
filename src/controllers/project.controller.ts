import { Request, Response } from 'express';
import prisma from '../config/db.js';
import { activityService } from '../services/activity.service.js';
import { calculateSprintStatus, calculateWorkingDays, calculateTeamCapacity } from './kanban.controller.js';
import { isGlobalAdmin, isDeveloperRole } from '../utils/roles.js';

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
    owner: project.owner ? { id: project.owner.id, name: project.owner.name } : null,
    category: project.category ?? null
  };
}

/**
 * Resolve a submitted category to its canonical stored name. Empty/null → null
 * (uncategorized is allowed). A non-empty value MUST match an existing
 * project_categories row (case-insensitive) so projects can only reference
 * DB-managed categories — no arbitrary free-text values.
 */
async function resolveCategoryName(raw: any): Promise<{ name: string | null } | { error: string }> {
  if (raw === undefined || raw === null || String(raw).trim() === '') return { name: null };
  const wanted = String(raw).trim();
  const match = await prisma.project_categories.findFirst({
    where: { name: { equals: wanted, mode: 'insensitive' } },
  });
  if (!match) return { error: `Invalid project category "${wanted}".` };
  return { name: match.name };
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

// ── Backlog import date parsing ─────────────────────────────────────────────
// Parses a backlog cell into a canonical 'YYYY-MM-DD' string (ISO, DD-MM-YYYY,
// MM-DD-YYYY, or anything Date can parse). Returns null when there's no valid
// date — callers must NOT fabricate sprint dates from a null.
function parseBacklogDate(raw: any): string | null {
  if (raw === undefined || raw === null) return null;
  const rawStr = String(raw).trim();
  if (!rawStr) return null;

  // 1. ISO-ish YYYY-MM-DD
  const isoMatch = rawStr.match(/\b(\d{4})[/. -](\d{1,2})[/. -](\d{1,2})\b/);
  if (isoMatch) {
    const y = parseInt(isoMatch[1], 10), m = parseInt(isoMatch[2], 10), d = parseInt(isoMatch[3], 10);
    const c = new Date(y, m - 1, d);
    if (c.getFullYear() === y && c.getMonth() === m - 1 && c.getDate() === d) {
      return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    }
  }
  // 2. DD-MM-YY(YY) then MM-DD-YY(YY)
  const dm = rawStr.match(/\b(\d{1,2})[/. -](\d{1,2})[/. -](\d{2}|\d{4})\b/);
  if (dm) {
    const p1 = parseInt(dm[1], 10), p2 = parseInt(dm[2], 10);
    let y = parseInt(dm[3], 10);
    if (y < 100) y += 2000;
    let c = new Date(y, p2 - 1, p1);
    if (c.getFullYear() === y && c.getMonth() === p2 - 1 && c.getDate() === p1) {
      return `${y}-${String(p2).padStart(2, '0')}-${String(p1).padStart(2, '0')}`;
    }
    c = new Date(y, p1 - 1, p2);
    if (c.getFullYear() === y && c.getMonth() === p1 - 1 && c.getDate() === p2) {
      return `${y}-${String(p1).padStart(2, '0')}-${String(p2).padStart(2, '0')}`;
    }
  }
  // 3. Native fallback
  const fb = new Date(rawStr);
  if (!isNaN(fb.getTime())) return fb.toISOString().split('T')[0];
  return null;
}

/** 'YYYY-MM-DD' → UTC-midnight Date (stable across server timezones); null-safe. */
const toUTCDate = (ymd: string | null): Date | null => (ymd ? new Date(`${ymd}T00:00:00.000Z`) : null);
const minDate = (a: Date | null, b: Date | null): Date | null => (!a ? b : !b ? a : (a.getTime() <= b.getTime() ? a : b));
const maxDate = (a: Date | null, b: Date | null): Date | null => (!a ? b : !b ? a : (a.getTime() >= b.getTime() ? a : b));

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

    const { name, description, status, startDate, members, owner_id, memberDetails, category } = req.body as any;
    if (!name) return res.status(400).json({ success: false, message: 'Project Name is required' });

    const catRes = await resolveCategoryName(category);
    if ('error' in catRes) return res.status(400).json({ success: false, message: catRes.error });

    let finalMembers: any[] = [];
    if (Array.isArray(memberDetails) && memberDetails.length > 0) {
      finalMembers = memberDetails;
    } else if (Array.isArray(members)) {
      // Fallback for legacy format
      const numericMemberIds = members.map(m => Number(m)).filter(m => !isNaN(m));
      finalMembers = numericMemberIds.map(id => ({ userId: id, role: 'editor', capacityPoints: 0 }));
    }

    // The creator always administers their own project. Previously we only added
    // them as admin when ABSENT from the member list — so a creator who added
    // themselves in the modal (default role 'viewer') was stored as a viewer,
    // which then hid the Import Backlog button and 403'd the import endpoint.
    // Force the creator's project role to admin whether or not they self-added.
    const userId = (req as any).userId;
    if (userId) {
      const selfIdx = finalMembers.findIndex(m => Number(m.userId) === Number(userId));
      if (selfIdx >= 0) {
        finalMembers[selfIdx] = { ...finalMembers[selfIdx], role: 'admin' };
      } else {
        finalMembers.push({ userId, role: 'admin', capacityPoints: 0 });
      }
    }

    if (finalMembers.length === 0) finalMembers.push({ userId: 1, role: 'admin', capacityPoints: 0 });

    const newProject = await prisma.projects.create({
      data: {
        id: `prj-${Date.now()}`,
        name,
        description: description || '',
        status: status || 'active',
        category: catRes.name,
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
    const { name, description, status, startDate, endDate, members, owner_id, memberDetails, category } = req.body as any;

    if (!name) return res.status(400).json({ success: false, message: 'Project Name is required' });
    if (!startDate) return res.status(400).json({ success: false, message: 'Start Date is required' });
    if (endDate && startDate && new Date(endDate) < new Date(startDate)) {
      return res.status(400).json({ success: false, message: 'End date must be on or after start date' });
    }

    const existingProject = await prisma.projects.findUnique({ where: { id } });
    if (!existingProject) return res.status(404).json({ success: false, message: 'Project not found' });

    // Validate category only when provided; undefined leaves it unchanged.
    let categoryToStore: string | null | undefined;
    if (category !== undefined) {
      const catRes = await resolveCategoryName(category);
      if ('error' in catRes) return res.status(400).json({ success: false, message: catRes.error });
      categoryToStore = catRes.name;
    }

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
      // Preserve the existing category when the client omits it.
      category: categoryToStore !== undefined ? categoryToStore : existingProject.category,
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
      // Existing sprint dates (so a re-import extends rather than narrows the
      // timeline) + per-board aggregation of the imported task dates.
      const boardExisting = new Map<number, { start: Date | null; end: Date | null }>();
      const boardDateAgg = new Map<number, { minStart: Date | null; maxStart: Date | null; minDue: Date | null; maxDue: Date | null }>();

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
        boardExisting.set(board.id, { start: board.startDate ?? null, end: board.endDate ?? null });

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

        // Parse both date columns: 'Date' → sprint start, 'Due Date' → sprint end.
        const parsedStart = parseBacklogDate(task['Date']);
        const parsedDue = parseBacklogDate(task['Due Date']);
        if (task['Due Date'] && !parsedDue) {
          // Present but unparseable — count it; the task still imports (lenient),
          // but this bad value never contributes to the sprint timeline.
          skippedDueToInvalidDate++;
        }

        // The task keeps a non-null dueDate (falls back to today when missing /
        // unparseable). Sprint dates below use ONLY the validly-parsed values.
        const dueDateStr = parsedDue || new Date().toISOString().split('T')[0];

        // Aggregate the valid imported dates for this board's sprint timeline.
        const agg = boardDateAgg.get(boardId) || { minStart: null, maxStart: null, minDue: null, maxDue: null };
        const startD = toUTCDate(parsedStart);
        const dueD = toUTCDate(parsedDue);
        if (startD) { agg.minStart = minDate(agg.minStart, startD); agg.maxStart = maxDate(agg.maxStart, startD); }
        if (dueD) { agg.minDue = minDate(agg.minDue, dueD); agg.maxDue = maxDate(agg.maxDue, dueD); }
        boardDateAgg.set(boardId, agg);

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

      // Derive each affected sprint's timeline from the imported backlog:
      //   startDate = MIN(Date)   (falls back to earliest Due Date)
      //   endDate   = MAX(Due Date) (falls back to latest Date)
      // Merged with any existing dates so a re-import extends the range and
      // recalculates automatically. Boards with no valid dates stay null.
      for (const [boardId, agg] of boardDateAgg) {
        const newStart = agg.minStart ?? agg.minDue;
        const newEnd = agg.maxDue ?? agg.maxStart;
        if (!newStart && !newEnd) continue;
        const prev = boardExisting.get(boardId) || { start: null, end: null };
        const finalStart = minDate(prev.start, newStart);
        const finalEnd = maxDate(prev.end, newEnd);
        await tx.kanban_boards.update({
          where: { id: boardId },
          data: { startDate: finalStart, endDate: finalEnd },
        });
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

    // Sprint status is a STORED, manually-set value (changed via the inline
    // dropdown, gated by the sprints.status.manage permission). Fall back to the
    // date-derived status only when a sprint has no stored value.
    const sprintsWithDynamicStatus = sprints.map(s => ({
      ...s,
      status: s.status || calculateSprintStatus(s.startDate, s.endDate)
    }));

    const totalSprints = sprintsWithDynamicStatus.length;
    // "Active sprint" (for burndown + the overview headline) is the sprint that is
    // CURRENTLY RUNNING — a date-derived concept, independent of the manual workflow
    // status. Prefer a sprint explicitly marked 'Active'; otherwise fall back to the
    // one whose date range covers today, then to the most recent sprint.
    const nowTs = Date.now();
    let activeSprint: any =
      sprintsWithDynamicStatus.find(s => s.status === 'Active') ||
      sprintsWithDynamicStatus.find(s =>
        s.startDate && new Date(s.startDate).getTime() <= nowTs &&
        (!s.endDate || new Date(s.endDate).getTime() >= nowTs),
      );
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
        if (col && (col.label.toLowerCase().includes('done') || col.label.toLowerCase().includes('completed') || col.label.toLowerCase().includes('resolved'))) {
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
      select: {
        capacity_points: true,
        user: { select: { id: true, name: true, role: true, status: true } },
      },
    });
    const totalDailyCapacity = projectMembers.reduce((sum, member) => sum + (Number(member.capacity_points) || 0), 0);

    // Developer Point Distribution — built from who is actually ASSIGNED the work
    // (kanban_tasks.assignee), because tasks are assigned by NAME and may not map
    // 1:1 to project_members. Each distinct assignee is a developer with their
    // assigned / completed / remaining points. People with no assigned work simply
    // don't appear, so only the developers carrying points are shown.
    //
    // We enrich each assignee with their project-member role/id when the name
    // matches a member; assignees that map to an INACTIVE member are dropped.
    const memberByName = new Map<string, { id: number; role: string; active: boolean }>();
    for (const m of projectMembers) {
      if (!m.user) continue;
      const k = (m.user.name || '').trim().toLowerCase();
      if (k && !memberByName.has(k)) {
        memberByName.set(k, {
          id: m.user.id,
          role: (m.user.role || 'Developer').split(',')[0].trim() || 'Developer',
          active: String(m.user.status || 'active').toLowerCase() !== 'inactive',
        });
      }
    }
    // Stable non-colliding id for assignees that aren't matched to a member.
    const hashName = (s: string) => {
      let h = 0;
      for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
      return -(Math.abs(h) || 1);
    };

    const distByAssignee = new Map<string, { name: string; assigned: number; completed: number; tasksCount: number }>();
    for (const t of allProjectTasks) {
      const display = (t.assignee || '').trim();
      if (!display) continue; // skip unassigned tasks
      const key = display.toLowerCase();
      const e = distByAssignee.get(key) || { name: display, assigned: 0, completed: 0, tasksCount: 0 };
      const pts = Number(t.storyPoints) || 0;
      e.assigned += pts;
      if (isTaskDone(t)) e.completed += pts;
      e.tasksCount += 1;
      distByAssignee.set(key, e);
    }

    const developerDistribution = [...distByAssignee.entries()]
      .filter(([key]) => {
        const member = memberByName.get(key);
        return !member || member.active; // drop assignees mapping to an inactive member
      })
      .map(([key, e]) => {
        const member = memberByName.get(key);
        const assignedR = Math.round(e.assigned);
        const completedR = Math.round(e.completed);
        return {
          id: member ? member.id : hashName(key),
          name: e.name,
          role: member ? member.role : 'Developer',
          tasksCount: e.tasksCount,
          assignedPoints: assignedR,
          completedPoints: completedR,
          remainingPoints: assignedR - completedR,
          // Derived from the SAME rounded values shown in the table so the %
          // always agrees with Completed/Assigned.
          completionRate: assignedR > 0 ? Math.round((completedR / assignedR) * 1000) / 10 : 0,
        };
      })
      .sort((a, b) => b.assignedPoints - a.assignedPoints);

    const sprintsList = sprintsWithDynamicStatus.map(s => {
      const workingDays = calculateWorkingDays(s.startDate, s.endDate);
      const computedCapacity = calculateTeamCapacity(workingDays, totalDailyCapacity);
      const sprintTasks = s.tasks || [];
      const totalPoints = sprintTasks.reduce((sum, t) => sum + (Number(t.storyPoints) || 0), 0);
      const doneCount = sprintTasks.filter(isTaskDone).length;

      return {
        id: String(s.id),
        name: s.name,
        status: s.status,
        startDate: s.startDate ? s.startDate.toISOString() : null,
        endDate: s.endDate ? s.endDate.toISOString() : null,
        estimatedHours: totalPoints,
        capacity: computedCapacity,
        tasksCount: sprintTasks.length,
        progress: sprintTasks.length > 0 ? Math.round((doneCount / sprintTasks.length) * 100) : 0
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
      sprintsList,
      developerDistribution
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

    // Global admins (Founder / Super Admin, any spelling) see org-wide analytics.
    // Use the normalized isGlobalAdmin (as lines below do) — a strict
    // `!== 'super admin'` here previously treated a Founder with role 'admin' /
    // 'Admin' / 'SuperAdmin' as a normal user, scoping the dashboard to their
    // (non-existent) project memberships and returning all-zero stats.
    if (!isGlobalAdmin(userRole)) {
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
          teamMembers: 0,
          projectsByCategory: []
        });
      }
    }

    const whereClause = isGlobalAdmin(userRole) ? {} : { id: { in: projectIds } };
    const totalProjects = await prisma.projects.count({ where: whereClause });

    // Projects-by-category distribution (live; JS grouping — Prisma groupBy OOMs the compiler here).
    const categoryRows = await prisma.projects.findMany({ where: whereClause, select: { category: true } });
    const catMap = new Map<string, number>();
    for (const r of categoryRows) {
      const label = r.category && r.category.trim() ? r.category.trim() : 'Uncategorized';
      catMap.set(label, (catMap.get(label) || 0) + 1);
    }
    const projectsByCategory = [...catMap.entries()]
      .map(([label, value]) => ({ label, value }))
      .sort((a, b) => b.value - a.value);

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
      teamMembers,
      projectsByCategory
    });
  } catch (error) {
    console.error('Error fetching global analytics:', error);
    res.status(500).json({ error: 'Failed to fetch global analytics' });
  }
};

/**
 * GET /projects/global/developer-performance — org-wide (project-scoped for
 * non-admins) developer productivity dashboard. Everything is LIVE-derived:
 *   • points / tasks  ← kanban_tasks (storyPoints, assignee NAME, status column, dueDate)
 *   • quality         ← bugs (assignedTo / status)
 *   • activity/today/weekly ← activity_logs (actor + task_id + created_at)
 * Tasks/bugs reference people by NAME, so we match on the user's name.
 *
 * NOTE: kanban_tasks has no completion timestamp — "today" + the weekly trend
 * are reconstructed from activity_logs (task created/updated/moved events).
 */
export const getDeveloperPerformance = async (req: Request, res: Response) => {
  try {
    const userId = Number((req as any).userId);
    const userRole = ((req as any).userRole || '').toLowerCase();
    const admin = isGlobalAdmin(userRole);

    // Scope: global admins see everything; everyone else sees their projects.
    let projectIds: string[] | null = null;
    if (!admin) {
      const mem = await prisma.project_members.findMany({ where: { user_id: userId }, select: { project_id: true } });
      projectIds = [...new Set(mem.map((m) => m.project_id))];
      if (projectIds.length === 0) projectIds = ['__none__'];
    }
    const scopedBoard = projectIds ? { board: { projectId: { in: projectIds } } } : {};
    const scopedProject = projectIds ? { project_id: { in: projectIds } } : {};

    // ── Optional date window. When startDate & endDate are supplied, all period
    // metrics (assigned/completed/velocity/leaderboard/status/timeline/bugs) are
    // derived from ACTIVITY within [winStart, winEnd] — the only timestamped
    // signal available (kanban_tasks has no completion timestamp). With no params
    // the endpoint keeps its all-time snapshot behaviour (unchanged / no regression).
    const parseDay = (s: any, endOfDay: boolean): Date | null => {
      if (!s || typeof s !== 'string') return null;
      const m = s.trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
      if (!m) return null;
      const y = +m[1], mo = +m[2], da = +m[3];
      if (mo < 1 || mo > 12 || da < 1 || da > 31) return null;
      const d = new Date(Date.UTC(y, mo - 1, da,
        endOfDay ? 23 : 0, endOfDay ? 59 : 0, endOfDay ? 59 : 0, endOfDay ? 999 : 0));
      // Reject rollover dates (e.g. 2026-02-30 → Mar 2): components must round-trip.
      if (d.getUTCFullYear() !== y || d.getUTCMonth() !== mo - 1 || d.getUTCDate() !== da) return null;
      return d;
    };
    const winStart = parseDay(req.query.startDate, false);
    const winEnd = parseDay(req.query.endDate, true);
    const ranged = !!(winStart && winEnd && winStart <= winEnd);

    // ── Developers = distinct project members whose ROLE is a developer variant.
    // Role filtering is applied at the query level (DB), not in the frontend, so
    // Sales / Admin / HR / Finance / Viewer / BDE users never enter the dataset.
    const members = await prisma.project_members.findMany({
      where: {
        ...(projectIds ? { project_id: { in: projectIds } } : {}),
        user: {
          OR: [
            { role: { contains: 'developer', mode: 'insensitive' } },
            { role: { equals: 'dev', mode: 'insensitive' } },
          ],
        },
      },
      select: {
        project_id: true, capacity_points: true,
        user: { select: { id: true, name: true, role: true, status: true } },
      },
    });
    interface Dev {
      id: number; name: string; role: string; status: string;
      projects: Set<string>; capacity: number;
      assigned: number; completed: number; pending: number; bugs: number;
      today: number; lastActivity: Date | null;
    }
    const devById = new Map<number, Dev>();
    const devByName = new Map<string, Dev>();
    const ambiguousNames = new Set<string>(); // names shared by >1 distinct user — skip name-based attribution
    // Resolve an assignee/assignedTo name string to a single developer; returns
    // undefined when the name is blank or ambiguous (so work isn't misattributed).
    const devForName = (name: string) => {
      const k = (name || '').trim().toLowerCase();
      return k && !ambiguousNames.has(k) ? devByName.get(k) : undefined;
    };
    for (const m of members) {
      // Defence-in-depth: the query already narrows to developer roles, but
      // re-check in code so the canonical isDeveloperRole() definition wins.
      if (!m.user || !isDeveloperRole(m.user.role)) continue;
      let d = devById.get(m.user.id);
      if (!d) {
        d = {
          id: m.user.id, name: m.user.name, role: m.user.role || 'Member', status: m.user.status || 'active',
          projects: new Set(), capacity: 0, assigned: 0, completed: 0, pending: 0, bugs: 0, today: 0, lastActivity: null,
        };
        devById.set(d.id, d);
        const nameKey = d.name.trim().toLowerCase();
        const existing = devByName.get(nameKey);
        // Collision: two distinct users share a name — mark ambiguous so neither
        // silently absorbs the other's name-based task/bug credit (last-write-wins).
        if (existing && existing.id !== d.id) ambiguousNames.add(nameKey);
        else devByName.set(nameKey, d);
      }
      if (m.project_id) d.projects.add(m.project_id);
      d.capacity += Number(m.capacity_points || 0);
    }

    // ── Columns → status bucket + done detection.
    const columns = await prisma.kanban_columns.findMany({
      where: projectIds ? { board: { projectId: { in: projectIds } } } : {},
      select: { id: true, label: true },
    });
    const bucketByCol = new Map<string, 'todo' | 'inProgress' | 'review' | 'qa' | 'done'>();
    const doneCols = new Set<string>();
    for (const c of columns) {
      const l = (c.label || '').toLowerCase();
      let b: 'todo' | 'inProgress' | 'review' | 'qa' | 'done';
      if (/done|complete|resolved|closed/.test(l)) { b = 'done'; doneCols.add(c.id); }
      else if (/qa|test/.test(l)) b = 'qa';
      else if (/review/.test(l)) b = 'review';
      else if (/progress|doing|active/.test(l)) b = 'inProgress';
      else b = 'todo';
      bucketByCol.set(c.id, b);
    }

    // ── Tasks → points, status distribution, due-date timeline, per-dev rollup.
    const tasks = await prisma.kanban_tasks.findMany({
      where: scopedBoard,
      select: { id: true, assignee: true, status: true, storyPoints: true, dueDate: true },
    });
    const taskById = new Map<string, { points: number; done: boolean; assignee: string; isDev: boolean; col: string; dueDate: string | null }>();
    const statusCounts = { todo: 0, inProgress: 0, review: 0, qa: 0, done: 0 };
    const today = new Date();
    const todayUTC = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
    let totalAssigned = 0, totalCompleted = 0, tasksDelayed = 0, tasksOnTime = 0, delaySum = 0;
    for (const t of tasks) {
      const pts = Number(t.storyPoints || 0);
      const done = doneCols.has(t.status);
      const d = devForName(t.assignee || '');
      taskById.set(t.id, { points: pts, done, assignee: (t.assignee || '').trim().toLowerCase(), isDev: !!d, col: t.status, dueDate: t.dueDate || null });
      // Developer-only analytics: tasks not assigned to a developer-role user are
      // excluded from every aggregate (points, status distribution, timeline).
      if (!d) continue;
      if (!done) d.pending += 1; // current open count (snapshot — both modes)
      // Range mode derives points / status / timeline from DATED activity below;
      // the kanban snapshot (no timestamps) only feeds the all-time default view.
      if (ranged) continue;
      d.assigned += pts; if (done) d.completed += pts;
      statusCounts[bucketByCol.get(t.status) || 'todo']++;
      totalAssigned += pts;
      if (done) totalCompleted += pts;
      // Timeline (due-date based) — only meaningful for dated tasks.
      if (t.dueDate && /^\d{4}-\d{2}-\d{2}/.test(t.dueDate)) {
        const [y, mo, da] = t.dueDate.slice(0, 10).split('-').map(Number);
        const dueUTC = Date.UTC(y, mo - 1, da);
        if (!done && dueUTC < todayUTC) {
          // Open and past due → delayed.
          tasksDelayed++;
          delaySum += Math.round((todayUTC - dueUTC) / 86400000);
        } else if (done) {
          // Delivered → on time (best signal available; no completedAt to detect done-late).
          tasksOnTime++;
        }
        // else: open and not yet due → not judged, excluded from SLA so future-dated
        // work does not inflate the on-time count.
      }
    }

    // ── Bugs (quality) — attributed to the dev via assignedTo name.
    const bugs = await prisma.bugs.findMany({
      where: { ...scopedProject, ...(ranged ? { createdAt: { gte: winStart!, lte: winEnd! } } : {}) },
      select: { assignedTo: true, status: true },
    });
    const fixedStatuses = ['resolved', 'closed', 'fixed', 'done', 'verified'];
    let bugsRaised = 0, bugsFixed = 0, bugsReopened = 0;
    for (const b of bugs) {
      // Developer-only quality: count only bugs assigned to a developer-role user.
      const d = devForName(b.assignedTo || '');
      if (!d) continue;
      bugsRaised++;
      const s = (b.status || '').toLowerCase();
      if (fixedStatuses.includes(s)) bugsFixed++;
      if (s.includes('reopen')) bugsReopened++;
      if (!fixedStatuses.includes(s)) d.bugs += 1;
    }

    // ── Activity logs → last activity, today, weekly trend, and (range mode) the
    // period's assigned/completed/status/timeline. Window = the selected range,
    // else the trailing 6 ISO weeks that feed the default velocity trend.
    const dayMs = 86400000;
    const since = ranged ? winStart! : new Date(todayUTC - 42 * dayMs);
    const logs = await prisma.activity_logs.findMany({
      where: {
        created_at: { gte: since, ...(ranged ? { lte: winEnd! } : {}) },
        ...(projectIds ? { project_id: { in: projectIds } } : {}),
      },
      select: { actor_user_id: true, created_at: true, type: true, task_id: true },
    });
    const startOfTodayUTC = todayUTC;
    const activeToday = new Set<number>();
    const todayCredited = new Set<string>(); // dedupe per-task today points
    const seenDoneWeekly = new Set<string>(); // dedupe trend completion across ALL buckets

    // Velocity-trend buckets. Default: 5 trailing weeks. Range: up to 12 equal
    // buckets spanning [winStart, winEnd] so the chart fits any selected period.
    let weeks: { start: number; end: number; assigned: number; completed: number; label: string }[];
    if (ranged) {
      const startUTC = Date.UTC(winStart!.getUTCFullYear(), winStart!.getUTCMonth(), winStart!.getUTCDate());
      const endUTC = Date.UTC(winEnd!.getUTCFullYear(), winEnd!.getUTCMonth(), winEnd!.getUTCDate());
      const totalDays = Math.max(1, Math.round((endUTC - startUTC) / dayMs) + 1);
      const count = Math.min(12, Math.max(1, Math.ceil(totalDays / 7)));
      const span = Math.ceil(totalDays / count);
      weeks = Array.from({ length: count }, (_, i) => {
        const bStart = startUTC + i * span * dayMs;
        const bEnd = Math.min(endUTC, bStart + (span - 1) * dayMs);
        return {
          start: bStart, end: bEnd, assigned: 0, completed: 0,
          label: new Date(bStart).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', timeZone: 'UTC' }),
        };
      });
    } else {
      weeks = [4, 3, 2, 1, 0].map((back, i) => {
        const end = todayUTC - back * 7 * dayMs;
        return { start: end - 6 * dayMs, end, assigned: 0, completed: 0, label: `Wk ${i + 1}` };
      });
    }

    // Range-mode period accumulators (dedupe per task).
    const rAssignedSeen = new Set<string>();
    const rCompletedSeen = new Set<string>();
    const rTaskSeen = new Set<string>();

    for (const log of logs) {
      if (!log.created_at) continue;
      const ts = log.created_at.getTime();
      const dayUTC = Date.UTC(log.created_at.getUTCFullYear(), log.created_at.getUTCMonth(), log.created_at.getUTCDate());
      if (log.actor_user_id) {
        const d = devById.get(log.actor_user_id);
        // Only count known developers (project members), so the "Active Today"
        // denominator matches the per-developer points numerator. Org-wide logs
        // (sales/leads/deals actors) would otherwise inflate it for admins.
        if (d) {
          if (!d.lastActivity || log.created_at > d.lastActivity) d.lastActivity = log.created_at;
          if (dayUTC >= startOfTodayUTC) activeToday.add(log.actor_user_id);
        }
      }
      const type = log.type || '';
      const t = log.task_id ? taskById.get(log.task_id) : undefined;
      // Today's completed points: a done DEVELOPER task touched today, credited once.
      if (dayUTC >= startOfTodayUTC && t && t.isDev && t.done && !todayCredited.has(log.task_id!)) {
        todayCredited.add(log.task_id!);
        const d = devForName(t.assignee);
        if (d) d.today += t.points;
      }

      // Range mode: the SET of tasks/points is derived from dated events (assigned
      // ← task_created; completed ← updated/moved on a now-done task). Status &
      // due-date come from the task's current snapshot (activity_logs has no
      // historical status), so the donut reads "tasks worked on this period, by
      // their CURRENT status" — the best signal without status-transition history.
      if (ranged && t && t.isDev && log.task_id) {
        const d = devForName(t.assignee);
        if (d) {
          if (type === 'task_created' && !rAssignedSeen.has(log.task_id)) {
            rAssignedSeen.add(log.task_id);
            d.assigned += t.points; totalAssigned += t.points;
          }
          if (t.done && (type.includes('task_updated') || type.includes('task_moved')) && !rCompletedSeen.has(log.task_id)) {
            rCompletedSeen.add(log.task_id);
            d.completed += t.points; totalCompleted += t.points;
          }
          if (!rTaskSeen.has(log.task_id)) {
            rTaskSeen.add(log.task_id);
            statusCounts[bucketByCol.get(t.col) || 'todo']++;
            if (t.dueDate && /^\d{4}-\d{2}-\d{2}/.test(t.dueDate)) {
              const [y, mo, da] = t.dueDate.slice(0, 10).split('-').map(Number);
              const dueUTC = Date.UTC(y, mo - 1, da);
              if (!t.done && dueUTC < todayUTC) { tasksDelayed++; delaySum += Math.round((todayUTC - dueUTC) / dayMs); }
              else if (t.done) tasksOnTime++;
            }
          }
        }
      }

      // Velocity trend (assigned ← created, completed ← updated/moved on a done
      // task), restricted to developer-assigned tasks so the chart is dev-only.
      for (const w of weeks) {
        if (ts >= w.start && ts < w.end + dayMs) {
          if (t && t.isDev && type === 'task_created') w.assigned += t.points;
          if (t && t.isDev && t.done && (type.includes('task_updated') || type.includes('task_moved')) && !seenDoneWeekly.has(log.task_id!)) {
            seenDoneWeekly.add(log.task_id!);
            w.completed += t.points;
          }
          break;
        }
      }
    }

    // ── Assemble per-developer rows.
    const devs = [...devById.values()];
    const developers = devs.map((d) => {
      const completionRate = d.assigned > 0 ? Math.round((d.completed / d.assigned) * 100) : 0;
      // Utilization = current OPEN workload as a share of the developer's assigned
      // story points (open ÷ assigned), where open = assigned − completed.
      // Unit-safe (points ÷ points) and identical in meaning for every developer.
      // Replaces the old assigned ÷ capacity_points formula, which divided a
      // cumulative point TOTAL by a PER-DAY capacity rate (pts/day) and so pegged
      // almost everyone at 100%; the old no-capacity fallback (load relative to the
      // busiest dev) was also relative, not real, load.
      //   0%  = all assigned work delivered → free capacity / available
      //   100% = nothing delivered yet → fully loaded / busy
      const openPoints = Math.max(0, d.assigned - d.completed);
      const utilization = d.assigned > 0 ? Math.round((openPoints / d.assigned) * 100) : 0;
      return {
        id: d.id, name: d.name, role: d.role, status: d.status,
        online: d.status === 'active',
        activeProjects: d.projects.size,
        assignedPoints: Math.round(d.assigned),
        completedPoints: Math.round(d.completed),
        todayPoints: Math.round(d.today),
        completionRate,
        tasksPending: d.pending,
        bugs: d.bugs,
        lastActivity: d.lastActivity ? d.lastActivity.toISOString() : null,
        utilization,
        // Busy if behind schedule (low completion), otherwise Active.
        devStatus: completionRate < 65 && d.assigned > 0 ? 'Busy' : 'Active',
      };
    }).sort((a, b) => b.completedPoints - a.completedPoints);

    const totalDevelopers = developers.length;
    const activeDevelopers = developers.filter((d) => d.status === 'active').length;
    const availableDevelopers = developers.filter((d) => d.utilization < 70).length;
    const teamUtilization = totalDevelopers > 0
      ? Math.round(developers.reduce((s, d) => s + d.utilization, 0) / totalDevelopers) : 0;

    const completionRate = totalAssigned > 0 ? Math.round((totalCompleted / totalAssigned) * 1000) / 10 : 0;
    const weeksActive = Math.max(1, weeks.filter((w) => w.assigned > 0 || w.completed > 0).length);
    // Velocity = recent (activity-derived) completed points per active week, so the
    // headline reconciles with the Weekly Velocity Trend chart instead of dividing an
    // all-time numerator (totalCompleted) by a recent-weeks denominator.
    const recentCompleted = weeks.reduce((s, w) => s + w.completed, 0);
    const velocityPerWeek = Math.round(recentCompleted / weeksActive);

    const pointsToday = developers.reduce((s, d) => s + d.todayPoints, 0);
    const activeTodayCount = activeToday.size;
    // Top Contributor (Daily card) is always literal-today. The leaderboard ranks
    // by points COMPLETED IN RANGE when a window is active, else by today's points.
    const todayRanked = [...developers].sort((a, b) => b.todayPoints - a.todayPoints);
    const topContributor = todayRanked[0] && todayRanked[0].todayPoints > 0
      ? { name: todayRanked[0].name, points: todayRanked[0].todayPoints } : null;
    const leaderPoints = (d: typeof developers[number]) => (ranged ? d.completedPoints : d.todayPoints);
    const top = [...developers].sort((a, b) => leaderPoints(b) - leaderPoints(a));

    const taskStatusTotal = statusCounts.todo + statusCounts.inProgress + statusCounts.review + statusCounts.qa + statusCounts.done;
    const dueTotal = tasksDelayed + tasksOnTime;

    res.status(200).json({
      capacity: {
        totalDevelopers, activeDevelopers, availableDevelopers, utilization: teamUtilization,
      },
      delivery: {
        totalAssigned: Math.round(totalAssigned), totalCompleted: Math.round(totalCompleted),
        completionRate, velocityPerWeek,
      },
      quality: {
        bugsRaised, bugsFixed,
        reopenRate: bugsRaised > 0 ? Math.round((bugsReopened / bugsRaised) * 1000) / 10 : 0,
        qaPassRate: bugsRaised > 0 ? Math.round((bugsFixed / bugsRaised) * 1000) / 10 : 0,
      },
      timeline: {
        tasksDelayed, tasksOnTime,
        avgDelayDays: tasksDelayed > 0 ? Math.round((delaySum / tasksDelayed) * 10) / 10 : 0,
        slaPercent: dueTotal > 0 ? Math.round((tasksOnTime / dueTotal) * 100) : 0,
      },
      daily: {
        pointsToday, activeToday: activeTodayCount,
        avgPointsPerDev: activeTodayCount > 0 ? Math.round((pointsToday / activeTodayCount) * 10) / 10 : 0,
        topContributor,
      },
      developers,
      taskStatus: {
        todo: statusCounts.todo,
        inProgress: statusCounts.inProgress,
        review: statusCounts.review,
        qa: statusCounts.qa,
        completed: statusCounts.done, // wire key matches the frontend contract
        total: taskStatusTotal,
      },
      topPerformers: top.filter((d) => leaderPoints(d) > 0).slice(0, 5).map((d) => ({ id: d.id, name: d.name, points: leaderPoints(d) })),
      capacityForecast: [...developers]
        .sort((a, b) => b.utilization - a.utilization)
        .slice(0, 6)
        .map((d) => ({ id: d.id, name: d.name, currentLoad: d.utilization, availableCapacity: Math.max(0, 100 - d.utilization) })),
      velocityTrend: weeks.map((w) => ({ week: w.label, assigned: Math.round(w.assigned), completed: Math.round(w.completed) })),
    });
  } catch (error) {
    console.error('Error fetching developer performance:', error);
    res.status(500).json({ error: 'Failed to fetch developer performance' });
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
