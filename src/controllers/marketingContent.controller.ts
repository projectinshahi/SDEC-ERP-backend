import { Request, Response } from 'express';
import multer from 'multer';
import { v2 as cloudinary } from 'cloudinary';
import prisma from '../config/db.js';
import { getSalesAuth, can, type SalesAuthContext } from '../utils/salesAuth.js';
import { activityService } from '../services/activity.service.js';
import { notificationService } from '../services/notification.service.js';
import { dispatchAssignment, dispatchStageChange, dispatchApprovalDecision, getNotificationSettings, updateNotificationSettings } from '../services/contentNotification.service.js';
import { destroyCloudinaryFile } from '../utils/cloudinaryFiles.js';
import {
  CONTENT_TYPES, validateContentCard, generateContentId, mergeProductionData,
  nearestDeadline, listReference, createReference, updateReference,
  REFERENCE_TABLES, type ReferenceTable,
  invalidateActiveReferenceCache, isSelectable,
} from '../services/contentCard.service.js';
import {
  DESIGN_STAGE, canEditStrategy, canToggleReady, checkCopyEditable,
  checkStrategyReady, checkCopyReady, checkStageTransition,
  mergeStrategyData, mergeCopyData, type WorkflowCard,
} from '../services/contentWorkflow.service.js';
import { buildContentCardWhere, hasAnyDeadline } from '../services/contentQuery.service.js';
import { toCsv, sendCsv, type CsvColumn } from '../utils/csv.js';
import {
  CONTENT_STAGES, BLOCKED_STAGE, ALL_STAGES, STAGE_LABELS, stageLabel,
  applyStageMove, REVIEW_STAGE as STAGE_REVIEW, SCHEDULED_STAGE, PUBLISHED_STAGE,
} from '../services/contentStage.service.js';
import {
  mergeScheduleData, checkScheduleReady, mergePublishedLinks, buildPublishRecord,
  checkPublishReady, canSchedule as canScheduleContent,
} from '../services/contentPublishing.service.js';
import {
  PERFORMANCE_METRICS, PERFORMANCE_STAGES, NOTES_KEY, metricApplies,
  mergeMetrics, hasPerformanceData, checkPerformanceEditable,
} from '../services/contentPerformance.service.js';
import {
  REVIEW_CHECKLIST_ITEMS, isReviewChecklistKey, reviewItemLabel, readChecklist,
  isChecklistComplete, writeChecklistItem, resetChecklist, checkChecklistEditable,
  validateDecision, isDenial, canDecide, DECISION_LABELS, APPROVAL_STATUSES,
  checkResubmit,
} from '../services/contentReview.service.js';
import {
  mergeCreativeDirection, buildProductionPatch, checkProductionReady,
  isShootFormat, isDesignFormat, checkStageEntry, checkReviewEntry, REVIEW_STAGE,
  finalDeadlineFor,
  canAddWorkOutput, canModifyWorkOutput, validateWorkOutput,
} from '../services/contentProduction.service.js';

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

// ── Workflow definition ──────────────────────────────────────────────────────
// The stage list and labels live in contentStage.service — the ONE place that
// owns transitions — so the controller cannot drift from the service that
// validates against them.
const PRIORITIES = ['low', 'medium', 'high', 'urgent'];
const PLATFORMS = ['instagram', 'facebook', 'linkedin', 'youtube', 'other'];
const FORMATS = ['reel', 'carousel', 'poster', 'video', 'story', 'blog', 'email', 'other'];

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
/**
 * A Client / Category / Pillar / Campaign / user id that no longer exists trips
 * the FOREIGN KEY. The row is left untouched by the database, so this is a
 * client error, not a server fault — report 400 instead of a 500.
 */
const BAD_REFERENCE_MSG = 'A selected reference no longer exists — reload the page and choose again.';
const isBadReference = (e: unknown): boolean => (e as { code?: string } | null)?.code === 'P2003';

const asId = (v: unknown): number | null | undefined => {
  if (v === undefined) return undefined;       // not provided → leave unchanged
  if (v === null || v === '' || v === 0) return null; // explicit unassign
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : undefined;
};

