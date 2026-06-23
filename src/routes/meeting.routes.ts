import { Router } from 'express';
import { getMeetings, getMeetingAnalytics, getMeetingById, createMeeting, updateMeeting, deleteMeeting } from '../controllers/meeting.controller.js';
import { getMeetingNotes, addMeetingNote, updateMeetingNote, deleteMeetingNote } from '../controllers/meeting_note.controller.js';
import { authenticate, checkPermission } from '../middleware/auth.middleware.js';

const router = Router();

// Strict RBAC: every meetings endpoint requires the matching module permission
// (was previously authenticate-only, i.e. open to any logged-in user).
router.get('/', authenticate, checkPermission('meetings.read'), getMeetings);
// Live analytics — registered BEFORE '/:id' so it is never captured as an id.
router.get('/analytics', authenticate, checkPermission('meetings.read'), getMeetingAnalytics);
router.get('/:id', authenticate, checkPermission('meetings.read'), getMeetingById);
router.post('/', authenticate, checkPermission('meetings.create'), createMeeting);
router.put('/:id', authenticate, checkPermission('meetings.update'), updateMeeting);
router.delete('/:id', authenticate, checkPermission('meetings.delete'), deleteMeeting);

// Meeting Notes Routes
router.get('/:id/notes', authenticate, checkPermission('meetings.read'), getMeetingNotes);
router.post('/:id/notes', authenticate, checkPermission('meetings.update'), addMeetingNote);
router.put('/:id/notes/:noteId', authenticate, checkPermission('meetings.update'), updateMeetingNote);
router.delete('/:id/notes/:noteId', authenticate, checkPermission('meetings.update'), deleteMeetingNote);

export default router;
