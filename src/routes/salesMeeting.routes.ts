import { Router, Request, Response, NextFunction } from 'express';
import prisma from '../config/db.js';
import { isGlobalAdmin } from '../utils/roles.js';
import {
  getMeetings,
  getMeetingAnalytics,
  getMeetingById,
  createMeeting,
  updateMeeting,
  deleteMeeting,
} from '../controllers/meeting.controller.js';
import { getMeetingNotes, addMeetingNote, updateMeetingNote, deleteMeetingNote } from '../controllers/meeting_note.controller.js';
import { authenticate, checkPermission, checkAnyPermission } from '../middleware/auth.middleware.js';

/**
 * Sales Meetings — /api/sales/meetings. Sets module='sales'; reuses the entire
 * meeting controller (Google Meet, notifications, action items, notes). The
 * controller scopes visibility to the organizer/attendees (founders see all).
 * Gated on the independent sales.meetings.* permission set.
 */
const router = Router();

router.use((req: Request, _res: Response, next: NextFunction) => {
  (req as any).meetingModule = 'sales';
  next();
});

// Sub-routes that operate on a meeting by id but whose controllers don't already
// enforce sales visibility (meeting notes) get an explicit access guard here.
const requireSalesMeetingAccess = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = parseInt(req.params.id as string);
    if (isNaN(id)) return res.status(400).json({ success: false, message: 'Invalid meeting ID' });
    const m = await prisma.meeting.findUnique({ where: { id }, select: { module: true, organizerId: true, attendees: true } });
    if (!m) return res.status(404).json({ success: false, message: 'Meeting not found' });
    const userId = Number((req as any).userId);
    const role = (req as any).userRole || '';
    if (m.module === 'sales' && !isGlobalAdmin(role) && m.organizerId !== userId && !(m.attendees as number[]).includes(userId)) {
      return res.status(403).json({ success: false, message: 'Forbidden: you do not have access to this meeting' });
    }
    return next();
  } catch (e) {
    console.error('Sales meeting access guard error:', e);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};

router.get('/', authenticate, checkPermission('sales.meetings.view'), getMeetings);
// Analytics — registered BEFORE '/:id' so it is never captured as an id.
router.get('/analytics', authenticate, checkPermission('sales.meetings.view'), getMeetingAnalytics);
router.get('/:id', authenticate, checkPermission('sales.meetings.view'), getMeetingById);
router.post('/', authenticate, checkAnyPermission(['sales.meetings.create', 'sales.meetings.schedule']), createMeeting);
router.put('/:id', authenticate, checkPermission('sales.meetings.edit'), updateMeeting);
router.delete('/:id', authenticate, checkPermission('sales.meetings.delete'), deleteMeeting);

// Meeting Notes
router.get('/:id/notes', authenticate, checkPermission('sales.meetings.view'), requireSalesMeetingAccess, getMeetingNotes);
router.post('/:id/notes', authenticate, checkPermission('sales.meetings.edit'), requireSalesMeetingAccess, addMeetingNote);
router.put('/:id/notes/:noteId', authenticate, checkPermission('sales.meetings.edit'), requireSalesMeetingAccess, updateMeetingNote);
router.delete('/:id/notes/:noteId', authenticate, checkPermission('sales.meetings.edit'), requireSalesMeetingAccess, deleteMeetingNote);

export default router;