const TEAM_FIELDS = ['owner_id', 'designer_id', 'videographer_id', 'editor_id', 'scriptwriter_id', 'talent_id', 'approver_id'] as const;

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
    // ONE filter builder for Kanban / List / Deadline — see contentQuery.service.
    const where = buildContentCardWhere(req.query as Record<string, unknown>, {
      allStages: ALL_STAGES, platforms: PLATFORMS, priorities: PRIORITIES, formats: FORMATS,
      actorId: uid(req), performanceStages: PERFORMANCE_STAGES,
    });

    const rows = await prisma.marketing_contents.findMany({
      where,
      orderBy: [{ updated_at: 'desc' }],
      include: { attachments: { select: { id: true } } },
    });
    const names = await userNameMap(rows.flatMap((r) => [
      r.owner_id, r.designer_id, r.videographer_id, r.editor_id, r.created_by,
      r.scriptwriter_id, r.talent_id, r.approver_id,
    ]));
    return res.json({
      success: true,
      stages: ALL_STAGES.map((key) => ({ key, label: STAGE_LABELS[key] })),
      // Kanban tiles need owner/designer/videographer/editor names, the objective,
      // platforms and every production deadline. `serialize` already resolves the
      // names from ONE batched users query, so there is no N+1.
      contents: rows.map((r) => ({
        ...serialize(r, names),
        platforms: r.platforms?.length ? r.platforms : (r.platform ? [r.platform] : []),
        nearestDeadline: nearestDeadline(r),
        approverId: r.approver_id,
        attachmentCount: r.attachments.length,
        attachments: undefined,
      })),
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
      include: {
        attachments: { orderBy: { uploaded_at: 'desc' } },
        // Loaded with the card so the Production section and the Stage 7
        // affordance always read the CURRENT persisted set, never a stale count.
        work_outputs: { orderBy: { created_at: 'desc' } },
      },
    });
    if (!row) return res.status(404).json({ error: 'Content not found' });
    const names = await userNameMap([
      row.owner_id, row.designer_id, row.videographer_id, row.editor_id, row.created_by,
      // M03 readiness actors resolved in the SAME batched query — no extra round trip.
      row.strategy_ready_by, row.copy_ready_by, row.production_ready_by,
      row.scriptwriter_id, row.talent_id, row.approver_id,
      ...row.attachments.map((a) => a.uploaded_by),
      ...row.work_outputs.map((w) => w.added_by),
    ]);
    return res.json({
      success: true,
      content: {
        ...serialize(row, names),
        scriptwriterName: row.scriptwriter_id ? names[row.scriptwriter_id] ?? null : null,
        approverName: row.approver_id ? names[row.approver_id] ?? null : null,
        talentName: row.talent_id ? names[row.talent_id] ?? null : null,
        productionReadyByName: row.production_ready_by ? names[row.production_ready_by] ?? null : null,
        strategyReadyByName: row.strategy_ready_by ? names[row.strategy_ready_by] ?? null : null,
        copyReadyByName: row.copy_ready_by ? names[row.copy_ready_by] ?? null : null,
        attachments: row.attachments.map((a) => ({ ...a, uploaderName: a.uploaded_by ? names[a.uploaded_by] ?? null : null })),
        workOutputs: row.work_outputs.map((w) => serializeWorkOutput(w, names)),
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

    // Server-side validation is the ENFORCEMENT point (the form's inline errors
    // are only a convenience). Field-specific messages, never a silent ignore.
    const errors = validateContentCard(b);
    if (errors.length) return res.status(400).json({ error: errors[0].message, errors });

    const title = String(b.title).trim();
    const stage = typeof b.stage === 'string' && ALL_STAGES.includes(b.stage) ? b.stage : 'idea';
    const priority = typeof b.priority === 'string' && PRIORITIES.includes(b.priority) ? b.priority : 'medium';
    const format = String(b.format);
    // Platform(s) multi-select; the legacy single column keeps the first value so
    // existing readers/filters continue to work unchanged.
    const platforms: string[] = Array.isArray(b.platforms)
      ? [...new Set<string>(b.platforms.filter((x: unknown): x is string => typeof x === 'string' && PLATFORMS.includes(x)))]
      : [];
    const platform = platforms[0] ?? (typeof b.platform === 'string' && PLATFORMS.includes(b.platform) ? b.platform : null);
    // Content ID is generated SERVER-SIDE from a sequence; any client-supplied
    // value is ignored outright.
    /* M10 #43 — a DEACTIVATED platform or objective may not be chosen for a NEW
     * card. Existing cards keep whatever they already hold: this check runs on
     * create/selection only, never against stored values. */
    for (const p of platforms) {
      if (!(await isSelectable('platforms', p))) {
        return res.status(400).json({ error: `The platform '${p}' is no longer available.` });
      }
    }
    if (typeof b.objective === 'string' && b.objective.trim()) {
      if (!(await isSelectable('objectives', b.objective.trim()))) {
        return res.status(400).json({ error: `The objective '${b.objective.trim()}' is no longer available.` });
      }
    }

    // A card cannot be CREATED straight into Review either — the same gate, so
    // the create endpoint is not a back door into Stage 7. A new card has no
    // Work Output rows yet, so this always reports the real missing conditions.
    if (stage === REVIEW_STAGE) {
      const reviewDenial = checkReviewEntry({ format, production_data: null }, 0);
      if (reviewDenial) return res.status(reviewDenial.status).json({ error: reviewDenial.message });
    }

    const contentId = await generateContentId();

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
        // M05 added these three assignment columns but create never persisted
        // them, so a card created WITH an Approver came back without one — and
        // the M07 approval authority (approver_id) could never be set at create.
        scriptwriter_id: asId(b.scriptwriterId) ?? null,
        talent_id: asId(b.talentId) ?? null,
        approver_id: asId(b.approverId) ?? null,
        content_id: contentId,
        client_id: asId(b.clientId) ?? null,
        category_id: asId(b.categoryId) ?? null,
        pillar_id: asId(b.pillarId) ?? null,
        campaign_id: asId(b.campaignId) ?? null,
        platforms,
        production_data: mergeProductionData(null, b.productionData) as any,
        // Created By ALWAYS comes from the authenticated session — a client can
        // never submit createdBy and impersonate another user.
        created_by: actorId || null,
      },
    });

    await activityService.logActivity({
      actorUserId: actorId,
      type: 'marketing_content_created',
      description: `Created marketing content '${row.title}' in ${STAGE_LABELS[row.stage]}`,
    });
    // EVENT 1 — assignment. Every role field set at creation is a NEW assignment.
    await dispatchAssignment(row, teamUserIds(row, actorId), actorId);
    return res.status(201).json({ success: true, content: { ...row, deadline: ymd(row.deadline) } });
  } catch (error) {
    if (isBadReference(error)) return res.status(400).json({ error: BAD_REFERENCE_MSG });
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
    // EVERY key handled inside this block must be listed here, otherwise a patch
    // carrying only that key falls through to the "No valid fields" 400 and the
    // change is silently lost (e.g. a Content Pillar-only save from Basics).
    const wantsCore = [
      'title', 'description', 'format', 'priority', 'objective', 'targetAudience', 'platform',
      'cta', 'references', 'notes', 'deadline', 'copyData', 'stageData',
      'clientId', 'categoryId', 'pillarId', 'campaignId', 'platforms',
      'productionData', 'creativeDirection', 'productionFields', 'strategyData',
    ].some((k) => b[k] !== undefined);
    if (wantsCore) {
      if (!can(ctx, P.edit)) return res.status(403).json({ error: 'You do not have permission to edit content' });
      // Same authoritative validation as create, in PARTIAL mode: only fields
      // actually present are checked, and production fields are never required.
      const vErrors = validateContentCard(b, { partial: true });
      if (vErrors.length) return res.status(400).json({ error: vErrors[0].message, errors: vErrors });
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
      // M02 classification. Each is optional; `null` clears the link.
      for (const [param, col] of [['clientId', 'client_id'], ['categoryId', 'category_id'], ['pillarId', 'pillar_id'], ['campaignId', 'campaign_id']] as const) {
        const v = asId(b[param]);
        if (v !== undefined) data[col] = v;
      }
      if (b.platforms !== undefined) {
        const list = Array.isArray(b.platforms)
          ? [...new Set(b.platforms.filter((x: unknown): x is string => typeof x === 'string' && PLATFORMS.includes(x)))]
          : [];
        data.platforms = list;
        data.platform = list[0] ?? null; // keep the legacy single column in sync
      }
      // Production data is MERGED per section, so saving while one Content Type's
      // fields are on screen can never clear the other type's stored values.
      // Changing Content Type controls visibility only - it never destroys data.
      if (b.productionData !== undefined) {
        data.production_data = mergeProductionData(existing.production_data, b.productionData);
      }
      // ── M04 CREATIVE DIRECTION ────────────────────────────────────────
      // Its own store, merged per key — never touches Production, Strategy or Copy.
      if (b.creativeDirection !== undefined) {
        if (!canEditStrategy(ctx)) return res.status(403).json({ error: 'You do not have permission to edit Creative Direction' });
        const cd = mergeCreativeDirection(existing.creative_direction, b.creativeDirection);
        if (cd.invalidUrls.length) {
          return res.status(400).json({
            error: `Invalid visual reference URL: ${cd.invalidUrls[0]}`,
            errors: cd.invalidUrls.map((u) => ({ field: 'visualReferences', message: `Invalid URL: ${u}` })),
          });
        }
        data.creative_direction = cd.data as any;
      }

      // ── M04 PRODUCTION BRIEFING ───────────────────────────────────────
      // The family is derived from the card's CONTENT TYPE, not from the client,
      // and only that family is written — so a Poster save can never overwrite
      // stored Reel values, and switching type never deletes the other set.
      if (b.productionFields !== undefined && typeof b.productionFields === 'object') {
        if (!canEditStrategy(ctx)) return res.status(403).json({ error: 'You do not have permission to edit Production details' });
        const family = isShootFormat(existing.format) ? 'shoot' : isDesignFormat(existing.format) ? 'design' : null;
        if (!family) return res.status(400).json({ error: 'Set a Content Type before entering production details' });
        const built = buildProductionPatch(family, b.productionFields as Record<string, unknown>);
        if (built.errors.length) {
          return res.status(400).json({ error: built.errors[0].message, errors: built.errors });
        }
        const pd = (existing.production_data ?? {}) as Record<string, any>;
        data.production_data = { ...pd, [family]: { ...(pd[family] ?? {}), ...built.fields } } as any;
      }

      // ── M03 STRATEGY ──────────────────────────────────────────────────
      // Narrative fields live in strategy_data; CTA and Content Pillar are
      // written to the EXISTING `cta` / `pillar_id` columns above, so Basics and
      // Strategy always read the same value. Absent keys are left untouched, so
      // saving Strategy never disturbs Copy or any other section.
      if (b.strategyData !== undefined) {
        if (!canEditStrategy(ctx)) return res.status(403).json({ error: 'You do not have permission to edit Strategy' });
        data.strategy_data = mergeStrategyData(existing.strategy_data, b.strategyData);
      }
      if (b.copyData !== undefined && typeof b.copyData === 'object') {
        // ── M03 COPY ────────────────────────────────────────────────────
        // Locked until Strategy is Ready — a WORKFLOW gate enforced here, so a
        // direct API call cannot bypass the UI lock.
        const denial = checkCopyEditable(ctx, existing as unknown as WorkflowCard);
        if (denial) return res.status(denial.status).json({ error: denial.message });
        const merged = mergeCopyData(existing.copy_data, b.copyData);
        if (merged.invalidUrls.length) {
          return res.status(400).json({
            error: `Invalid reference URL: ${merged.invalidUrls[0]}`,
            errors: merged.invalidUrls.map((u) => ({ field: 'referenceLinks', message: `Invalid URL: ${u}` })),
          });
        }
        data.copy_data = merged.data as any;
      }
      if (b.stageData !== undefined && typeof b.stageData === 'object') {
        data.stage_data = { ...(existing.stage_data as any ?? {}), ...b.stageData };
      }
    }

    // ── Assignments (marketing.content.assign OR edit) ───────────────────────
    const wantsAssign = ['ownerId', 'designerId', 'videographerId', 'editorId', 'scriptwriterId', 'talentId', 'approverId'].some((k) => b[k] !== undefined);
    const newlyAssigned: number[] = [];
    if (wantsAssign) {
      if (!canEditOr(ctx, P.assign)) return res.status(403).json({ error: 'You do not have permission to manage assignments' });
      // Assignments may change only BEFORE publication. 'published' is the
      // authoritative stage from the canonical pipeline, not a UI label.
      if (existing.stage === 'published') {
        return res.status(409).json({ error: 'Assignments cannot be changed after the card is published.' });
      }
      for (const [param, col] of [['ownerId', 'owner_id'], ['designerId', 'designer_id'], ['videographerId', 'videographer_id'], ['editorId', 'editor_id'], ['scriptwriterId', 'scriptwriter_id'], ['talentId', 'talent_id'], ['approverId', 'approver_id']] as const) {
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
      // M09 #41 — permission AND the stage gate, both against the persisted row,
      // then the shared merge: partial saves only touch the keys sent, '' clears
      // a metric, 0 stores a real zero, and negatives/text are rejected rather
      // than silently coerced.
      const denial = checkPerformanceEditable(ctx, existing as any);
      if (denial) return res.status(denial.status).json({ error: denial.message });
      const merged = mergeMetrics(existing.metrics, b.metrics, existing.format);
      if (merged.errors.length) {
        return res.status(400).json({ error: merged.errors[0].message, errors: merged.errors });
      }
      data.metrics = merged.data as any;
      // Keep the Awaiting Performance Data flag in step with the ONE rule.
      data.has_performance_data = hasPerformanceData(merged.data);
    }

    if (!Object.keys(data).length) return res.status(400).json({ error: 'No valid fields to update' });

    const row = await prisma.marketing_contents.update({ where: { id }, data });

    // EVENT 1 — only roles whose assignee actually CHANGED (see newlyAssigned).
    if (newlyAssigned.length) await dispatchAssignment(row, newlyAssigned, uid(req));
    return res.json({ success: true, content: { ...row, deadline: ymd(row.deadline) } });
  } catch (error) {
    if (isBadReference(error)) return res.status(400).json({ error: BAD_REFERENCE_MSG });
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

    // ONE stage-transition service for every entry point — Kanban drag/drop,
    // the detail page selector, a raw API call and the M07 approval routing.
    // Gates, audit entry and notification all live there, so no caller can
    // move a card while skipping any of them.
    const moveCtx = await getSalesAuth(req);
    const result = await applyStageMove(existing as any, target, {
      actorId: uid(req),
      reason: typeof req.body?.reason === 'string' ? req.body.reason.trim() : '',
      isAdmin: moveCtx.isAdmin,
    });
    if (result.denial) return res.status(result.denial.status).json({ error: result.denial.message });

    const row = result.card as any;
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
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid content id' });

    // Always read the card fresh: the stage, the assigned Approver and the
    // checklist all come from the database, never from the request.
    const existing = await prisma.marketing_contents.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: 'Content not found' });

    const ctx = await getSalesAuth(req);
    const verdict = validateDecision(ctx, existing as any, {
      status: String(req.body?.status ?? '') as any,
      // `note` is the legacy field name; `revisionNotes` the M07 one. Both map
      // to the same value so the existing caller keeps working.
      notes: req.body?.revisionNotes ?? req.body?.note,
    });
    if (isDenial(verdict)) return res.status(verdict.status).json({ error: verdict.message });

    const actorId = uid(req);
    const nowIso = new Date().toISOString();
    const decisionLabel = DECISION_LABELS[verdict.status];

    // The decision record. Written INTO the same update statement as the stage
    // move below, so the card can never end up moved-but-undecided (or decided
    // but not moved).
    const base = verdict.resetsChecklist ? resetChecklist(existing.stage_data) : ((existing.stage_data as any) ?? {});
    const stageData = {
      ...base,
      review: {
        ...((base as any).review ?? {}),
        decision: verdict.status,
        note: verdict.notes || undefined,
        decidedBy: actorId,
        decidedAt: nowIso,
      },
    };

    const target = verdict.targetStage;
    let row: any;

    if (target && existing.stage !== target) {
      /* Routed outcome. The stage move goes through the SAME service every
       * other transition uses, so its gates and audit apply — and the approval
       * columns ride along in that single UPDATE.
       *
       * Changes Requested and Rejected are BACKWARD moves, which the existing
       * M06 rule requires a reason for. The Revision Notes ARE that reason:
       * they are passed through rather than the gate being bypassed, which is
       * also why notes are mandatory for exactly those two outcomes. */
      const result = await applyStageMove(existing as any, target, {
        actorId,
        reason: verdict.notes || decisionLabel,
        isAdmin: ctx.isAdmin,
        extraData: { approval_status: verdict.status, stage_data: stageData },
        // The Content Owner gets ONE notification for this event — the decision
        // notification below. Without this the stage-arrival notification would
        // reach the same person for the same action.
        skipStageNotification: true,
        auditDescription: `${decisionLabel}: '${existing.title}' moved from ${stageLabel(existing.stage)} to ${stageLabel(target)}`,
        auditMetadata: { decision: verdict.status, ...(verdict.notes ? { revisionNotes: verdict.notes } : {}) },
      });
      if (result.denial) return res.status(result.denial.status).json({ error: result.denial.message });
      row = result.card;
    } else {
      // 'pending' (or an outcome whose target is the current stage): record the
      // decision only, move nothing.
      row = await prisma.marketing_contents.update({
        where: { id },
        data: { approval_status: verdict.status, stage_data: stageData as any },
      });
    }

    /* REVISION HISTORY — appended to the EXISTING activity audit. Nothing here
     * updates or deletes a prior row, so every cycle of every card survives.
     * 'pending' is not a decision and is deliberately not recorded as one. */
    if (verdict.status !== 'pending') {
      await activityService.logActivity({
        actorUserId: actorId,
        type: 'marketing_content_approval',
        description: `${decisionLabel} — '${row.title}'`,
        metadata: {
          contentId: id,
          status: verdict.status,
          decision: verdict.status,
          decisionLabel,
          revisionNotes: verdict.notes || undefined,
          note: verdict.notes || undefined,
          fromStage: existing.stage,
          toStage: target ?? existing.stage,
          checklistReset: verdict.resetsChecklist,
        },
      });
    }

    // Notification LAST and outside the write path: the business transaction is
    // already durable, so a notification failure can never undo a decision.
    await dispatchApprovalDecision(row, existing.approval_status, verdict.status, verdict.notes || undefined, actorId);

    return res.json({
      success: true,
      content: { ...row, deadline: ymd(row.deadline) },
      checklist: readChecklist(row.stage_data),
    });
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

