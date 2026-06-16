import express from 'express';
import { captureWebsiteLead } from '../controllers/websiteCapture.controller.js';
import { rateLimiter } from '../middleware/rateLimiter.js';

const router = express.Router();

// Public endpoint — no authentication middleware.
// Rate-limited to 10 requests per 15-minute window per IP.
// JSON body parsing is handled by the global express.json() in app.ts.
router.post(
  '/website-capture',
  rateLimiter({ windowMs: 15 * 60 * 1000, max: 10, message: 'Too many submissions. Please try again later.' }),
  captureWebsiteLead,
);

export default router;

