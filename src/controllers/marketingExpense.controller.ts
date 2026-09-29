import type { Request, Response } from 'express';
import { v2 as cloudinary } from 'cloudinary';
import multer from 'multer';
import prisma from '../config/db.js';
import { getSalesAuth, can } from '../utils/salesAuth.js';
import { activityService } from '../services/activity.service.js';
import {
  EXPENSE_VIEW_KEYS, EXPENSE_CREATE_KEYS, EXPENSE_EDIT_KEYS, EXPENSE_DELETE_KEY,
  EXPENSE_APPROVE_KEY, SETTINGS_KEY, canAny,
  getFinanceSettings, updateFinanceSettings, resolveApprovalStatus,
  buildExpenseWhere, loadExpenses, summarize, money, isYmd, ymdToDate,
  APPROVAL_STATUSES, type ApprovalStatus, type ExpenseFilter,
} from '../services/marketingFinance.service.js';

/**
 * MK-004.2 Expense Logger + MK-004.3 Approval workflow.
 *
 * Writes to the EXISTING finance_expense table — the same one MK-004.1 reads —
 * so there is exactly one place a Marketing cost lives. Every figure this file
 * returns comes from the shared marketingFinance service, which is also what the
 * dashboard and both exports use.
 */

const uid = (req: Request) => Number((req as any).userId);
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const intId = (v: unknown): number | null => {
  const n = Number(typeof v === 'string' ? v.trim() : v);
  return Number.isInteger(n) && n > 0 ? n : null;
};

/** Receipts reuse the module's existing Cloudinary upload path — no second
 *  storage system. 10 MB is ample for a receipt and keeps a bad upload from
 *  occupying the request for minutes. */
export const receiptUploadMiddleware = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});
const RECEIPT_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'application/pdf'];

// ─────────────────────────────────────────────────────────────────────────────
// Shared validation. The server is authoritative; the frontend Zod schema
// mirrors these rules so a value accepted there is not rejected here for format.
// ─────────────────────────────────────────────────────────────────────────────
interface ValidatedExpense {
  title: string; category: string; vendor: string | null; amount: number;
  date: string; notes: string | null; clientId: number; projectId: number | null;
}

async function validateExpense(
  b: Record<string, any>,
): Promise<{ errors: Record<string, string> } | { value: ValidatedExpense }> {
  const errors: Record<string, string> = {};

  const title = str(b.title);
  if (!title) errors.title = 'Title is required.';
  else if (title.length > 255) errors.title = 'Title must be 255 characters or fewer.';

  const category = str(b.category);
  if (!category) errors.category = 'Category is required.';
  else if (category.length > 100) errors.category = 'Category must be 100 characters or fewer.';

  // Reject the string that Number() would silently turn into something valid.
  const rawAmount = typeof b.amount === 'string' ? b.amount.trim() : b.amount;
  const amount = Number(rawAmount);
  if (rawAmount === '' || rawAmount === null || rawAmount === undefined) {
    errors.amount = 'Amount is required.';
  } else if (!Number.isFinite(amount)) {
    errors.amount = 'Amount must be a number.';
  } else if (amount <= 0) {
    errors.amount = 'Amount must be greater than zero.';
  } else if (amount > 1e12) {
    errors.amount = 'Amount is too large.';
  }

  const date = str(b.date);
  if (!date) errors.date = 'Date is required.';
  else if (!isYmd(date)) errors.date = 'Enter a valid date.';

  const clientId = intId(b.clientId);
  if (!clientId) errors.clientId = 'Client is required.';

  const vendor = str(b.vendor);
  if (vendor.length > 255) errors.vendor = 'Vendor must be 255 characters or fewer.';

  if (Object.keys(errors).length) return { errors };

  /* Referential checks are done SERVER-SIDE against the database — a clientId or
   * projectId from the request is never trusted just because it is a number. */
  const client = await prisma.marketing_clients.findFirst({
    where: { id: clientId!, active: true }, select: { id: true },
  });
  if (!client) return { errors: { clientId: 'Client not found.' } };

  let projectId: number | null = null;
  if (b.projectId !== undefined && b.projectId !== null && b.projectId !== '') {
    const pid = intId(b.projectId);
    // The project must belong to THIS client, otherwise a cost could be filed
    // against one client while pointing at another client's project.
    const project = pid
      ? await prisma.marketing_projects.findFirst({ where: { id: pid, client_id: client.id }, select: { id: true } })
      : null;
    if (!project) return { errors: { projectId: 'That project does not belong to the selected client.' } };
    projectId = project.id;
  }

  return {
    value: {
      title, category, vendor: vendor || null, amount: money(amount),
      date, notes: str(b.notes) || null, clientId: client.id, projectId,
    },
  };
}

