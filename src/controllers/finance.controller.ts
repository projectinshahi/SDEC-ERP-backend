import { Request, Response } from 'express';
import prisma from '../config/db.js';

/**
 * Finance module (Phase 1) — Income + Expense CRUD, a unified transactions feed,
 * and a live summary (totals + net profit + recent transactions) for the
 * Dashboard and Reports. All figures derive LIVE from the two tables; there is
 * no stored summary, so the Dashboard/Reports update automatically on any CRUD.
 *
 * Route-level RBAC (finance.*) is enforced in finance.routes.ts.
 */

const INCOME_STATUSES = ['pending', 'received'] as const;
const EXPENSE_STATUSES = ['pending', 'paid'] as const;

const sanitize = (v: unknown): string =>
  typeof v === 'string' ? v.replace(/<[^>]*>/g, '').trim() : '';
/** Preserve line breaks for free-text notes (only strip tags + trim). */
const sanitizeNotes = (v: unknown): string | null => {
  if (typeof v !== 'string') return null;
  const s = v.replace(/<[^>]*>/g, '').trim();
  return s || null;
};

const parseAmount = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : Number(String(v ?? '').replace(/[₹$€£,\s]/g, ''));
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
};

const parseDate = (v: unknown): Date | null => {
  if (!v) return null;
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d;
};

/** Case-insensitive substring match helper for a nullable field. */
const matches = (hay: string | null | undefined, q: string) =>
  (hay || '').toLowerCase().includes(q);

// ── Income ───────────────────────────────────────────────────────────────────