// ─────────────────────────────────────────────────────────────────────────────
// Admin notification event toggles — ONE settings record, four independent flags.
// Route-gated on an admin-only permission (see marketing.routes), so a Content
// role user cannot change them via a direct API call.
// ─────────────────────────────────────────────────────────────────────────────
export const getContentNotificationSettings = async (_req: Request, res: Response): Promise<any> => {
  try {
    return res.json({ success: true, settings: await getNotificationSettings() });
  } catch (error) {
    console.error('Error reading notification settings:', error);
    return res.status(500).json({ error: 'Failed to read notification settings' });
  }
};

export const putContentNotificationSettings = async (req: Request, res: Response): Promise<any> => {
  try {
    const b = req.body ?? {};
    const keys = ['assignment_enabled', 'stage_enabled', 'approver_enabled', 'decision_enabled'] as const;
    if (!keys.some((k) => typeof b[k] === 'boolean')) {
      return res.status(400).json({ error: 'At least one boolean toggle is required' });
    }
    const before = await getNotificationSettings();
    const settings = await updateNotificationSettings(b);
    await activityService.logActivity({
      actorUserId: uid(req),
      type: 'marketing_notification_settings_updated',
      description: 'Updated Content notification event settings',
      metadata: { before, after: settings },
    });
    return res.json({ success: true, settings });
  } catch (error) {
    console.error('Error updating notification settings:', error);
    return res.status(500).json({ error: 'Failed to update notification settings' });
  }
};

