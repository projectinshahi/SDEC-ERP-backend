import express from 'express';
import { getActivityFeed, clearActivityFeed } from '../controllers/activity.controller.js';
import { authenticate } from '../middleware/auth.middleware.js';

const router = express.Router();

// Get recent activity feed for logged-in user
router.get('/', authenticate, getActivityFeed);

// Clear recent activity feed
router.delete('/', authenticate, clearActivityFeed);

export default router;
