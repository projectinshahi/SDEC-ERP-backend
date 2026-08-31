import { Request, Response } from 'express';
import multer from 'multer';
import { v2 as cloudinary } from 'cloudinary';
import prisma from '../config/db.js';
import { getSalesAuth, can, type SalesAuthContext } from '../utils/salesAuth.js';
import { activityService } from '../services/activity.service.js';
import { notificationService } from '../services/notification.service.js';
import { destroyCloudinaryFile } from '../utils/cloudinaryFiles.js';

/**
 * Marketing → Content Production Kanban.
 *
 * Reuses the ERP's existing infrastructure end-to-end: RBAC comes from the roles
 * table via getSalesAuth/can (generic despite the name — it reads the caller's
 * role permission array), audit goes through activityService (activity_logs),
 * notifications through notificationService (DB + Socket.IO), and file uploads
 * through the shared multer→Cloudinary stream pattern (same as notice/bug/task
 * attachments).
 *
 * Authorization model (granular-OR-coarse, mirroring the Sales action gates):
 * each fine-grained action passes with its dedicated key OR the coarse
 * marketing.content.edit — EXCEPT approval, which requires marketing.content.approve
 * exactly (approval authority must never be implied by edit rights).
 */

// ── Workflow definition (single source for the backend) ──────────────────────
// Exactly one current stage per content item. 'blocked' is deliberately NOT part
// of the linear workflow — it is a separate parking column.
export const CONTENT_STAGES = [
  'idea', 'strategy', 'script', 'design', 'production',
  'editing', 'review', 'scheduled', 'published', 'analytics',
] as const;
export const BLOCKED_STAGE = 'blocked';
const ALL_STAGES: string[] = [...CONTENT_STAGES, BLOCKED_STAGE];

const PRIORITIES = ['low', 'medium', 'high', 'urgent'];
const PLATFORMS = ['instagram', 'facebook', 'linkedin', 'youtube', 'other'];
const FORMATS = ['reel', 'carousel', 'poster', 'video', 'story', 'blog', 'email', 'other'];

const STAGE_LABELS: Record<string, string> = {
  idea: 'Ideas / Backlog', strategy: 'Strategy & Planning', script: 'Script / Copy',
  design: 'Creative / Design', production: 'Production', editing: 'Editing',
  review: 'Review / Approval', scheduled: 'Scheduled', published: 'Published',
  analytics: 'Performance / Analytics', blocked: 'Blocked / Waiting',
};

// ── Permission helpers ───────────────────────────────────────────────────────
const P = {
  view: 'marketing.content.view',
  create: 'marketing.content.create',
  edit: 'marketing.content.edit',
  del: 'marketing.content.delete',
  move: 'marketing.content.move',
  assign: 'marketing.content.assign',
  approve: 'marketing.content.approve',
  schedule: 'marketing.content.schedule',
  publish: 'marketing.content.publish',
  analytics: 'marketing.content.analytics',
};
const canEditOr = (ctx: SalesAuthContext, key: string) => can(ctx, key) || can(ctx, P.edit);

// ── Shared upload middleware (same limits/pattern as the other attachment
//    controllers; memoryStorage → Cloudinary stream, nothing on local disk) ───
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});
export const contentUploadMiddleware = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 }, // marketing videos are large
});

// ── Small utils ──────────────────────────────────────────────────────────────
const uid = (req: Request) => Number((req as any).userId);
/** date-only column → 'YYYY-MM-DD' (Prisma @db.Date is UTC midnight, safe to slice). */
const ymd = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);
const isYmd = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
const asId = (v: unknown): number | null | undefined => {
  if (v === undefined) return undefined;       // not provided → leave unchanged
  if (v === null || v === '' || v === 0) return null; // explicit unassign
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : undefined;
};

const TEAM_FIELDS = ['owner_id', 'designer_id', 'videographer_id', 'editor_id'] as const;

