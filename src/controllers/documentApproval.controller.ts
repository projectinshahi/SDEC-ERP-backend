import { Request, Response } from 'express';
import multer from 'multer';
import { v2 as cloudinary } from 'cloudinary';
import prisma from '../config/db.js';
import { activityService } from '../services/activity.service.js';
import { notificationService } from '../services/notification.service.js';
import { getSalesAuth, isManager } from '../utils/salesAuth.js';

/**
 * SE-022 — Document Approval Workflow.
 *
 *   SE-022.1  Submit a customer-facing document for approval (BDE)
 *   SE-022.2  Manager approves / rejects / requests rework (comments mandatory
 *             for reject & rework) with a full audit trail
 *   SE-022.3  Approval gate — a document can only be "sent to client" once it is
 *             approved; pending/rejected/rework documents are blocked.
 *
 * Reuses the Cloudinary upload pattern (memory storage → stream) and the shared
 * notification + activity-log services.
 */

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const storage = multer.memoryStorage();
export const approvalUpload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } });

const VALID_DOC_TYPES = ['BRD', 'Proposal', 'Quotation', 'Scope', 'Agreement', 'Other'];

// Server-side upload guard (matches the blocker/bug attachment standard): reject
// executable/script files outright. The client UI additionally restricts the
// picker to the document/image allow-list (PDF, DOC(X), XLS(X), PPT(X), JPG, PNG).
const BLOCKED_EXTENSIONS = ['.exe', '.bat', '.msi', '.sh', '.cmd', '.js', '.vbs', '.dll', '.scr', '.jar'];
function extensionOf(filename: string): string {
  const i = filename.lastIndexOf('.');
  return i >= 0 ? filename.slice(i).toLowerCase() : '';
}
/** Returns a 400 error message if the file extension is blocked, else null. */
function blockedFileError(file: Express.Multer.File): string | null {
  const ext = extensionOf(file.originalname);
  return BLOCKED_EXTENSIONS.includes(ext) ? `File type ${ext} is not allowed.` : null;
}

const approvalSelect = {
  id: true,
  docType: true,
  title: true,
  version: true,
  changeNotes: true,
  comments: true,
  fileName: true,
  fileUrl: true,
  fileSize: true,
  status: true,
  managerComments: true,
  decisionAt: true,
  sentToClient: true,
  sentAt: true,
  leadId: true,
  dealId: true,
  submittedById: true,
  reviewedById: true,
  createdAt: true,
  updatedAt: true,
  submittedBy: { select: { id: true, name: true, email: true } },
  reviewedBy: { select: { id: true, name: true } },
  lead: { select: { id: true, title: true } },
  deal: { select: { id: true, title: true } },
} as const;

/** Streams a Multer memory file to Cloudinary; returns the secure URL. */
async function uploadToCloudinary(file: Express.Multer.File): Promise<string> {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        resource_type: 'auto',
        folder: 'erp_document_approvals',
        public_id: `${Date.now()}-${file.originalname.replace(/[^a-zA-Z0-9-_.]/g, '')}`,
      },
      (error, result) => (error ? reject(error) : resolve((result as any).secure_url)),
    );
    stream.end(file.buffer);
  });
}

/** Active Sales Managers + Admins — approval recipients. */
async function getApproverIds(): Promise<number[]> {
  const managers = await prisma.users.findMany({
    where: {
      status: 'active',
      OR: [
        { role: { contains: 'admin', mode: 'insensitive' } },
        { role: { contains: 'manager', mode: 'insensitive' } },
      ],
    },
    select: { id: true },
  });
  return managers.map((m) => m.id);
}

/**
 * GET /sales/approvals — list approvals. Filters: dealId, leadId, status,
 * scope=mine|queue. Non-managers are restricted to their own submissions unless
 * they scope to a specific record.
 */