const filterFromQuery = (q: Request['query']): ExpenseFilter => ({
  clientId: intId(q.clientId),
  projectId: intId(q.projectId),
  category: str(q.category) || null,
  approvalStatus: (APPROVAL_STATUSES as readonly string[]).includes(str(q.approvalStatus))
    ? (str(q.approvalStatus) as ApprovalStatus)
    : str(q.approvalStatus) === 'all' ? 'all' : null,
  from: isYmd(q.from) ? String(q.from) : null,
  to: isYmd(q.to) ? String(q.to) : null,
  search: str(q.search) || null,
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /marketing/expenses — the logger's list, every approval state
// ─────────────────────────────────────────────────────────────────────────────
export const getExpenses = async (req: Request, res: Response): Promise<any> => {
  try {
    const ctx = await getSalesAuth(req);
    if (!canAny(ctx, EXPENSE_VIEW_KEYS)) {
      return res.status(403).json({ error: 'You do not have permission to view Marketing expenses.' });
    }

    const filter = filterFromQuery(req.query);
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(10, Number(req.query.pageSize) || 25));

    // An invalid range is a user error, not an empty result that looks like
    // "no expenses" — say so, next to the field.
    if (isYmd(filter.from) && isYmd(filter.to) && filter.to! < filter.from!) {
      return res.status(400).json({
        error: 'The end date cannot be earlier than the start date.',
        fieldErrors: { to: 'The end date cannot be earlier than the start date.' },
      });
    }

    const where = buildExpenseWhere(filter, false);
    const [rows, total, clients, categories, settings] = await Promise.all([
      loadExpenses(where, pageSize, (page - 1) * pageSize),
      prisma.financeExpense.count({ where }),
      prisma.marketing_clients.findMany({
        where: { active: true }, select: { id: true, name: true },
        orderBy: [{ sort_order: 'asc' }, { name: 'asc' }],
      }),
      prisma.marketing_expense_categories.findMany({
        where: { active: true }, select: { id: true, name: true },
        orderBy: [{ sort_order: 'asc' }, { name: 'asc' }],
      }),
      getFinanceSettings(),
    ]);

    // Totals cover the WHOLE filtered set, not just the visible page — a page
    // total would read as the filter's total and be wrong.
    const allForTotals = await prisma.financeExpense.findMany({
      where, select: { amount: true, category: true, approvalStatus: true },
    });
    const approved = allForTotals.filter((r) => r.approvalStatus === 'approved');

    return res.json({
      success: true,
      expenses: rows,
      page, pageSize, total,
      clients, categories,
      settings,
      permissions: {
        canCreate: canAny(ctx, EXPENSE_CREATE_KEYS),
        canEdit: canAny(ctx, EXPENSE_EDIT_KEYS),
        canDelete: can(ctx, EXPENSE_DELETE_KEY),
        canApprove: can(ctx, EXPENSE_APPROVE_KEY),
      },
      totals: {
        // Approved is the figure that feeds reporting; the other two are shown
        // so a reviewer can see what is still outstanding.
        approved: summarize(approved.map((r) => ({ amount: Number(r.amount), category: r.category }))).total,
        pending: money(allForTotals.filter((r) => r.approvalStatus === 'pending')
          .reduce((s, r) => s + Number(r.amount), 0)),
        rejected: money(allForTotals.filter((r) => r.approvalStatus === 'rejected')
          .reduce((s, r) => s + Number(r.amount), 0)),
        count: total,
      },
    });
  } catch (error) {
    console.error('Error loading marketing expenses:', error);
    return res.status(500).json({ error: 'Failed to load expenses' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /marketing/expenses/:id — one expense, for the detail panel
// ─────────────────────────────────────────────────────────────────────────────
export const getExpenseById = async (req: Request, res: Response): Promise<any> => {
  try {
    const ctx = await getSalesAuth(req);
    if (!canAny(ctx, EXPENSE_VIEW_KEYS)) {
      return res.status(403).json({ error: 'You do not have permission to view Marketing expenses.' });
    }
    const id = intId(req.params.id);
    if (!id) return res.status(404).json({ error: 'Expense not found.' });

    // Marketing expenses only: a Finance-module row (clientId NULL) is not this
    // module's to show, and an unattributed row must not leak through an id probe.
    const rows = await loadExpenses({ id, clientId: { not: null } });
    if (!rows.length) return res.status(404).json({ error: 'Expense not found.' });

    return res.json({
      success: true,
      expense: rows[0],
      permissions: {
        canEdit: canAny(ctx, EXPENSE_EDIT_KEYS),
        canDelete: can(ctx, EXPENSE_DELETE_KEY),
        canApprove: can(ctx, EXPENSE_APPROVE_KEY),
      },
    });
  } catch (error) {
    console.error('Error loading expense:', error);
    return res.status(500).json({ error: 'Failed to load the expense' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /marketing/expenses — MK-004.2 submit
// ─────────────────────────────────────────────────────────────────────────────
export const createExpense = async (req: Request, res: Response): Promise<any> => {
  try {
    const ctx = await getSalesAuth(req);
    if (!canAny(ctx, EXPENSE_CREATE_KEYS)) {
      return res.status(403).json({ error: 'You do not have permission to log Marketing expenses.' });
    }

    const checked = await validateExpense(req.body ?? {});
    if ('errors' in checked) {
      return res.status(400).json({ error: 'Please fix the highlighted fields.', fieldErrors: checked.errors });
    }
    const v = checked.value;

    // MK-004.3 routing, from the single configurable threshold.
    const settings = await getFinanceSettings();
    const approvalStatus = resolveApprovalStatus(v.amount, settings);

    const row = await prisma.financeExpense.create({
      data: {
        title: v.title, category: v.category, vendor: v.vendor,
        amount: v.amount, expenseDate: ymdToDate(v.date), notes: v.notes,
        clientId: v.clientId, projectId: v.projectId,
        approvalStatus,
        // Always the authenticated caller — never an id from the request body.
        submittedBy: uid(req), createdBy: uid(req),
        // Auto-approved rows record WHO decided, so the audit trail never has a
        // decision with no actor. The actor is the system rule, represented by
        // the submitter plus an explicit note.
        ...(approvalStatus === 'approved'
          ? { decidedAt: new Date(), decisionNote: 'Auto-approved: at or below the approval threshold.' }
          : {}),
      },
    });

    await activityService.logActivity({
      actorUserId: uid(req),
      type: 'marketing_expense_submitted',
      description: `Submitted expense '${row.title}' (${approvalStatus === 'pending' ? 'awaiting approval' : 'auto-approved'})`,
      metadata: {
        expenseId: row.id, clientId: v.clientId, projectId: v.projectId,
        amount: v.amount, category: v.category, approvalStatus,
        approvalThreshold: settings.approvalThreshold,
      },
    });

    const [saved] = await loadExpenses({ id: row.id });
    return res.status(201).json({ success: true, expense: saved, approvalStatus });
  } catch (error) {
    console.error('Error creating marketing expense:', error);
    return res.status(500).json({ error: 'Failed to log the expense' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// PUT /marketing/expenses/:id — edit, and MK-004.3 resubmission
// ─────────────────────────────────────────────────────────────────────────────
export const updateExpense = async (req: Request, res: Response): Promise<any> => {
  try {
    const ctx = await getSalesAuth(req);
    if (!canAny(ctx, EXPENSE_EDIT_KEYS)) {
      return res.status(403).json({ error: 'You do not have permission to edit Marketing expenses.' });
    }
    const id = intId(req.params.id);
    if (!id) return res.status(404).json({ error: 'Expense not found.' });

    const existing = await prisma.financeExpense.findFirst({
      where: { id, clientId: { not: null } },
      select: { id: true, approvalStatus: true, submittedBy: true, title: true },
    });
    if (!existing) return res.status(404).json({ error: 'Expense not found.' });

    /* An APPROVED expense is a settled financial record and already counted in
     * client reporting; editing it would silently restate history. Rejected and
     * pending rows are still in flight and may be corrected. */
    if (existing.approvalStatus === 'approved' && !can(ctx, EXPENSE_APPROVE_KEY)) {
      return res.status(409).json({
        error: 'This expense has been approved and can no longer be edited.',
      });
    }

    const checked = await validateExpense(req.body ?? {});
    if ('errors' in checked) {
      return res.status(400).json({ error: 'Please fix the highlighted fields.', fieldErrors: checked.errors });
    }
    const v = checked.value;

    /* Resubmission: a corrected rejected expense re-enters the workflow at the
     * threshold rule rather than staying rejected forever. The row is UPDATED,
     * never deleted and re-created, so its id and history survive. */
    const settings = await getFinanceSettings();
    const wasRejected = existing.approvalStatus === 'rejected';
    const approvalStatus = wasRejected || existing.approvalStatus === 'pending'
      ? resolveApprovalStatus(v.amount, settings)
      : existing.approvalStatus as ApprovalStatus;

    await prisma.financeExpense.update({
      where: { id },
      data: {
        title: v.title, category: v.category, vendor: v.vendor,
        amount: v.amount, expenseDate: ymdToDate(v.date), notes: v.notes,
        clientId: v.clientId, projectId: v.projectId,
        approvalStatus,
        ...(wasRejected
          ? {
            // A resubmission clears the previous decision so the queue does not
            // show a fresh submission carrying an old rejection reason.
            decidedBy: null, decidedAt: approvalStatus === 'approved' ? new Date() : null,
            decisionNote: approvalStatus === 'approved'
              ? 'Auto-approved on resubmission: at or below the approval threshold.'
              : null,
          }
          : {}),
      },
    });

    await activityService.logActivity({
      actorUserId: uid(req),
      type: wasRejected ? 'marketing_expense_resubmitted' : 'marketing_expense_updated',
      description: `${wasRejected ? 'Resubmitted' : 'Updated'} expense '${v.title}'`,
      metadata: { expenseId: id, amount: v.amount, approvalStatus, previousStatus: existing.approvalStatus },
    });

    const [saved] = await loadExpenses({ id });
    return res.json({ success: true, expense: saved });
  } catch (error) {
    console.error('Error updating marketing expense:', error);
    return res.status(500).json({ error: 'Failed to update the expense' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /marketing/expenses/:id/decision — MK-004.3 approve / reject
// ─────────────────────────────────────────────────────────────────────────────
export const decideExpense = async (req: Request, res: Response): Promise<any> => {
  try {
    const ctx = await getSalesAuth(req);
    // The route gate already requires this key; re-checked here so a direct API
    // call is refused by the handler too, not only by the router.
    if (!can(ctx, EXPENSE_APPROVE_KEY)) {
      return res.status(403).json({ error: 'You do not have permission to approve Marketing expenses.' });
    }
    const id = intId(req.params.id);
    if (!id) return res.status(404).json({ error: 'Expense not found.' });

    const decision = str(req.body?.decision).toLowerCase();
    if (decision !== 'approved' && decision !== 'rejected') {
      return res.status(400).json({
        error: 'Choose approve or reject.',
        fieldErrors: { decision: 'Choose approve or reject.' },
      });
    }
    const note = str(req.body?.note);
    // A rejection has to be actionable — the submitter needs to know what to fix.
    if (decision === 'rejected' && !note) {
      return res.status(400).json({
        error: 'Please fix the highlighted fields.',
        fieldErrors: { note: 'A reason is required when rejecting.' },
      });
    }
    if (note.length > 1000) {
      return res.status(400).json({
        error: 'Please fix the highlighted fields.',
        fieldErrors: { note: 'Reason must be 1000 characters or fewer.' },
      });
    }

    const existing = await prisma.financeExpense.findFirst({
      where: { id, clientId: { not: null } },
      select: { id: true, approvalStatus: true, title: true, amount: true, clientId: true },
    });
    if (!existing) return res.status(404).json({ error: 'Expense not found.' });

    /* Only a PENDING expense is decidable. This is what stops a double-click (or
     * two managers acting at once) from overwriting the first decision — the
     * second request is refused rather than silently winning. */
    if (existing.approvalStatus !== 'pending') {
      return res.status(409).json({
        error: existing.approvalStatus === 'approved'
          ? 'This expense has already been approved.'
          : 'This expense has already been rejected.',
        approvalStatus: existing.approvalStatus,
      });
    }

    await prisma.financeExpense.update({
      where: { id },
      data: {
        approvalStatus: decision,
        decidedBy: uid(req),
        decidedAt: new Date(),
        decisionNote: note || null,
      },
    });

    await activityService.logActivity({
      actorUserId: uid(req),
      type: 'marketing_expense_decided',
      description: `${decision === 'approved' ? 'Approved' : 'Rejected'} expense '${existing.title}'`,
      metadata: {
        expenseId: id, decision, amount: Number(existing.amount),
        clientId: existing.clientId, note: note || null,
      },
    });

    const [saved] = await loadExpenses({ id });
    return res.json({ success: true, expense: saved });
  } catch (error) {
    console.error('Error deciding marketing expense:', error);
    return res.status(500).json({ error: 'Failed to record the decision' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /marketing/expenses/:id/receipt — MK-004.2 receipt upload
// ─────────────────────────────────────────────────────────────────────────────
export const uploadExpenseReceipt = async (req: Request, res: Response): Promise<any> => {
  try {
    const ctx = await getSalesAuth(req);
    if (!canAny(ctx, EXPENSE_CREATE_KEYS) && !canAny(ctx, EXPENSE_EDIT_KEYS)) {
      return res.status(403).json({ error: 'You do not have permission to attach a receipt.' });
    }
    const id = intId(req.params.id);
    if (!id) return res.status(404).json({ error: 'Expense not found.' });

    const file = (req as any).file as Express.Multer.File | undefined;
    if (!file) return res.status(400).json({ error: 'No receipt was uploaded.', fieldErrors: { receipt: 'Choose a file.' } });
    if (!RECEIPT_TYPES.includes(file.mimetype)) {
      return res.status(400).json({
        error: 'Unsupported file type.',
        fieldErrors: { receipt: 'Upload a JPG, PNG, WEBP or PDF receipt.' },
      });
    }

    const existing = await prisma.financeExpense.findFirst({
      where: { id, clientId: { not: null } }, select: { id: true, approvalStatus: true },
    });
    if (!existing) return res.status(404).json({ error: 'Expense not found.' });
    if (existing.approvalStatus === 'approved' && !can(ctx, EXPENSE_APPROVE_KEY)) {
      return res.status(409).json({ error: 'This expense has been approved and can no longer be changed.' });
    }

    const result: any = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        {
          resource_type: 'auto',
          folder: 'erp_marketing_receipts',
          public_id: `${Date.now()}-${file.originalname.replace(/[^a-zA-Z0-9-_.]/g, '')}`,
        },
        (error, r) => (error ? reject(error) : resolve(r)),
      );
      stream.end(file.buffer);
    });

    await prisma.financeExpense.update({
      where: { id },
      data: { receiptUrl: result.secure_url, receiptName: file.originalname },
    });

    return res.status(201).json({
      success: true, receiptUrl: result.secure_url, receiptName: file.originalname,
    });
  } catch (error) {
    console.error('Error uploading expense receipt:', error);
    return res.status(500).json({ error: 'Failed to upload the receipt' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /marketing/expenses/:id
// ─────────────────────────────────────────────────────────────────────────────
export const deleteExpense = async (req: Request, res: Response): Promise<any> => {
  try {
    const ctx = await getSalesAuth(req);
    if (!can(ctx, EXPENSE_DELETE_KEY)) {
      return res.status(403).json({ error: 'You do not have permission to delete Marketing expenses.' });
    }
    const id = intId(req.params.id);
    if (!id) return res.status(404).json({ error: 'Expense not found.' });

    const existing = await prisma.financeExpense.findFirst({
      where: { id, clientId: { not: null } },
      select: { id: true, title: true, approvalStatus: true, amount: true },
    });
    if (!existing) return res.status(404).json({ error: 'Expense not found.' });
    // An approved expense is part of reported client spend; removing it would
    // change a figure someone has already been shown.
    if (existing.approvalStatus === 'approved') {
      return res.status(409).json({ error: 'An approved expense cannot be deleted.' });
    }

    await prisma.financeExpense.delete({ where: { id } });
    await activityService.logActivity({
      actorUserId: uid(req),
      type: 'marketing_expense_deleted',
      description: `Deleted expense '${existing.title}'`,
      metadata: { expenseId: id, amount: Number(existing.amount) },
    });
    return res.json({ success: true });
  } catch (error) {
    console.error('Error deleting marketing expense:', error);
    return res.status(500).json({ error: 'Failed to delete the expense' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET / PUT /marketing/finance-settings — MK-004.3 admin threshold
// ─────────────────────────────────────────────────────────────────────────────
export const getFinanceSettingsHandler = async (req: Request, res: Response): Promise<any> => {
  try {
    const ctx = await getSalesAuth(req);
    // Readable by anyone who may log an expense: the form needs the threshold to
    // know when to ask for confirmation. Writing is admin-only, below.
    if (!canAny(ctx, EXPENSE_VIEW_KEYS) && !canAny(ctx, EXPENSE_CREATE_KEYS)) {
      return res.status(403).json({ error: 'You do not have permission to view Marketing finance settings.' });
    }
    return res.json({
      success: true,
      settings: await getFinanceSettings(),
      canManage: can(ctx, SETTINGS_KEY),
    });
  } catch (error) {
    console.error('Error loading marketing finance settings:', error);
    return res.status(500).json({ error: 'Failed to load finance settings' });
  }
};

export const putFinanceSettingsHandler = async (req: Request, res: Response): Promise<any> => {
  try {
    const ctx = await getSalesAuth(req);
    if (!can(ctx, SETTINGS_KEY)) {
      return res.status(403).json({ error: 'You do not have permission to change Marketing finance settings.' });
    }
    const b = req.body ?? {};
    const errors: Record<string, string> = {};
    const patch: Record<string, number> = {};

    for (const [key, label] of [
      ['approvalThreshold', 'Approval threshold'],
      ['largeExpenseThreshold', 'Large expense threshold'],
    ] as const) {
      if (b[key] === undefined || b[key] === null || b[key] === '') continue;
      const n = Number(b[key]);
      if (!Number.isFinite(n)) errors[key] = `${label} must be a number.`;
      else if (n < 0) errors[key] = `${label} cannot be negative.`;
      else if (n > 1e12) errors[key] = `${label} is too large.`;
      else patch[key] = money(n);
    }
    if (Object.keys(errors).length) {
      return res.status(400).json({ error: 'Please fix the highlighted fields.', fieldErrors: errors });
    }
    if (!Object.keys(patch).length) {
      return res.status(400).json({ error: 'Nothing to update.' });
    }

    const settings = await updateFinanceSettings(patch);
    await activityService.logActivity({
      actorUserId: uid(req),
      type: 'marketing_finance_settings_updated',
      description: 'Updated Marketing finance thresholds',
      metadata: { ...patch },
    });
    return res.json({ success: true, settings });
  } catch (error) {
    console.error('Error updating marketing finance settings:', error);
    return res.status(500).json({ error: 'Failed to update finance settings' });
  }
};