// ---------------------------------------------------------------------------
// GET /marketing/content/list - Content Card table view (M02 Task #7)
// ACTIVE cards only; archived rows are excluded IN THE QUERY, never hidden in
// the browser. Selects only the columns the table renders, and resolves owner
// names in ONE batched query (no N+1).
// ---------------------------------------------------------------------------
export const getContentList = async (req: Request, res: Response): Promise<any> => {
  try {
    // SAME filter builder as the Kanban board — the two views cannot disagree
    // about which cards exist. Only the selected columns differ.
    const where = buildContentCardWhere(req.query as Record<string, unknown>, {
      allStages: ALL_STAGES, platforms: PLATFORMS, priorities: PRIORITIES, formats: FORMATS,
      actorId: uid(req), performanceStages: PERFORMANCE_STAGES,
    });
    const rows = await prisma.marketing_contents.findMany({
      where,
      orderBy: [{ updated_at: 'desc' }],
      select: {
        id: true, content_id: true, title: true, format: true, priority: true,
        platforms: true, platform: true, stage: true, owner_id: true, created_at: true,
        deadline: true, production_data: true, archived: true, objective: true,
        client_id: true,
        // Every assignment column: the list shows the owner, but the Deadline
        // view needs the full team to render "assigned to me".
        designer_id: true, videographer_id: true, editor_id: true,
        scriptwriter_id: true, talent_id: true, approver_id: true,
      },
    });
    // Deadline view: keep only cards that actually HAVE a production deadline,
    // using the same nearestDeadline() every other view displays.
    const withDeadlineOnly = String(req.query.hasDeadline ?? '') === 'true';
    const kept = withDeadlineOnly ? rows.filter(hasAnyDeadline) : rows;

    // ONE batched users query for every assignment on every row — no N+1.
    const names = await userNameMap(kept.flatMap((r) => [
      r.owner_id, r.designer_id, r.videographer_id, r.editor_id,
      r.scriptwriter_id, r.talent_id, r.approver_id,
    ]));
    return res.json({
      success: true,
      contents: kept.map((r) => ({
        id: r.id,
        contentId: r.content_id,
        title: r.title,
        format: r.format,
        priority: r.priority,
        // Fall back to the legacy single column so pre-M02 rows still show a platform.
        platforms: r.platforms?.length ? r.platforms : (r.platform ? [r.platform] : []),
        stage: r.stage,
        stageLabel: STAGE_LABELS[r.stage] ?? r.stage,
        objective: r.objective,
        clientId: r.client_id,
        ownerId: r.owner_id,
        ownerName: r.owner_id ? names[r.owner_id] ?? null : null,
        nearestDeadline: nearestDeadline(r),
        createdAt: r.created_at,
        archived: r.archived,
      })),
    });
  } catch (error) {
    console.error('Error fetching content list:', error);
    return res.status(500).json({ error: 'Failed to fetch content list' });
  }
};

// ---------------------------------------------------------------------------
// Admin reference data (Client/Brand, Category, Pillar, Campaign)
// Read is available to anyone who can see Content (the dropdowns need it);
// writes require the admin settings permission, enforced server-side.
// ---------------------------------------------------------------------------
const asRefTable = (v: unknown): ReferenceTable | null =>
  typeof v === 'string' && (REFERENCE_TABLES as readonly string[]).includes(v) ? (v as ReferenceTable) : null;

export const getReferenceData = async (req: Request, res: Response): Promise<any> => {
  try {
    const includeInactive = String(req.query.includeInactive ?? '') === 'true';
    const one = asRefTable(req.query.table);
    if (one) return res.json({ success: true, [one]: await listReference(one, includeInactive) });
    // Default: every list in ONE request, so the form does not fire four calls.
    const lists = await Promise.all(REFERENCE_TABLES.map((t) => listReference(t, includeInactive)));
    const payload: Record<string, unknown> = { success: true };
    REFERENCE_TABLES.forEach((t, i) => { payload[t] = lists[i]; });
    return res.json(payload);
  } catch (error) {
    console.error('Error fetching marketing reference data:', error);
    return res.status(500).json({ error: 'Failed to fetch reference data' });
  }
};

export const postReferenceItem = async (req: Request, res: Response): Promise<any> => {
  try {
    const table = asRefTable(req.params.table);
    if (!table) return res.status(400).json({ error: 'Unknown reference list' });
    const name = String(req.body?.name ?? '').trim();
    if (!name) return res.status(400).json({ error: 'Name is required', errors: [{ field: 'name', message: 'Name is required' }] });
    const item = await createReference(table, name, Number(req.body?.sort_order) || 0);
    // A new value must be selectable immediately, not after the cache expires.
    invalidateActiveReferenceCache(table);
    await activityService.logActivity({
      actorUserId: uid(req),
      type: 'marketing_reference_created',
      description: `Added '${item.name}' to the ${table} reference list`,
      metadata: { table, referenceId: item.id, name: item.name },
    });
    return res.status(201).json({ success: true, item });
  } catch (error: any) {
    if (error?.code === 'P2002') return res.status(409).json({ error: 'That name already exists in this list' });
    console.error('Error creating reference item:', error);
    return res.status(500).json({ error: 'Failed to create reference item' });
  }
};

export const putReferenceItem = async (req: Request, res: Response): Promise<any> => {
  try {
    const table = asRefTable(req.params.table);
    const id = Number(req.params.id);
    if (!table) return res.status(400).json({ error: 'Unknown reference list' });
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid id' });
    const before = (await listReference(table, true)).find((x) => x.id === id) ?? null;
    const item = await updateReference(table, id, req.body ?? {});
    // Deactivation must stop NEW selections at once.
    invalidateActiveReferenceCache(table);
    const deactivated = before?.active === true && item.active === false;
    const reactivated = before?.active === false && item.active === true;
    await activityService.logActivity({
      actorUserId: uid(req),
      type: 'marketing_reference_updated',
      description: deactivated
        ? `Deactivated '${item.name}' in the ${table} reference list`
        : reactivated
          ? `Reactivated '${item.name}' in the ${table} reference list`
          : `Updated '${item.name}' in the ${table} reference list`,
      // Before/after context, so the log explains WHAT changed.
      metadata: {
        table, referenceId: id,
        before: before ? { name: before.name, active: before.active } : null,
        after: { name: item.name, active: item.active },
      },
    });
    return res.json({ success: true, item });
  } catch (error: any) {
    if (error?.code === 'P2025') return res.status(404).json({ error: 'Reference item not found' });
    if (error?.code === 'P2002') return res.status(409).json({ error: 'That name already exists in this list' });
    console.error('Error updating reference item:', error);
    return res.status(500).json({ error: 'Failed to update reference item' });
  }
};

