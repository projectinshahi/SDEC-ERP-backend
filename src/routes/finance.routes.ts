import { Router } from 'express';
import { checkPermission, checkAnyPermission } from '../middleware/auth.middleware.js';
import {
  listIncome, createIncome, updateIncome, deleteIncome,
  listExpenses, createExpense, updateExpense, deleteExpense,
  listTransactions, getOverview,
} from '../controllers/finance.controller.js';

/**
 * Finance module routes (Phase 1). Mounted at /finance. RBAC mirrors the
 * frontend sidebar gates: reads accept the page's own View key OR the coarse
 * `finance.view`; writes require the exact per-action key. Founder/Admin bypass
 * via isGlobalAdmin in checkPermission.
 */
const router = Router();

// Summary + unified feed (Dashboard / Reports / Transactions pages).
router.get('/overview', checkAnyPermission(['finance.dashboard.view', 'finance.reports.view', 'finance.view']), getOverview);
router.get('/transactions', checkAnyPermission(['finance.transactions.view', 'finance.view']), listTransactions);

// Income CRUD.
router.get('/income', checkAnyPermission(['finance.income.view', 'finance.view']), listIncome);
router.post('/income', checkPermission('finance.income.create'), createIncome);
router.put('/income/:id', checkPermission('finance.income.edit'), updateIncome);
router.delete('/income/:id', checkPermission('finance.income.delete'), deleteIncome);

// Expense CRUD.
router.get('/expenses', checkAnyPermission(['finance.expenses.view', 'finance.view']), listExpenses);
router.post('/expenses', checkPermission('finance.expenses.create'), createExpense);
router.put('/expenses/:id', checkPermission('finance.expenses.edit'), updateExpense);
router.delete('/expenses/:id', checkPermission('finance.expenses.delete'), deleteExpense);

export default router;