/** Compose {id → name} for every user id referenced by the given rows. */
async function userNameMap(ids: (number | null)[]): Promise<Record<number, string>> {
  const unique = [...new Set(ids.filter((i): i is number => i != null))];
  if (!unique.length) return {};
  const users = await prisma.users.findMany({ where: { id: { in: unique } }, select: { id: true, name: true } });
  return Object.fromEntries(users.map((u) => [u.id, u.name]));
}

function serialize(row: any, names: Record<number, string>): any {
  return {
    ...row,
    deadline: ymd(row.deadline),
    ownerName: row.owner_id ? names[row.owner_id] ?? null : null,
    designerName: row.designer_id ? names[row.designer_id] ?? null : null,
    videographerName: row.videographer_id ? names[row.videographer_id] ?? null : null,
    editorName: row.editor_id ? names[row.editor_id] ?? null : null,
    createdByName: row.created_by ? names[row.created_by] ?? null : null,
  };
}

/** Everyone on the content's team except the actor (for notifications). */
function teamUserIds(row: any, exceptUserId?: number): number[] {
  const ids = TEAM_FIELDS.map((f) => row[f]).filter((i): i is number => i != null);
  return [...new Set(ids)].filter((i) => i !== exceptUserId);
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /marketing/content — Kanban dataset (server-side filters)
// ─────────────────────────────────────────────────────────────────────────────
export const getContents = async (req: Request, res: Response): Promise<any> => {
  try {
    const q = req.query;
    const where: any = {};
    if (typeof q.stage === 'string' && q.stage.trim() && q.stage !== 'all' && ALL_STAGES.includes(q.stage)) where.stage = q.stage;
    for (const [param, col] of [['ownerId', 'owner_id'], ['designerId', 'designer_id'], ['videographerId', 'videographer_id'], ['editorId', 'editor_id']] as const) {
      const v = q[param];
      if (typeof v === 'string' && v.trim() && v !== 'all') {
        const n = Number(v);
        if (Number.isInteger(n)) where[col] = n;
      }
    }
    if (typeof q.platform === 'string' && q.platform.trim() && q.platform !== 'all') where.platform = q.platform;
    if (typeof q.priority === 'string' && q.priority.trim() && q.priority !== 'all') where.priority = q.priority;
    if (typeof q.objective === 'string' && q.objective.trim() && q.objective !== 'all') {
      where.objective = { contains: q.objective.trim(), mode: 'insensitive' };
    }
    if (isYmd(q.deadlineFrom)) where.deadline = { ...where.deadline, gte: new Date(`${q.deadlineFrom}T00:00:00.000Z`) };
    if (isYmd(q.deadlineTo)) where.deadline = { ...where.deadline, lte: new Date(`${q.deadlineTo}T00:00:00.000Z`) };
    if (typeof q.search === 'string' && q.search.trim()) {
      where.OR = [
        { title: { contains: q.search.trim(), mode: 'insensitive' } },
        { description: { contains: q.search.trim(), mode: 'insensitive' } },
      ];
    }

    const rows = await prisma.marketing_contents.findMany({
      where,
      orderBy: [{ updated_at: 'desc' }],
      include: { attachments: { select: { id: true } } },
    });
    const names = await userNameMap(rows.flatMap((r) => [r.owner_id, r.designer_id, r.videographer_id, r.editor_id, r.created_by]));
    return res.json({
      success: true,
      stages: ALL_STAGES.map((key) => ({ key, label: STAGE_LABELS[key] })),
      contents: rows.map((r) => ({ ...serialize(r, names), attachmentCount: r.attachments.length, attachments: undefined })),
    });
  } catch (error) {
    console.error('Error fetching marketing contents:', error);
    return res.status(500).json({ error: 'Failed to fetch content items' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /marketing/content/:id — full detail
// ─────────────────────────────────────────────────────────────────────────────
export const getContentById = async (req: Request, res: Response): Promise<any> => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid content id' });
    const row = await prisma.marketing_contents.findUnique({
      where: { id },
      include: { attachments: { orderBy: { uploaded_at: 'desc' } } },
    });
    if (!row) return res.status(404).json({ error: 'Content not found' });
    const names = await userNameMap([
      row.owner_id, row.designer_id, row.videographer_id, row.editor_id, row.created_by,
      ...row.attachments.map((a) => a.uploaded_by),
    ]);
    return res.json({
      success: true,
      content: {
        ...serialize(row, names),
        attachments: row.attachments.map((a) => ({ ...a, uploaderName: a.uploaded_by ? names[a.uploaded_by] ?? null : null })),
      },
    });
  } catch (error) {
    console.error('Error fetching marketing content:', error);
    return res.status(500).json({ error: 'Failed to fetch content item' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /marketing/content — create (defaults to Ideas/Backlog)
// ─────────────────────────────────────────────────────────────────────────────
export const createContent = async (req: Request, res: Response): Promise<any> => {
  try {
    const actorId = uid(req);
    const b = req.body ?? {};
    const title = String(b.title ?? '').trim();
    if (!title) return res.status(400).json({ error: 'Title is required' });
    if (title.length > 255) return res.status(400).json({ error: 'Title must be under 255 characters' });

    const stage = typeof b.stage === 'string' && ALL_STAGES.includes(b.stage) ? b.stage : 'idea';
    const priority = typeof b.priority === 'string' && PRIORITIES.includes(b.priority) ? b.priority : 'medium';
    const platform = typeof b.platform === 'string' && PLATFORMS.includes(b.platform) ? b.platform : null;
    const format = typeof b.format === 'string' && FORMATS.includes(b.format) ? b.format : null;

    const row = await prisma.marketing_contents.create({
      data: {
        title,
        description: typeof b.description === 'string' ? b.description.trim() || null : null,
        format,
        stage,
        priority,
        objective: typeof b.objective === 'string' ? b.objective.trim().slice(0, 100) || null : null,
        target_audience: typeof b.targetAudience === 'string' ? b.targetAudience.trim() || null : null,
        platform,
        cta: typeof b.cta === 'string' ? b.cta.trim().slice(0, 255) || null : null,
        references_text: typeof b.references === 'string' ? b.references.trim() || null : null,
        notes: typeof b.notes === 'string' ? b.notes.trim() || null : null,
        deadline: isYmd(b.deadline) ? new Date(`${b.deadline}T00:00:00.000Z`) : null,
        owner_id: asId(b.ownerId) ?? null,
        designer_id: asId(b.designerId) ?? null,
        videographer_id: asId(b.videographerId) ?? null,
        editor_id: asId(b.editorId) ?? null,
        created_by: actorId || null,
      },
    });

    await activityService.logActivity({
      actorUserId: actorId,
      type: 'marketing_content_created',
      description: `Created marketing content '${row.title}' in ${STAGE_LABELS[row.stage]}`,
    });
    // Notify newly assigned team members (never the actor).
    const assignees = teamUserIds(row, actorId);
    if (assignees.length) {
      await notificationService.createNotifications(assignees, {
        type: 'assignment',
        title: 'Assigned to marketing content',
        message: `You were assigned to '${row.title}'`,
        entityType: 'marketing_content',
        entityId: row.id,
      });
    }
    return res.status(201).json({ success: true, content: { ...row, deadline: ymd(row.deadline) } });
  } catch (error) {
    console.error('Error creating marketing content:', error);
    return res.status(500).json({ error: 'Failed to create content item' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// PUT /marketing/content/:id — sectioned update with per-section authorization
// ─────────────────────────────────────────────────────────────────────────────
export const updateContent = async (req: Request, res: Response): Promise<any> => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid content id' });
    const existing = await prisma.marketing_contents.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: 'Content not found' });

    const ctx = await getSalesAuth(req);
    const b = req.body ?? {};
    const data: any = {};

    // ── Core fields (marketing.content.edit) ─────────────────────────────────
    const wantsCore = ['title', 'description', 'format', 'priority', 'objective', 'targetAudience', 'platform', 'cta', 'references', 'notes', 'deadline', 'copyData', 'stageData'].some((k) => b[k] !== undefined);
    if (wantsCore) {
      if (!can(ctx, P.edit)) return res.status(403).json({ error: 'You do not have permission to edit content' });
      if (b.title !== undefined) {
        const t = String(b.title ?? '').trim();
        if (!t) return res.status(400).json({ error: 'Title cannot be empty' });
        data.title = t.slice(0, 255);
      }
      if (b.description !== undefined) data.description = typeof b.description === 'string' ? b.description.trim() || null : null;
      if (b.format !== undefined) data.format = typeof b.format === 'string' && FORMATS.includes(b.format) ? b.format : null;
      if (b.priority !== undefined && PRIORITIES.includes(b.priority)) data.priority = b.priority;
      if (b.objective !== undefined) data.objective = typeof b.objective === 'string' ? b.objective.trim().slice(0, 100) || null : null;
      if (b.targetAudience !== undefined) data.target_audience = typeof b.targetAudience === 'string' ? b.targetAudience.trim() || null : null;
      if (b.platform !== undefined) data.platform = typeof b.platform === 'string' && PLATFORMS.includes(b.platform) ? b.platform : null;
      if (b.cta !== undefined) data.cta = typeof b.cta === 'string' ? b.cta.trim().slice(0, 255) || null : null;
      if (b.references !== undefined) data.references_text = typeof b.references === 'string' ? b.references.trim() || null : null;
      if (b.notes !== undefined) data.notes = typeof b.notes === 'string' ? b.notes.trim() || null : null;
      if (b.deadline !== undefined) data.deadline = isYmd(b.deadline) ? new Date(`${b.deadline}T00:00:00.000Z`) : null;
      // Copy/script + per-stage checklist payloads: shallow-merged JSONB so a
      // section save never clobbers another section's stored fields.
      if (b.copyData !== undefined && typeof b.copyData === 'object') {
        data.copy_data = { ...(existing.copy_data as any ?? {}), ...b.copyData };
      }
      if (b.stageData !== undefined && typeof b.stageData === 'object') {
        data.stage_data = { ...(existing.stage_data as any ?? {}), ...b.stageData };
      }
    }

    // ── Assignments (marketing.content.assign OR edit) ───────────────────────
    const wantsAssign = ['ownerId', 'designerId', 'videographerId', 'editorId'].some((k) => b[k] !== undefined);
    const newlyAssigned: number[] = [];
    if (wantsAssign) {
      if (!canEditOr(ctx, P.assign)) return res.status(403).json({ error: 'You do not have permission to manage assignments' });
      for (const [param, col] of [['ownerId', 'owner_id'], ['designerId', 'designer_id'], ['videographerId', 'videographer_id'], ['editorId', 'editor_id']] as const) {
        const v = asId(b[param]);
        if (v !== undefined) {
          data[col] = v;
          if (v != null && v !== (existing as any)[col]) newlyAssigned.push(v);
        }
      }
    }

    // ── Schedule (marketing.content.schedule OR edit) ────────────────────────
    if (b.scheduleData !== undefined && typeof b.scheduleData === 'object') {
      if (!canEditOr(ctx, P.schedule)) return res.status(403).json({ error: 'You do not have permission to manage scheduling' });
      data.stage_data = { ...(data.stage_data ?? existing.stage_data as any ?? {}), schedule: { ...((existing.stage_data as any)?.schedule ?? {}), ...b.scheduleData } };
    }

    // ── Published platforms (marketing.content.publish OR edit) ──────────────
    if (b.publishedData !== undefined && typeof b.publishedData === 'object') {
      if (!canEditOr(ctx, P.publish)) return res.status(403).json({ error: 'You do not have permission to manage published content' });
      data.stage_data = { ...(data.stage_data ?? existing.stage_data as any ?? {}), published: { ...((existing.stage_data as any)?.published ?? {}), ...b.publishedData } };
    }

    // ── Performance metrics (marketing.content.analytics OR edit) ────────────
    // Only actually-entered values are stored — nothing is fabricated.
    if (b.metrics !== undefined && typeof b.metrics === 'object') {
      if (!canEditOr(ctx, P.analytics)) return res.status(403).json({ error: 'You do not have permission to edit performance analytics' });
      data.metrics = { ...(existing.metrics as any ?? {}), ...b.metrics };
    }

    if (!Object.keys(data).length) return res.status(400).json({ error: 'No valid fields to update' });

    const row = await prisma.marketing_contents.update({ where: { id }, data });

    if (newlyAssigned.length) {
      const actorId = uid(req);
      await notificationService.createNotifications(newlyAssigned.filter((i) => i !== actorId), {
        type: 'assignment',
        title: 'Assigned to marketing content',
        message: `You were assigned to '${row.title}'`,
        entityType: 'marketing_content',
        entityId: row.id,
      });
    }
    return res.json({ success: true, content: { ...row, deadline: ymd(row.deadline) } });
  } catch (error) {
    console.error('Error updating marketing content:', error);
    return res.status(500).json({ error: 'Failed to update content item' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /marketing/content/:id/stage — persist a Kanban move (audited)
// ─────────────────────────────────────────────────────────────────────────────
export const moveContentStage = async (req: Request, res: Response): Promise<any> => {
  try {
    const id = Number(req.params.id);
    const target = String(req.body?.stage ?? '');
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid content id' });
    if (!ALL_STAGES.includes(target)) return res.status(400).json({ error: 'Unknown stage' });

    const existing = await prisma.marketing_contents.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: 'Content not found' });
    if (existing.stage === target) return res.json({ success: true, content: { ...existing, deadline: ymd(existing.deadline) } });

    const row = await prisma.marketing_contents.update({ where: { id }, data: { stage: target } });

    const actorId = uid(req);
    // Audit through the EXISTING activity mechanism (metadata carries the move).
    await activityService.logActivity({
      actorUserId: actorId,
      type: 'marketing_content_stage_changed',
      description: `Moved '${row.title}' from ${STAGE_LABELS[existing.stage] ?? existing.stage} to ${STAGE_LABELS[target]}`,
      metadata: { contentId: id, from: existing.stage, to: target },
    });
    // Stage-change notification to the whole assigned team (except the actor);
    // entering Review additionally reads as an approval request.
    const team = teamUserIds(row, actorId);
    if (team.length) {
      await notificationService.createNotifications(team, {
        type: target === 'review' ? 'approval_request' : 'status_change',
        title: target === 'review' ? 'Content awaiting approval' : 'Content stage changed',
        message: `'${row.title}' moved to ${STAGE_LABELS[target]}`,
        entityType: 'marketing_content',
        entityId: row.id,
      });
    }
    return res.json({ success: true, content: { ...row, deadline: ymd(row.deadline) } });
  } catch (error) {
    console.error('Error moving marketing content stage:', error);
    return res.status(500).json({ error: 'Failed to move content' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /marketing/content/:id/approval — approve / reject (approve perm ONLY)
// ─────────────────────────────────────────────────────────────────────────────
export const setContentApproval = async (req: Request, res: Response): Promise<any> => {
  try {
    const id = Number(req.params.id);
    const status = String(req.body?.status ?? '');
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid content id' });
    if (!['approved', 'rejected', 'pending'].includes(status)) return res.status(400).json({ error: 'Status must be approved, rejected or pending' });

    const existing = await prisma.marketing_contents.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: 'Content not found' });

    const note = typeof req.body?.note === 'string' ? req.body.note.trim().slice(0, 500) : '';
    const row = await prisma.marketing_contents.update({
      where: { id },
      data: {
        approval_status: status,
        stage_data: { ...(existing.stage_data as any ?? {}), review: { ...((existing.stage_data as any)?.review ?? {}), decision: status, note: note || undefined, decidedAt: new Date().toISOString() } },
      },
    });

    const actorId = uid(req);
    await activityService.logActivity({
      actorUserId: actorId,
      type: 'marketing_content_approval',
      description: `${status === 'approved' ? 'Approved' : status === 'rejected' ? 'Rejected' : 'Reset approval on'} marketing content '${row.title}'`,
      metadata: { contentId: id, status, note: note || undefined },
    });
    const team = teamUserIds(row, actorId);
    if (team.length && status !== 'pending') {
      await notificationService.createNotifications(team, {
        type: status === 'approved' ? 'approval' : 'rejection',
        title: `Content ${status}`,
        message: `'${row.title}' was ${status}${note ? ` — ${note}` : ''}`,
        entityType: 'marketing_content',
        entityId: row.id,
      });
    }
    return res.json({ success: true, content: { ...row, deadline: ymd(row.deadline) } });
  } catch (error) {
    console.error('Error setting marketing content approval:', error);
    return res.status(500).json({ error: 'Failed to update approval' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /marketing/content/:id
// ─────────────────────────────────────────────────────────────────────────────
export const deleteContent = async (req: Request, res: Response): Promise<any> => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid content id' });
    const existing = await prisma.marketing_contents.findUnique({ where: { id }, include: { attachments: true } });
    if (!existing) return res.status(404).json({ error: 'Content not found' });

    // Best-effort Cloudinary cleanup BEFORE the row (attachments cascade with it).
    for (const a of existing.attachments) await destroyCloudinaryFile(a.file_url);
    await prisma.marketing_contents.delete({ where: { id } });

    await activityService.logActivity({
      actorUserId: uid(req),
      type: 'marketing_content_deleted',
      description: `Deleted marketing content '${existing.title}'`,
    });
    return res.json({ success: true });
  } catch (error) {
    console.error('Error deleting marketing content:', error);
    return res.status(500).json({ error: 'Failed to delete content item' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /marketing/content/:id/attachments — shared Cloudinary stream upload
// ─────────────────────────────────────────────────────────────────────────────
export const uploadContentAttachments = async (req: Request, res: Response): Promise<any> => {
  try {
    const id = Number(req.params.id);
    const files = req.files as Express.Multer.File[];
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid content id' });
    if (!files || files.length === 0) return res.status(400).json({ error: 'No files uploaded' });

    const existing = await prisma.marketing_contents.findUnique({ where: { id }, select: { id: true } });
    if (!existing) return res.status(404).json({ error: 'Content not found' });

    const userId = uid(req);
    const uploaded = [];
    for (const file of files) {
      const result: any = await new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
          {
            resource_type: 'auto',
            folder: 'erp_marketing_content',
            public_id: `${Date.now()}-${file.originalname.replace(/[^a-zA-Z0-9-_.]/g, '')}`,
          },
          (error, r) => (error ? reject(error) : resolve(r)),
        );
        stream.end(file.buffer);
      });
      const attachment = await prisma.marketing_content_attachments.create({
        data: {
          content_id: id,
          file_name: file.originalname,
          file_url: result.secure_url,
          file_size: file.size,
          file_type: file.mimetype || null,
          uploaded_by: userId || null,
        },
      });
      uploaded.push(attachment);
    }
    return res.status(201).json({ success: true, attachments: uploaded });
  } catch (error) {
    console.error('Error uploading marketing content attachments:', error);
    return res.status(500).json({ error: 'Failed to upload attachments' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /marketing/content/:id/attachments/:attachmentId
// ─────────────────────────────────────────────────────────────────────────────
export const deleteContentAttachment = async (req: Request, res: Response): Promise<any> => {
  try {
    const id = Number(req.params.id);
    const attachmentId = Number(req.params.attachmentId);
    if (!Number.isInteger(attachmentId)) return res.status(404).json({ error: 'Attachment not found' });

    const attachment = await prisma.marketing_content_attachments.findUnique({ where: { id: attachmentId } });
    if (!attachment || attachment.content_id !== id) return res.status(404).json({ error: 'Attachment not found' });

    await destroyCloudinaryFile(attachment.file_url);
    await prisma.marketing_content_attachments.delete({ where: { id: attachmentId } });
    return res.json({ success: true });
  } catch (error) {
    console.error('Error deleting marketing content attachment:', error);
    return res.status(500).json({ error: 'Failed to delete attachment' });
  }
};