// ---------------------------------------------------------------------------
// PATCH /marketing/content/:id/readiness - flip a workflow gate (M03 #12/#14)
// Body: { gate: 'strategy' | 'copy', ready: boolean }
// Records WHO and WHEN. Never deletes Strategy or Copy content.
// ---------------------------------------------------------------------------
export const setContentReadiness = async (req: Request, res: Response): Promise<any> => {
  try {
    const id = Number(req.params.id);
    const gate = String(req.body?.gate ?? '');
    const ready = req.body?.ready;
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid content id' });
    if (gate !== 'strategy' && gate !== 'copy' && gate !== 'production') {
      return res.status(400).json({ error: "gate must be 'strategy', 'copy' or 'production'" });
    }
    if (typeof ready !== 'boolean') return res.status(400).json({ error: 'ready must be true or false' });

    const existing = await prisma.marketing_contents.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: 'Content not found' });

    const ctx = await getSalesAuth(req);
    const card = existing as unknown as WorkflowCard;
    const denial = gate === 'strategy'
      ? checkStrategyReady(ctx, card, ready)
      : gate === 'copy'
        ? checkCopyReady(ctx, card, ready)
        // Reel/Video additionally require a Final Deadline — enforced here, so a
        // direct API call cannot bypass it.
        : checkProductionReady(ctx, existing as any, ready);
    if (denial) return res.status(denial.status).json({ error: denial.message });

    const actorId = uid(req);
    const now = new Date();
    // Only the gate's own three columns are written - no other field is touched.
    const data = gate === 'strategy'
      ? { strategy_ready: ready, strategy_ready_by: ready ? actorId || null : null, strategy_ready_at: ready ? now : null }
      : gate === 'copy'
        ? { copy_ready: ready, copy_ready_by: ready ? actorId || null : null, copy_ready_at: ready ? now : null }
        : { production_ready: ready, production_ready_by: ready ? actorId || null : null, production_ready_at: ready ? now : null };
    const row = await prisma.marketing_contents.update({ where: { id }, data });

    await activityService.logActivity({
      actorUserId: actorId,
      type: ready ? `marketing_${gate}_marked_ready` : `marketing_${gate}_unmarked_ready`,
      description: `${ready ? 'Marked' : 'Unmarked'} ${gate === 'strategy' ? 'Strategy' : gate === 'copy' ? 'Copy' : 'Production'} as Ready on '${row.title}'`,
      metadata: { contentId: id, gate, ready },
    });
    return res.json({ success: true, content: { ...row, deadline: ymd(row.deadline) } });
  } catch (error) {
    console.error('Error updating content readiness:', error);
    return res.status(500).json({ error: 'Failed to update readiness' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// M04 #27 — Work Output links: /marketing/content/:id/work-outputs
//
// Authorship and timestamps are SERVER-DERIVED: `added_by` comes from the
// authenticated session and `created_at` from the database default, so neither
// can be spoofed by the client. Every handler re-loads the row and verifies it
// belongs to the card in the URL, which closes id-manipulation across cards.
// ─────────────────────────────────────────────────────────────────────────────
const serializeWorkOutput = (row: any, names: Record<number, string>) => ({
  id: row.id,
  contentId: row.content_id,
  label: row.label,
  url: row.url,
  addedBy: row.added_by,
  addedByName: row.added_by ? names[row.added_by] ?? null : null,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export const getWorkOutputs = async (req: Request, res: Response): Promise<any> => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid content id' });
    const rows = await prisma.marketing_content_work_outputs.findMany({
      where: { content_id: id },
      orderBy: { created_at: 'desc' },
    });
    const names = await userNameMap(rows.map((r) => r.added_by));
    return res.json({ success: true, workOutputs: rows.map((r) => serializeWorkOutput(r, names)) });
  } catch (error) {
    console.error('Error listing work outputs:', error);
    return res.status(500).json({ error: 'Failed to load Work Output links' });
  }
};

export const addWorkOutput = async (req: Request, res: Response): Promise<any> => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid content id' });
    const card = await prisma.marketing_contents.findUnique({ where: { id } });
    if (!card) return res.status(404).json({ error: 'Content not found' });

    const ctx = await getSalesAuth(req);
    // Assignment on THIS card (or the global production-edit key / Admin) — a
    // global Designer role alone grants nothing on a card they are not on.
    if (!canAddWorkOutput(ctx, card)) {
      return res.status(403).json({ error: 'Only the assigned Designer or Editor can record Work Output on this card' });
    }
    const parsed = validateWorkOutput(req.body ?? {});
    if ('errors' in parsed) return res.status(400).json({ error: parsed.errors[0].message, errors: parsed.errors });

    const row = await prisma.marketing_content_work_outputs.create({
      data: { content_id: id, label: parsed.label, url: parsed.url, added_by: uid(req) },
    });
    // Audited through the EXISTING activity mechanism — no second audit system.
    await activityService.logActivity({
      actorUserId: uid(req),
      type: 'marketing_work_output_added',
      description: `Recorded Work Output '${row.label}' on '${card.title}'`,
      metadata: { contentId: id, workOutputId: row.id, label: row.label, url: row.url },
    });
    const names = await userNameMap([row.added_by]);
    return res.status(201).json({ success: true, workOutput: serializeWorkOutput(row, names) });
  } catch (error) {
    if (isBadReference(error)) return res.status(400).json({ error: BAD_REFERENCE_MSG });
    console.error('Error adding work output:', error);
    return res.status(500).json({ error: 'Failed to record Work Output link' });
  }
};

export const updateWorkOutput = async (req: Request, res: Response): Promise<any> => {
  try {
    const id = Number(req.params.id);
    const workOutputId = Number(req.params.workOutputId);
    if (!Number.isInteger(workOutputId)) return res.status(404).json({ error: 'Work Output not found' });
    const row = await prisma.marketing_content_work_outputs.findUnique({ where: { id: workOutputId } });
    // Belongs-to check FIRST: a link on another card is simply not found here.
    if (!row || row.content_id !== id) return res.status(404).json({ error: 'Work Output not found' });

    const ctx = await getSalesAuth(req);
    if (!canModifyWorkOutput(ctx, row)) {
      return res.status(403).json({ error: 'Only the person who added this Work Output, or an Admin, can change it' });
    }
    const parsed = validateWorkOutput({ label: req.body?.label ?? row.label, url: req.body?.url ?? row.url });
    if ('errors' in parsed) return res.status(400).json({ error: parsed.errors[0].message, errors: parsed.errors });

    // added_by and created_at are NOT in the patch — the original author and
    // creation time survive an edit; only updated_at moves (@updatedAt).
    const updated = await prisma.marketing_content_work_outputs.update({
      where: { id: workOutputId },
      data: { label: parsed.label, url: parsed.url },
    });
    await activityService.logActivity({
      actorUserId: uid(req),
      type: 'marketing_work_output_updated',
      description: `Updated Work Output '${updated.label}'`,
      metadata: { contentId: id, workOutputId, label: updated.label, url: updated.url },
    });
    const names = await userNameMap([updated.added_by]);
    return res.json({ success: true, workOutput: serializeWorkOutput(updated, names) });
  } catch (error) {
    console.error('Error updating work output:', error);
    return res.status(500).json({ error: 'Failed to update Work Output link' });
  }
};

export const deleteWorkOutput = async (req: Request, res: Response): Promise<any> => {
  try {
    const id = Number(req.params.id);
    const workOutputId = Number(req.params.workOutputId);
    if (!Number.isInteger(workOutputId)) return res.status(404).json({ error: 'Work Output not found' });
    const row = await prisma.marketing_content_work_outputs.findUnique({ where: { id: workOutputId } });
    if (!row || row.content_id !== id) return res.status(404).json({ error: 'Work Output not found' });

    const ctx = await getSalesAuth(req);
    if (!canModifyWorkOutput(ctx, row)) {
      return res.status(403).json({ error: 'Only the person who added this Work Output, or an Admin, can remove it' });
    }
    await prisma.marketing_content_work_outputs.delete({ where: { id: workOutputId } });
    await activityService.logActivity({
      actorUserId: uid(req),
      type: 'marketing_work_output_removed',
      description: `Removed Work Output '${row.label}'`,
      metadata: { contentId: id, workOutputId, label: row.label, url: row.url },
    });
    return res.json({ success: true });
  } catch (error) {
    console.error('Error deleting work output:', error);
    return res.status(500).json({ error: 'Failed to remove Work Output link' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// M06 #29 — GET /marketing/content/:id/history
//
// Reads the EXISTING activity_logs rows this controller already writes on every
// stage change; there is no second history table. Entries are append-only —
// nothing here (or in the move path) ever updates or deletes a prior entry, so
// the full chain of moves, including every recorded backward reason, survives.
// ─────────────────────────────────────────────────────────────────────────────
export const getContentHistory = async (req: Request, res: Response): Promise<any> => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid content id' });

    const rows = await prisma.activity_logs.findMany({
      where: {
        type: { in: ['marketing_content_stage_changed', 'marketing_content_stage_blocked'] },
        // JSONB equality on the contentId the move path writes.
        metadata: { path: ['contentId'], equals: id },
      },
      orderBy: { created_at: 'desc' },
      select: { id: true, actor_user_id: true, type: true, description: true, metadata: true, created_at: true },
    });
    const names = await userNameMap(rows.map((r) => r.actor_user_id));
    return res.json({
      success: true,
      history: rows.map((r) => {
        const m = (r.metadata ?? {}) as { from?: string; to?: string; reason?: string; denied?: string };
        return {
          id: r.id,
          blocked: r.type === 'marketing_content_stage_blocked',
          from: m.from ?? null,
          fromLabel: m.from ? STAGE_LABELS[m.from] ?? m.from : null,
          to: m.to ?? null,
          toLabel: m.to ? STAGE_LABELS[m.to] ?? m.to : null,
          reason: m.reason ?? null,
          denied: m.denied ?? null,
          actorId: r.actor_user_id,
          actorName: names[r.actor_user_id] ?? null,
          createdAt: r.created_at,
        };
      }),
    });
  } catch (error) {
    console.error('Error fetching content stage history:', error);
    return res.status(500).json({ error: 'Failed to load stage history' });
  }
};


// -----------------------------------------------------------------------------
// M07 #34 - internal review checklist
//   GET   /marketing/content/:id/review-checklist
//   PATCH /marketing/content/:id/review-checklist   { item, checked }
//
// CURRENT state lives in stage_data.review.checklist; every tick also appends an
// immutable activity_logs row. Resetting the checklist for a new review cycle
// empties the former and never touches the latter.
// -----------------------------------------------------------------------------
const serializeChecklist = (stageData: unknown, names: Record<number, string>) => {
  const current = readChecklist(stageData);
  return {
    items: REVIEW_CHECKLIST_ITEMS.map((i) => {
      const st = current[i.key];
      return {
        key: i.key,
        label: i.label,
        checked: st?.checked === true,
        checkedBy: st?.by ?? null,
        checkedByName: st?.by ? names[st.by] ?? null : null,
        checkedAt: st?.at ?? null,
      };
    }),
    complete: isChecklistComplete(current),
  };
};

export const getReviewChecklist = async (req: Request, res: Response): Promise<any> => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid content id' });
    const card = await prisma.marketing_contents.findUnique({
      where: { id },
      select: { id: true, stage: true, stage_data: true, approver_id: true },
    });
    if (!card) return res.status(404).json({ error: 'Content not found' });

    const current = readChecklist(card.stage_data);
    const names = await userNameMap(Object.values(current).map((v) => v?.by ?? null));
    return res.json({
      success: true,
      stage: card.stage,
      applies: card.stage === STAGE_REVIEW,
      ...serializeChecklist(card.stage_data, names),
    });
  } catch (error) {
    console.error('Error loading review checklist:', error);
    return res.status(500).json({ error: 'Failed to load the review checklist' });
  }
};

export const setReviewChecklistItem = async (req: Request, res: Response): Promise<any> => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid content id' });
    const item = req.body?.item;
    const checked = req.body?.checked;
    if (!isReviewChecklistKey(item)) {
      return res.status(400).json({
        error: `Unknown checklist item. Expected one of: ${REVIEW_CHECKLIST_ITEMS.map((i) => i.key).join(', ')}`,
      });
    }
    if (typeof checked !== 'boolean') return res.status(400).json({ error: 'checked must be true or false' });

    const card = await prisma.marketing_contents.findUnique({ where: { id } });
    if (!card) return res.status(404).json({ error: 'Content not found' });

    const ctx = await getSalesAuth(req);
    // Stage AND authorization are both re-checked against the persisted row.
    const denial = checkChecklistEditable(ctx, card as any);
    if (denial) return res.status(denial.status).json({ error: denial.message });

    const actorId = uid(req);
    const nowIso = new Date().toISOString();
    const stageData = writeChecklistItem(card.stage_data, item, checked, actorId, nowIso);
    const row = await prisma.marketing_contents.update({
      where: { id },
      data: { stage_data: stageData as any },
    });

    // Append-only audit of the tick itself - retained even after the current
    // checklist is reset by a Changes Requested / Rejected outcome.
    await activityService.logActivity({
      actorUserId: actorId,
      type: 'marketing_content_review_check',
      description: `${checked ? 'Checked' : 'Unchecked'} '${reviewItemLabel(item)}' on '${card.title}'`,
      metadata: { contentId: id, item, itemLabel: reviewItemLabel(item), checked, at: nowIso },
    });

    const current = readChecklist(row.stage_data);
    const names = await userNameMap(Object.values(current).map((v) => v?.by ?? null));
    return res.json({
      success: true,
      stage: row.stage,
      applies: row.stage === STAGE_REVIEW,
      ...serializeChecklist(row.stage_data, names),
    });
  } catch (error) {
    console.error('Error updating review checklist:', error);
    return res.status(500).json({ error: 'Failed to update the review checklist' });
  }
};

