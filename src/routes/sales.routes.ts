import express from 'express';
import {
  getLeads,
  createLead,
  getDeals,
  createDeal,
  getCustomers,
  createCustomer,
} from '../controllers/sales.controller.js';
import { authenticate, checkPermission } from '../middleware/auth.middleware.js';

const router = express.Router();

// Apply auth middleware to all sales routes
router.use(authenticate);

// Leads Routes
router.get('/leads', checkPermission('sales.view'), getLeads);
router.post('/leads', checkPermission('sales.create'), createLead);

// Deals Routes
router.get('/deals', checkPermission('sales.view'), getDeals);
router.post('/deals', checkPermission('sales.create'), createDeal);

// Customers Routes
router.get('/customers', checkPermission('sales.view'), getCustomers);
router.post('/customers', checkPermission('sales.create'), createCustomer);

export default router;
