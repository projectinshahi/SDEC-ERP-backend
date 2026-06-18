import { Router } from 'express';
import { getMeetings, getMeetingAnalytics, getMeetingById, createMeeting, updateMeeting, deleteMeeting } from '../controllers/meeting.controller.js';
import { getMeetingNotes, addMeetingNote, updateMeetingNote, deleteMeetingNote } from '../controllers/meeting_note.controller.js';
import { authenticate } from '../middleware/auth.middleware.js';
import { checkProjectRole } from '../middleware/auth.middleware.js';

const router = Router();

router.get('/', authenticate, getMeetings);
// Live analytics — registered BEFORE '/:id' so it is never captured as an id.
router.get('/analytics', authenticate, getMeetingAnalytics);
router.get('/:id', authenticate, getMeetingById);
router.post('/', authenticate, createMeeting);
router.put('/:id', authenticate, updateMeeting);
router.delete('/:id', authenticate, deleteMeeting);

// Meeting Notes Routes
router.get('/:id/notes', authenticate, getMeetingNotes);
router.post('/:id/notes', authenticate, addMeetingNote);
router.put('/:id/notes/:noteId', authenticate, updateMeetingNote);
router.delete('/:id/notes/:noteId', authenticate, deleteMeetingNote);

export default router;