// -----------------------------------------------------------------------------
// M07 #37 - GET /marketing/content/:id/revisions
//
// Read-only projection of the append-only approval entries in activity_logs.
// There is deliberately NO write/update/delete route for this resource, for any
// role: the log is evidence, not editable content.
// -----------------------------------------------------------------------------
export const getRevisionHistory = async (req: Request, res: Response): Promise<any> => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid content id' });

    const rows = await prisma.activity_logs.findMany({
      where: {
        type: { in: ['marketing_content_approval', 'marketing_content_review_check', 'marketing_content_response_note'] },
        metadata: { path: ['contentId'], equals: id },
      },
      orderBy: { created_at: 'desc' },
      select: { id: true, actor_user_id: true, type: true, metadata: true, created_at: true },
    });
    const names = await userNameMap(rows.map((r) => r.actor_user_id));

    // M09 #40 — an owner response note is its own revision entry, interleaved
    // with the approver decisions in one chronological log. It never replaces or
    // rewrites a decision entry.
    const decisions = rows.filter((r) => r.type === 'marketing_content_approval' || r.type === 'marketing_content_response_note');
    const checks = rows.filter((r) => r.type === 'marketing_content_review_check');
    return res.json({
      success: true,
      revisions: decisions.map((r) => {
        const m = (r.metadata ?? {}) as Record<string, unknown>;
        const isResponse = r.type === 'marketing_content_response_note';
        const status = isResponse ? 'response_note' : String(m.status ?? m.decision ?? '');
        return {
          id: r.id,
          entryType: isResponse ? 'response_note' : 'decision',
          decision: status,
          decisionLabel: isResponse
            ? 'Response Note'
            : (DECISION_LABELS as Record<string, string>)[status] ?? status,
          revisionNotes: (m.responseNote ?? m.revisionNotes ?? m.note ?? null) as string | null,
          fromStage: (m.fromStage ?? null) as string | null,
          toStage: (m.toStage ?? null) as string | null,
          checklistReset: m.checklistReset === true,
          approverId: r.actor_user_id,
          approverName: names[r.actor_user_id] ?? null,
          createdAt: r.created_at,
        };
      }),
      // The checklist AUDIT is a separate concept from the revision log and is
      // returned separately rather than merged into it.
      checklistAudit: checks.map((r) => {
        const m = (r.metadata ?? {}) as Record<string, unknown>;
        return {
          id: r.id,
          item: (m.item ?? null) as string | null,
          itemLabel: (m.itemLabel ?? null) as string | null,
          checked: m.checked === true,
          actorId: r.actor_user_id,
          actorName: names[r.actor_user_id] ?? null,
          createdAt: r.created_at,
        };
      }),
    });
  } catch (error) {
    console.error('Error loading revision history:', error);
    return res.status(500).json({ error: 'Failed to load revision history' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// M08 #38 — PATCH /marketing/content/:id/schedule
//
// Saves the scheduling record and, when `markScheduled` is set, moves the card
// to Stage 8 through the SAME applyStageMove service every other transition
// uses. Nothing is posted to any external platform: this records intent inside
// the ERP only.
// ─────────────────────────────────────────────────────────────────────────────
export const setContentSchedule = async (req: Request, res: Response): Promise<any> => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid content id' });
    const existing = await prisma.marketing_contents.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: 'Content not found' });

    const ctx = await getSalesAuth(req);
    if (!canScheduleContent(ctx)) {
      return res.status(403).json({ error: 'You do not have permission to schedule content.' });
    }

    const sd = (existing.stage_data as any) ?? {};
    const merged = mergeScheduleData(sd.schedule, req.body?.scheduleData ?? req.body, PLATFORMS);
    if (merged.errors.length) {
      return res.status(400).json({ error: merged.errors[0].message, errors: merged.errors });
    }

    const markScheduled = req.body?.markScheduled === true;
    if (markScheduled) {
      // Validated against the MERGED schedule, so the date supplied in this same
      // request counts — but a schedule missing it anywhere is refused.
      const denial = checkScheduleReady(ctx, merged.data);
      if (denial) return res.status(denial.status).json({ error: denial.message });
      merged.data.scheduled = true;
      merged.data.scheduledAt = new Date().toISOString();
      merged.data.scheduledBy = uid(req);
    }

    const stageData = { ...sd, schedule: merged.data };
    let row: any;

    if (markScheduled && existing.stage !== SCHEDULED_STAGE) {
      // Stage change owned by the shared service; the scheduling columns ride
      // along in the same UPDATE so the card cannot be moved-but-unscheduled.
      const result = await applyStageMove(existing as any, SCHEDULED_STAGE, {
        actorId: uid(req),
        reason: 'Marked as Scheduled',
        isAdmin: ctx.isAdmin,
        extraData: { stage_data: stageData },
        auditDescription: `Scheduled '${existing.title}' for ${merged.data.date}${merged.data.time ? ` ${merged.data.time}` : ''}`,
        auditMetadata: { scheduledDate: merged.data.date, scheduledTime: merged.data.time ?? null, platforms: merged.data.platforms ?? [] },
      });
      if (result.denial) return res.status(result.denial.status).json({ error: result.denial.message });
      row = result.card;
    } else {
      row = await prisma.marketing_contents.update({ where: { id }, data: { stage_data: stageData as any } });
    }

    return res.json({ success: true, content: { ...row, deadline: ymd(row.deadline) } });
  } catch (error) {
    console.error('Error saving content schedule:', error);
    return res.status(500).json({ error: 'Failed to save the scheduling record' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// M08 #39 — PATCH /marketing/content/:id/publish
//
// Records the publication: per-platform links, the ACTUAL published timestamp
// from the server clock, and the Stage 8 → Stage 9 move. The scheduling record
// is preserved untouched, so the card still shows what was planned alongside
// what actually happened.
// ─────────────────────────────────────────────────────────────────────────────
export const markContentPublished = async (req: Request, res: Response): Promise<any> => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid content id' });
    const existing = await prisma.marketing_contents.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: 'Content not found' });

    const ctx = await getSalesAuth(req);
    // Authorization, the CURRENT persisted stage and already-published state are
    // all checked before anything is written — this is what makes a stale tab
    // and a double click both safe.
    const denial = checkPublishReady(ctx, existing as any);
    if (denial) return res.status(denial.status).json({ error: denial.message });

    const sd = (existing.stage_data as any) ?? {};
    const links = mergePublishedLinks(sd.published, req.body?.publishedLinks ?? req.body?.publishedData, PLATFORMS);
    if (links.errors.length) {
      return res.status(400).json({ error: links.errors[0].message, errors: links.errors });
    }

    const actorId = uid(req);
    // publishedAt is the SERVER clock; any client-sent value is ignored, and an
    // existing record is returned unchanged by buildPublishRecord.
    const publishRecord = buildPublishRecord(sd.publishRecord, actorId, new Date().toISOString());
    // schedule is spread through untouched — publishing ADDS to the card.
    const stageData = { ...sd, published: links.data, publishRecord };

    const result = await applyStageMove(existing as any, PUBLISHED_STAGE, {
      actorId,
      reason: 'Marked as Published',
      isAdmin: ctx.isAdmin,
      extraData: { stage_data: stageData },
      auditDescription: `Published '${existing.title}'`,
      auditMetadata: {
        publishedAt: publishRecord.publishedAt,
        platforms: Object.entries(links.data).filter(([, v]) => v?.done || v?.url).map(([k]) => k),
      },
    });
    if (result.denial) return res.status(result.denial.status).json({ error: result.denial.message });

    const row = result.card as any;
    return res.json({ success: true, content: { ...row, deadline: ymd(row.deadline) }, publishRecord });
  } catch (error) {
    console.error('Error marking content as published:', error);
    return res.status(500).json({ error: 'Failed to record the publication' });
  }
};