export const getApprovals = async (req: Request, res: Response) => {
  try {
    const ctx = await getSalesAuth(req);
    const { dealId, leadId, status, scope } = req.query;

    const where: any = {};
    if (dealId && !isNaN(Number(dealId))) where.dealId = Number(dealId);
    if (leadId && !isNaN(Number(leadId))) where.leadId = Number(leadId);
    if (typeof status === 'string' && status) where.status = status;

    // Non-managers (submitters) are ALWAYS restricted to their own submissions —
    // regardless of scope/dealId/leadId — so a leads/deals-view role can never
    // read another user's approvals. Managers see the queue / all in scope.
    if (isManager(ctx)) {
      if (scope === 'mine') where.submittedById = ctx.userId;
      else if (scope === 'queue') where.status = 'pending';
    } else {
      where.submittedById = ctx.userId;
      if (scope === 'queue') where.status = 'pending';
    }

    const approvals = await prisma.documentApproval.findMany({
      where,
      select: approvalSelect,
      orderBy: [{ createdAt: 'desc' }],
    });
    res.json(approvals);
  } catch (error) {
    console.error('Error fetching approvals:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

/** GET /sales/approvals/:id — single approval with its decision history. */
export const getApprovalById = async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid approval id' });

    const approval = await prisma.documentApproval.findUnique({
      where: { id },
      select: {
        ...approvalSelect,
        submittedById: true,
        history: {
          include: { actor: { select: { id: true, name: true } } },
          orderBy: { createdAt: 'desc' },
        },
      },
    });
    if (!approval) return res.status(404).json({ error: 'Approval not found' });

    // A non-manager may only read their OWN submission (managers see all).
    const ctx = await getSalesAuth(req);
    if (!isManager(ctx) && approval.submittedById !== ctx.userId) {
      return res.status(403).json({ error: 'You cannot view this approval.' });
    }
    res.json(approval);
  } catch (error) {
    console.error('Error fetching approval:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

/**
 * POST /sales/approvals — submit a document for approval (multipart). Requires a
 * file + change notes (SE-022.1 validation). Links to exactly one Lead or Deal.
 */
export const submitApproval = async (req: Request, res: Response) => {
  try {
    const ctx = await getSalesAuth(req);
    const file = req.file as Express.Multer.File | undefined;
    const body = req.body ?? {};

    if (!file) return res.status(400).json({ error: 'A document file is required.' });
    const blocked = blockedFileError(file);
    if (blocked) return res.status(400).json({ error: blocked });
    const changeNotes = typeof body.changeNotes === 'string' ? body.changeNotes.trim() : '';
    if (!changeNotes) return res.status(400).json({ error: 'Change notes are required.' });

    const docType = VALID_DOC_TYPES.includes(body.docType) ? body.docType : 'Other';
    const title = typeof body.title === 'string' && body.title.trim() ? body.title.trim() : file.originalname;
    const version = typeof body.version === 'string' && body.version.trim() ? body.version.trim() : 'v1';

    const leadId = body.leadId != null && body.leadId !== '' && !isNaN(Number(body.leadId)) ? Number(body.leadId) : null;
    const dealId = body.dealId != null && body.dealId !== '' && !isNaN(Number(body.dealId)) ? Number(body.dealId) : null;
    if ((leadId && dealId) || (!leadId && !dealId)) {
      return res.status(400).json({ error: 'A document must belong to exactly one Lead or one Deal.' });
    }

    const fileUrl = await uploadToCloudinary(file);

    const approval = await prisma.documentApproval.create({
      data: {
        docType,
        title,
        version,
        changeNotes,
        comments: typeof body.comments === 'string' ? body.comments : null,
        fileName: file.originalname,
        fileUrl,
        fileSize: file.size,
        status: 'pending',
        leadId,
        dealId,
        submittedById: ctx.userId,
        history: { create: { action: 'submitted', actorId: ctx.userId, comments: changeNotes } },
      },
      select: approvalSelect,
    });

    const actorName = (await prisma.users.findUnique({ where: { id: ctx.userId }, select: { name: true } }))?.name || 'Someone';
    await activityService.logActivity({
      actorUserId: ctx.userId,
      leadId: leadId ?? undefined,
      dealId: dealId ?? undefined,
      type: 'document_submitted',
      description: `${actorName} submitted ${docType} "${title}" (${version}) for approval.`,
    });

    // Notify the manager approval queue.
    const approvers = (await getApproverIds()).filter((mid) => mid !== ctx.userId);
    if (approvers.length > 0) {
      await notificationService.createNotifications(approvers, {
        type: 'escalation',
        title: 'Document awaiting approval',
        message: `${actorName} submitted ${docType} "${title}" for your approval.`,
        entityType: dealId ? 'deal' : 'lead',
        entityId: (dealId ?? leadId)!,
      });
    }

    res.status(201).json(approval);
  } catch (error) {
    console.error('Error submitting approval:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

/**
 * PUT /sales/approvals/:id/decision — manager approve / reject / request rework
 * (SE-022.2). Comments are mandatory for reject & rework. Writes an audit entry,
 * logs activity and notifies the submitter.
 */
export const decideApproval = async (req: Request, res: Response) => {
  try {
    const ctx = await getSalesAuth(req);
    const id = Number(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid approval id' });

    const decision = String(req.body.decision || '').toLowerCase();
    const map: Record<string, { status: string; action: string; label: string }> = {
      approve: { status: 'approved', action: 'approved', label: 'approved' },
      reject: { status: 'rejected', action: 'rejected', label: 'rejected' },
      rework: { status: 'rework', action: 'rework', label: 'sent back for rework' },
    };
    const outcome = map[decision];
    if (!outcome) return res.status(400).json({ error: 'Decision must be approve, reject or rework.' });

    const comments = typeof req.body.comments === 'string' ? req.body.comments.trim() : '';
    if ((decision === 'reject' || decision === 'rework') && !comments) {
      return res.status(400).json({ error: 'Comments are mandatory when rejecting or requesting rework.' });
    }

    const existing = await prisma.documentApproval.findUnique({ where: { id }, select: approvalSelect });
    if (!existing) return res.status(404).json({ error: 'Approval not found' });
    if (existing.status !== 'pending') {
      return res.status(409).json({ error: `This document is already ${existing.status}.` });
    }

    const approval = await prisma.documentApproval.update({
      where: { id },
      data: {
        status: outcome.status,
        managerComments: comments || null,
        reviewedById: ctx.userId,
        decisionAt: new Date(),
        history: { create: { action: outcome.action, actorId: ctx.userId, comments: comments || null } },
      },
      select: approvalSelect,
    });

    const actorName = (await prisma.users.findUnique({ where: { id: ctx.userId }, select: { name: true } }))?.name || 'A manager';
    await activityService.logActivity({
      actorUserId: ctx.userId,
      leadId: approval.leadId ?? undefined,
      dealId: approval.dealId ?? undefined,
      type: `document_${outcome.action}`,
      description: `${actorName} ${outcome.label} ${approval.docType} "${approval.title}".`,
    });

    if (approval.submittedById !== ctx.userId) {
      await notificationService.createNotification({
        userId: approval.submittedById,
        type: 'status_change',
        title: `Document ${outcome.label}`,
        message: `${actorName} ${outcome.label} your ${approval.docType} "${approval.title}".${comments ? ` Note: ${comments}` : ''}`,
        entityType: approval.dealId ? 'deal' : 'lead',
        entityId: (approval.dealId ?? approval.leadId)!,
      });
    }

    res.json(approval);
  } catch (error) {
    console.error('Error deciding approval:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

/**
 * POST /sales/approvals/:id/resubmit — re-upload a revised document after a
 * reject/rework. Bumps the version, resets to pending, re-notifies approvers.
 */
export const resubmitApproval = async (req: Request, res: Response) => {
  try {
    const ctx = await getSalesAuth(req);
    const id = Number(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid approval id' });
    const file = req.file as Express.Multer.File | undefined;

    const existing = await prisma.documentApproval.findUnique({ where: { id }, select: approvalSelect });
    if (!existing) return res.status(404).json({ error: 'Approval not found' });
    if (existing.submittedById !== ctx.userId && !ctx.isAdmin) {
      return res.status(403).json({ error: 'Only the submitter can resubmit this document.' });
    }
    if (existing.status === 'approved') {
      return res.status(409).json({ error: 'An approved document cannot be resubmitted.' });
    }

    if (file) {
      const blocked = blockedFileError(file);
      if (blocked) return res.status(400).json({ error: blocked });
    }

    const changeNotes = typeof req.body.changeNotes === 'string' ? req.body.changeNotes.trim() : '';
    if (!changeNotes) return res.status(400).json({ error: 'Change notes are required.' });

    const data: Record<string, any> = {
      status: 'pending',
      changeNotes,
      managerComments: null,
      reviewedById: null,
      decisionAt: null,
      version: typeof req.body.version === 'string' && req.body.version.trim() ? req.body.version.trim() : existing.version,
    };
    if (file) {
      data.fileUrl = await uploadToCloudinary(file);
      data.fileName = file.originalname;
      data.fileSize = file.size;
    }
    data.history = { create: { action: 'resubmitted', actorId: ctx.userId, comments: changeNotes } };

    const approval = await prisma.documentApproval.update({ where: { id }, data, select: approvalSelect });

    const actorName = (await prisma.users.findUnique({ where: { id: ctx.userId }, select: { name: true } }))?.name || 'Someone';
    await activityService.logActivity({
      actorUserId: ctx.userId,
      leadId: approval.leadId ?? undefined,
      dealId: approval.dealId ?? undefined,
      type: 'document_resubmitted',
      description: `${actorName} resubmitted ${approval.docType} "${approval.title}" (${approval.version}).`,
    });

    const approvers = (await getApproverIds()).filter((mid) => mid !== ctx.userId);
    if (approvers.length > 0) {
      await notificationService.createNotifications(approvers, {
        type: 'escalation',
        title: 'Document resubmitted',
        message: `${actorName} resubmitted ${approval.docType} "${approval.title}" for approval.`,
        entityType: approval.dealId ? 'deal' : 'lead',
        entityId: (approval.dealId ?? approval.leadId)!,
      });
    }

    res.json(approval);
  } catch (error) {
    console.error('Error resubmitting approval:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

/**
 * POST /sales/approvals/:id/send — SE-022.3 approval gate. A document can only
 * be marked sent-to-client once it is APPROVED. Blocks otherwise.
 */
export const sendApprovalToClient = async (req: Request, res: Response) => {
  try {
    const ctx = await getSalesAuth(req);
    const id = Number(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid approval id' });

    const existing = await prisma.documentApproval.findUnique({ where: { id }, select: approvalSelect });
    if (!existing) return res.status(404).json({ error: 'Approval not found' });

    // ── The gate ──────────────────────────────────────────────────────────
    if (existing.status !== 'approved') {
      return res.status(422).json({
        error: `Cannot send to client: document is "${existing.status}". Only approved documents can be sent.`,
        status: existing.status,
      });
    }
    if (existing.sentToClient) {
      return res.status(409).json({ error: 'This document has already been sent to the client.' });
    }

    const approval = await prisma.documentApproval.update({
      where: { id },
      data: {
        sentToClient: true,
        sentAt: new Date(),
        history: { create: { action: 'sent', actorId: ctx.userId, comments: 'Sent to client' } },
      },
      select: approvalSelect,
    });

    const actorName = (await prisma.users.findUnique({ where: { id: ctx.userId }, select: { name: true } }))?.name || 'Someone';
    await activityService.logActivity({
      actorUserId: ctx.userId,
      leadId: approval.leadId ?? undefined,
      dealId: approval.dealId ?? undefined,
      type: 'document_sent',
      description: `${actorName} sent ${approval.docType} "${approval.title}" to the client.`,
    });

    res.json(approval);
  } catch (error) {
    console.error('Error sending approval to client:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};