/** GET /finance/income?search=&status= — all income entries (newest first). */
export const listIncome = async (req: Request, res: Response) => {
  try {
    const rows = await prisma.financeIncome.findMany({ orderBy: [{ incomeDate: 'desc' }, { id: 'desc' }] });
    const search = sanitize(req.query.search).toLowerCase();
    const status = sanitize(req.query.status).toLowerCase();
    const filtered = rows.filter((r) => {
      if (status && status !== 'all' && r.status !== status) return false;
      if (search && !(matches(r.title, search) || matches(r.customer, search) || matches(r.project, search))) return false;
      return true;
    });
    res.json(filtered);
  } catch (error) {
    console.error('Error listing income:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

/** POST /finance/income — create an income entry. */
export const createIncome = async (req: Request, res: Response) => {
  try {
    const title = sanitize(req.body.title);
    const amount = parseAmount(req.body.amount);
    const incomeDate = parseDate(req.body.date ?? req.body.incomeDate);
    const paymentMethod = sanitize(req.body.paymentMethod) || 'cash';
    const status = sanitize(req.body.status).toLowerCase() || 'pending';

    if (!title) return res.status(400).json({ error: 'Income title is required.' });
    if (amount === null) return res.status(400).json({ error: 'A valid non-negative amount is required.' });
    if (!incomeDate) return res.status(400).json({ error: 'A valid date is required.' });
    if (!(INCOME_STATUSES as readonly string[]).includes(status)) {
      return res.status(400).json({ error: `Status must be one of: ${INCOME_STATUSES.join(', ')}.` });
    }

    const created = await prisma.financeIncome.create({
      data: {
        title,
        customer: sanitize(req.body.customer) || null,
        project: sanitize(req.body.project) || null,
        amount,
        incomeDate,
        paymentMethod,
        status,
        notes: sanitizeNotes(req.body.notes),
        createdBy: (req as any).userId ?? null,
      },
    });
    res.status(201).json(created);
  } catch (error) {
    console.error('Error creating income:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

/** PUT /finance/income/:id — update an income entry. */
export const updateIncome = async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid income id' });
    const existing = await prisma.financeIncome.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: 'Income entry not found' });

    const data: any = {};
    if (req.body.title !== undefined) {
      const title = sanitize(req.body.title);
      if (!title) return res.status(400).json({ error: 'Income title cannot be empty.' });
      data.title = title;
    }
    if (req.body.amount !== undefined) {
      const amount = parseAmount(req.body.amount);
      if (amount === null) return res.status(400).json({ error: 'A valid non-negative amount is required.' });
      data.amount = amount;
    }
    if (req.body.date !== undefined || req.body.incomeDate !== undefined) {
      const d = parseDate(req.body.date ?? req.body.incomeDate);
      if (!d) return res.status(400).json({ error: 'A valid date is required.' });
      data.incomeDate = d;
    }
    if (req.body.status !== undefined) {
      const status = sanitize(req.body.status).toLowerCase();
      if (!(INCOME_STATUSES as readonly string[]).includes(status)) {
        return res.status(400).json({ error: `Status must be one of: ${INCOME_STATUSES.join(', ')}.` });
      }
      data.status = status;
    }
    if (req.body.paymentMethod !== undefined) data.paymentMethod = sanitize(req.body.paymentMethod) || 'cash';
    if (req.body.customer !== undefined) data.customer = sanitize(req.body.customer) || null;
    if (req.body.project !== undefined) data.project = sanitize(req.body.project) || null;
    if (req.body.notes !== undefined) data.notes = sanitizeNotes(req.body.notes);

    const updated = await prisma.financeIncome.update({ where: { id }, data });
    res.json(updated);
  } catch (error) {
    console.error('Error updating income:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

/** DELETE /finance/income/:id — delete an income entry. */
export const deleteIncome = async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid income id' });
    const existing = await prisma.financeIncome.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: 'Income entry not found' });
    await prisma.financeIncome.delete({ where: { id } });
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting income:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// ── Expenses ─────────────────────────────────────────────────────────────────

/** GET /finance/expenses?search=&status= — all expenses (newest first). */
export const listExpenses = async (req: Request, res: Response) => {
  try {
    const rows = await prisma.financeExpense.findMany({ orderBy: [{ expenseDate: 'desc' }, { id: 'desc' }] });
    const search = sanitize(req.query.search).toLowerCase();
    const status = sanitize(req.query.status).toLowerCase();
    const filtered = rows.filter((r) => {
      if (status && status !== 'all' && r.status !== status) return false;
      if (search && !(matches(r.title, search) || matches(r.category, search) || matches(r.vendor, search))) return false;
      return true;
    });
    res.json(filtered);
  } catch (error) {
    console.error('Error listing expenses:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

/** POST /finance/expenses — create an expense entry. */
export const createExpense = async (req: Request, res: Response) => {
  try {
    const title = sanitize(req.body.title);
    const amount = parseAmount(req.body.amount);
    const expenseDate = parseDate(req.body.date ?? req.body.expenseDate);
    const category = sanitize(req.body.category) || 'general';
    const paymentMethod = sanitize(req.body.paymentMethod) || 'cash';
    const status = sanitize(req.body.status).toLowerCase() || 'pending';

    if (!title) return res.status(400).json({ error: 'Expense title is required.' });
    if (amount === null) return res.status(400).json({ error: 'A valid non-negative amount is required.' });
    if (!expenseDate) return res.status(400).json({ error: 'A valid date is required.' });
    if (!(EXPENSE_STATUSES as readonly string[]).includes(status)) {
      return res.status(400).json({ error: `Status must be one of: ${EXPENSE_STATUSES.join(', ')}.` });
    }

    const created = await prisma.financeExpense.create({
      data: {
        title,
        category,
        vendor: sanitize(req.body.vendor) || null,
        amount,
        expenseDate,
        paymentMethod,
        status,
        notes: sanitizeNotes(req.body.notes),
        createdBy: (req as any).userId ?? null,
      },
    });
    res.status(201).json(created);
  } catch (error) {
    console.error('Error creating expense:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

/** PUT /finance/expenses/:id — update an expense entry. */
export const updateExpense = async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid expense id' });
    const existing = await prisma.financeExpense.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: 'Expense entry not found' });

    const data: any = {};
    if (req.body.title !== undefined) {
      const title = sanitize(req.body.title);
      if (!title) return res.status(400).json({ error: 'Expense title cannot be empty.' });
      data.title = title;
    }
    if (req.body.amount !== undefined) {
      const amount = parseAmount(req.body.amount);
      if (amount === null) return res.status(400).json({ error: 'A valid non-negative amount is required.' });
      data.amount = amount;
    }
    if (req.body.date !== undefined || req.body.expenseDate !== undefined) {
      const d = parseDate(req.body.date ?? req.body.expenseDate);
      if (!d) return res.status(400).json({ error: 'A valid date is required.' });
      data.expenseDate = d;
    }
    if (req.body.status !== undefined) {
      const status = sanitize(req.body.status).toLowerCase();
      if (!(EXPENSE_STATUSES as readonly string[]).includes(status)) {
        return res.status(400).json({ error: `Status must be one of: ${EXPENSE_STATUSES.join(', ')}.` });
      }
      data.status = status;
    }
    if (req.body.category !== undefined) data.category = sanitize(req.body.category) || 'general';
    if (req.body.paymentMethod !== undefined) data.paymentMethod = sanitize(req.body.paymentMethod) || 'cash';
    if (req.body.vendor !== undefined) data.vendor = sanitize(req.body.vendor) || null;
    if (req.body.notes !== undefined) data.notes = sanitizeNotes(req.body.notes);

    const updated = await prisma.financeExpense.update({ where: { id }, data });
    res.json(updated);
  } catch (error) {
    console.error('Error updating expense:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

/** DELETE /finance/expenses/:id — delete an expense entry. */
export const deleteExpense = async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid expense id' });
    const existing = await prisma.financeExpense.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: 'Expense entry not found' });
    await prisma.financeExpense.delete({ where: { id } });
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting expense:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// ── Unified transactions + summary ───────────────────────────────────────────

interface Txn {
  id: string;
  type: 'income' | 'expense';
  title: string;
  amount: number;
  status: string;
  date: Date;
  category: string | null;
  party: string | null; // customer (income) or vendor (expense)
}

/** Merge income + expense rows into one unified, date-desc transaction list. */
async function buildTransactions(): Promise<Txn[]> {
  const [income, expenses] = await Promise.all([
    prisma.financeIncome.findMany(),
    prisma.financeExpense.findMany(),
  ]);
  const txns: Txn[] = [
    ...income.map((r): Txn => ({
      id: `income-${r.id}`, type: 'income', title: r.title, amount: r.amount,
      status: r.status, date: r.incomeDate, category: null, party: r.customer ?? null,
    })),
    ...expenses.map((r): Txn => ({
      id: `expense-${r.id}`, type: 'expense', title: r.title, amount: r.amount,
      status: r.status, date: r.expenseDate, category: r.category, party: r.vendor ?? null,
    })),
  ];
  txns.sort((a, b) => b.date.getTime() - a.date.getTime());
  return txns;
}

/** GET /finance/transactions — unified income + expense feed (newest first). */
export const listTransactions = async (_req: Request, res: Response) => {
  try {
    res.json(await buildTransactions());
  } catch (error) {
    console.error('Error listing transactions:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

/**
 * GET /finance/overview — live summary for the Dashboard + Reports:
 * total income, total expenses, net profit, counts, and recent transactions.
 */
export const getOverview = async (_req: Request, res: Response) => {
  try {
    const txns = await buildTransactions();
    let totalIncome = 0;
    let totalExpenses = 0;
    let incomeCount = 0;
    let expenseCount = 0;
    for (const t of txns) {
      if (t.type === 'income') { totalIncome += t.amount; incomeCount++; }
      else { totalExpenses += t.amount; expenseCount++; }
    }
    res.json({
      totalIncome,
      totalExpenses,
      netProfit: totalIncome - totalExpenses,
      incomeCount,
      expenseCount,
      transactionCount: txns.length,
      recentTransactions: txns.slice(0, 8),
    });
  } catch (error) {
    console.error('Error building finance overview:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};