// -----------------------------------------------------------------------------
// M09 #40 - PATCH /marketing/content/:id/resubmit   { responseNote? }
//
// The Content Owner sends a card back to Review after acting on a Changes
// Requested decision, optionally explaining what they changed. The note is
// OPTIONAL: an empty one is simply not recorded, and never blocks the move.
// -----------------------------------------------------------------------------
export const resubmitForReview = async (req: Request, res: Response): Promise<any> => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid content id' });
    const existing = await prisma.marketing_contents.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: 'Content not found' });

    const ctx = await getSalesAuth(req);
    // Owner identity, the CURRENT stage and the fact that changes were actually
    // requested are all read from the persisted row.
    const denial = checkResubmit(ctx, existing as any);
    if (denial) return res.status(denial.status).json({ error: denial.message });

    const responseNote = typeof req.body?.responseNote === 'string' ? req.body.responseNote.trim() : '';
    const actorId = uid(req);

    // The stage move goes through the shared service. Because it updates
    // conditionally on the stage we validated, a double-clicked resubmit moves
    // the card once - the second request finds no matching row and is rejected
    // before any response note is written, so no duplicate entry is possible.
    const result = await applyStageMove(existing as any, STAGE_REVIEW, {
      actorId,
      reason: responseNote || 'Resubmitted for review',
      isAdmin: ctx.isAdmin,
      auditDescription: `Resubmitted '${existing.title}' for review`,
      auditMetadata: { resubmitted: true, ...(responseNote ? { responseNote } : {}) },
    });
    if (result.denial) return res.status(result.denial.status).json({ error: result.denial.message });

    // A SEPARATE revision entry, appended after the move succeeded. Empty notes
    // create nothing - there is no blank history row.
    if (responseNote) {
      await activityService.logActivity({
        actorUserId: actorId,
        type: 'marketing_content_response_note',
        description: `Response note on '${existing.title}'`,
        metadata: {
          contentId: id,
          responseNote,
          fromStage: existing.stage,
          toStage: STAGE_REVIEW,
        },
      });
    }

    const row = result.card as any;
    return res.json({ success: true, content: { ...row, deadline: ymd(row.deadline) }, responseNoteRecorded: !!responseNote });
  } catch (error) {
    console.error('Error resubmitting content for review:', error);
    return res.status(500).json({ error: 'Failed to resubmit the card for review' });
  }
};

// -----------------------------------------------------------------------------
// M09 #41 - PATCH /marketing/content/:id/metrics
//
// Dedicated performance endpoint. It exists so the stage gate and the
// has_performance_data flag are applied on ONE path; the generic update
// endpoint routes its `metrics` payload through the same service.
// -----------------------------------------------------------------------------
export const setContentMetrics = async (req: Request, res: Response): Promise<any> => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid content id' });
    const existing = await prisma.marketing_contents.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: 'Content not found' });

    const ctx = await getSalesAuth(req);
    const denial = checkPerformanceEditable(ctx, existing as any);
    if (denial) return res.status(denial.status).json({ error: denial.message });

    const merged = mergeMetrics(existing.metrics, req.body?.metrics ?? req.body, existing.format);
    if (merged.errors.length) {
      return res.status(400).json({ error: merged.errors[0].message, errors: merged.errors });
    }

    const row = await prisma.marketing_contents.update({
      where: { id },
      data: {
        metrics: merged.data as any,
        // Maintained by the SAME rule the Awaiting Performance Data filter reads.
        has_performance_data: hasPerformanceData(merged.data),
      },
    });
    return res.json({
      success: true,
      content: { ...row, deadline: ymd(row.deadline) },
      hasPerformanceData: row.has_performance_data,
    });
  } catch (error) {
    console.error('Error saving performance metrics:', error);
    return res.status(500).json({ error: 'Failed to save performance data' });
  }
};

/** Field definitions for the UI, filtered to the card's Content Type. */
export const getPerformanceSchema = async (req: Request, res: Response): Promise<any> => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid content id' });
    const card = await prisma.marketing_contents.findUnique({
      where: { id },
      select: { id: true, stage: true, format: true, metrics: true, has_performance_data: true },
    });
    if (!card) return res.status(404).json({ error: 'Content not found' });
    return res.json({
      success: true,
      stage: card.stage,
      // Watch Time is filtered out server-side for non-shoot types, so the UI
      // cannot render it for a Poster even if it wanted to.
      metrics: PERFORMANCE_METRICS
        .filter((m) => metricApplies(m, card.format))
        .map((m) => ({ key: m.key, label: m.label, unit: (m as any).unit ?? null, currency: (m as any).currency === true })),
      notesKey: NOTES_KEY,
      editable: PERFORMANCE_STAGES.includes(card.stage),
      hasPerformanceData: card.has_performance_data,
    });
  } catch (error) {
    console.error('Error loading performance schema:', error);
    return res.status(500).json({ error: 'Failed to load the performance fields' });
  }
};


// -----------------------------------------------------------------------------
// M10 #46 - GET /marketing/audit
//
// Read-only projection of the EXISTING activity_logs rows this module already
// writes. There is deliberately no create/update/delete route: the log is
// append-only evidence, and every entry was generated server-side with the
// actor taken from the session and the timestamp from the database default.
// -----------------------------------------------------------------------------
const AUDIT_TYPES: Record<string, string> = {
  marketing_content_stage_changed: 'Stage changed',
  marketing_content_stage_blocked: 'Stage change blocked',
  marketing_content_approval: 'Approval decision',
  marketing_content_response_note: 'Response note',
  marketing_content_review_check: 'Review checklist',
  marketing_work_output_added: 'Work Output added',
  marketing_work_output_updated: 'Work Output updated',
  marketing_work_output_removed: 'Work Output removed',
  marketing_content_created: 'Content created',
  marketing_content_deleted: 'Content deleted',
  marketing_reference_created: 'Reference created',
  marketing_reference_updated: 'Reference updated',
  marketing_notification_settings_updated: 'Notification settings updated',
  user_created: 'User created',
  user_updated: 'User updated',
  user_deleted: 'User removed',
};

export const getMarketingAuditLog = async (req: Request, res: Response): Promise<any> => {
  try {
    const q = req.query as Record<string, unknown>;
    const take = Math.min(Math.max(Number(q.limit) || 100, 1), 500);
    const skip = Math.max(Number(q.offset) || 0, 0);

    const where: Record<string, unknown> = {};
    const type = typeof q.type === 'string' ? q.type.trim() : '';
    if (type && type !== 'all' && AUDIT_TYPES[type]) where.type = type;
    else where.type = { in: Object.keys(AUDIT_TYPES) };

    const actorId = Number(q.actorId);
    if (Number.isInteger(actorId) && actorId > 0) where.actor_user_id = actorId;

    const contentId = Number(q.contentId);
    if (Number.isInteger(contentId) && contentId > 0) {
      where.metadata = { path: ['contentId'], equals: contentId };
    }

    // Filtered and paginated in the DATABASE - the log grows without bound, so
    // it is never pulled into memory to be sliced.
    const [rows, total] = await Promise.all([
      prisma.activity_logs.findMany({
        where, orderBy: { created_at: 'desc' }, take, skip,
        select: { id: true, actor_user_id: true, type: true, description: true, metadata: true, created_at: true },
      }),
      prisma.activity_logs.count({ where }),
    ]);
    // ONE batched users query for the whole page - no N+1.
    const names = await userNameMap(rows.map((r) => r.actor_user_id));

    return res.json({
      success: true,
      total,
      limit: take,
      offset: skip,
      types: Object.entries(AUDIT_TYPES).map(([key, label]) => ({ key, label })),
      entries: rows.map((r) => {
        const m = (r.metadata ?? {}) as Record<string, unknown>;
        return {
          id: r.id,
          type: r.type,
          typeLabel: AUDIT_TYPES[r.type] ?? r.type,
          description: r.description,
          actorId: r.actor_user_id,
          actorName: names[r.actor_user_id] ?? null,
          contentId: (m.contentId ?? null) as number | null,
          fromStage: (m.from ?? m.fromStage ?? null) as string | null,
          fromStageLabel: m.from || m.fromStage ? stageLabel(String(m.from ?? m.fromStage)) : null,
          toStage: (m.to ?? m.toStage ?? null) as string | null,
          toStageLabel: m.to || m.toStage ? stageLabel(String(m.to ?? m.toStage)) : null,
          decision: (m.decision ?? m.status ?? null) as string | null,
          notes: (m.revisionNotes ?? m.responseNote ?? m.reason ?? m.note ?? null) as string | null,
          createdAt: r.created_at,
        };
      }),
    });
  } catch (error) {
    console.error('Error loading marketing audit log:', error);
    return res.status(500).json({ error: 'Failed to load the audit log' });
  }
};

// -----------------------------------------------------------------------------
// M10 #47/#48 - CSV exports
//
// Both reuse buildContentCardWhere, so an export returns EXACTLY the rows the
// corresponding view shows for the same query string - the same archived rule,
// the same filters, the same "My Cards" scoping resolved from the session.
// The full filtered set is exported, never just a page, but the query is still
// filtered in the database rather than in memory.
// -----------------------------------------------------------------------------
const EXPORT_ROW_CAP = 20000;

async function loadExportRows(req: Request, withDeadlineOnly: boolean) {
  const where = buildContentCardWhere(req.query as Record<string, unknown>, {
    allStages: ALL_STAGES, platforms: PLATFORMS, priorities: PRIORITIES, formats: FORMATS,
    actorId: uid(req), performanceStages: PERFORMANCE_STAGES,
  });
  const rows = await prisma.marketing_contents.findMany({
    where,
    orderBy: [{ updated_at: 'desc' }],
    take: EXPORT_ROW_CAP,
    // Header-level columns only: script, production detail and revision notes
    // are deliberately NOT selected, so they cannot leak into an export.
    select: {
      id: true, content_id: true, title: true, format: true, priority: true,
      platforms: true, platform: true, stage: true, objective: true,
      owner_id: true, created_by: true, created_at: true,
      deadline: true, production_data: true,
      client_id: true, category_id: true, pillar_id: true, campaign_id: true,
    },
  });
  const kept = withDeadlineOnly ? rows.filter(hasAnyDeadline) : rows;

  // Resolve every lookup with ONE query per table for the whole export.
  const [names, clients, categories, pillars, campaigns] = await Promise.all([
    userNameMap(kept.flatMap((r) => [r.owner_id, r.created_by])),
    prisma.marketing_clients.findMany({ select: { id: true, name: true } }),
    prisma.marketing_categories.findMany({ select: { id: true, name: true } }),
    prisma.marketing_pillars.findMany({ select: { id: true, name: true } }),
    prisma.marketing_campaigns.findMany({ select: { id: true, name: true } }),
  ]);
  const map = (list: { id: number; name: string }[]) => Object.fromEntries(list.map((x) => [x.id, x.name]));
  return {
    rows: kept,
    names,
    refs: { clients: map(clients), categories: map(categories), pillars: map(pillars), campaigns: map(campaigns) },
    truncated: rows.length >= EXPORT_ROW_CAP,
  };
}

type ExportRow = Awaited<ReturnType<typeof loadExportRows>>['rows'][number];

export const exportContentCardsCsv = async (req: Request, res: Response): Promise<any> => {
  try {
    const { rows, names, refs } = await loadExportRows(req, false);
    const nameOf = (id: number | null) => (id ? names[id] ?? null : null);
    const columns: CsvColumn<ExportRow>[] = [
      { header: 'Content ID', value: (r) => r.content_id },
      { header: 'Title', value: (r) => r.title },
      { header: 'Content Type', value: (r) => r.format },
      { header: 'Category', value: (r) => (r.category_id ? refs.categories[r.category_id] ?? null : null) },
      // Multi-value column joined with a separator that is NOT the delimiter.
      { header: 'Platform(s)', value: (r) => (r.platforms?.length ? r.platforms.join('; ') : r.platform) },
      { header: 'Priority', value: (r) => r.priority },
      { header: 'Objective', value: (r) => r.objective },
      { header: 'Pillar', value: (r) => (r.pillar_id ? refs.pillars[r.pillar_id] ?? null : null) },
      { header: 'Client / Brand', value: (r) => (r.client_id ? refs.clients[r.client_id] ?? null : null) },
      { header: 'Campaign', value: (r) => (r.campaign_id ? refs.campaigns[r.campaign_id] ?? null : null) },
      { header: 'Content Owner', value: (r) => nameOf(r.owner_id) },
      { header: 'Current Stage', value: (r) => stageLabel(r.stage) },
      { header: 'Nearest Deadline', value: (r) => nearestDeadline(r) },
      { header: 'Created By', value: (r) => nameOf(r.created_by) },
      { header: 'Created Date', value: (r) => (r.created_at ? r.created_at.toISOString().slice(0, 10) : null) },
    ];
    return sendCsv(res, 'content_cards_export', toCsv(rows, columns));
  } catch (error) {
    console.error('Error exporting content cards CSV:', error);
    return res.status(500).json({ error: 'Failed to export the content cards' });
  }
};

export const exportDeadlinesCsv = async (req: Request, res: Response): Promise<any> => {
  try {
    // Same dataset rule as the Deadline view: only cards that actually have a
    // production deadline, decided by the SAME nearestDeadline function.
    const { rows, names, refs } = await loadExportRows(req, true);
    const columns: CsvColumn<ExportRow>[] = [
      { header: 'Content ID', value: (r) => r.content_id },
      { header: 'Title', value: (r) => r.title },
      { header: 'Content Type', value: (r) => r.format },
      { header: 'Content Owner', value: (r) => (r.owner_id ? names[r.owner_id] ?? null : null) },
      { header: 'Client / Brand', value: (r) => (r.client_id ? refs.clients[r.client_id] ?? null : null) },
      { header: 'Nearest Deadline', value: (r) => nearestDeadline(r) },
      // The Final Deadline is the content-type-specific one from the M04
      // production briefing - resolved by the shared finalDeadlineFor helper.
      { header: 'Final Deadline', value: (r) => finalDeadlineFor(r) },
      { header: 'Current Stage', value: (r) => stageLabel(r.stage) },
    ];
    return sendCsv(res, 'deadline_list_export', toCsv(rows, columns));
  } catch (error) {
    console.error('Error exporting deadlines CSV:', error);
    return res.status(500).json({ error: 'Failed to export the deadline list' });
  }
};
