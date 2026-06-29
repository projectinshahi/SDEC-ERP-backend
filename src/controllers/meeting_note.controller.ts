import { Request, Response } from 'express';
import prisma from '../config/db.js';
import { activityService } from '../services/activity.service.js';

export const getMeetingNotes = async (req: Request, res: Response): Promise<void> => {
  try {
    const meetingId = parseInt(req.params.id as string, 10);
    if (isNaN(meetingId)) {
      res.status(400).json({ error: 'Invalid meeting ID' });
      return;
    }

    const notes = await prisma.meetingNote.findMany({
      where: { meetingId },
      include: {
        author: { select: { id: true, name: true, email: true } },
        updater: { select: { id: true, name: true, email: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    res.status(200).json(notes);
  } catch (error) {
    console.error('Error fetching meeting notes:', error);
    res.status(500).json({ error: 'Failed to fetch meeting notes' });
  }
};

export const addMeetingNote = async (req: Request, res: Response): Promise<void> => {
  try {
    const meetingId = parseInt(req.params.id as string, 10);
    const userId = (req as any).userId;
    const { title, content } = req.body;

    if (isNaN(meetingId) || !title || !content) {
      res.status(400).json({ error: 'Meeting ID, title, and content are required' });
      return;
    }

    // Verify meeting exists to get projectId for activity logging
    const meeting = await prisma.meeting.findUnique({
      where: { id: meetingId },
    });

    if (!meeting) {
      res.status(404).json({ error: 'Meeting not found' });
      return;
    }

    const newNote = await prisma.meetingNote.create({
      data: {
        meetingId,
        title,
        content,
        createdBy: userId,
      },
      include: {
        author: { select: { id: true, name: true, email: true } },
        updater: { select: { id: true, name: true, email: true } },
      },
    });

    // Log activity
    await activityService.logActivity({
      actorUserId: userId,
      projectId: meeting.projectId || undefined,
      type: 'meeting_note_added',
      description: `Added a note "${title}" to meeting "${meeting.title}"`
    });

    res.status(201).json(newNote);
  } catch (error) {
    console.error('Error adding meeting note:', error);
    res.status(500).json({ error: 'Failed to add meeting note' });
  }
};

export const updateMeetingNote = async (req: Request, res: Response): Promise<void> => {
  try {
    const meetingId = parseInt(req.params.id as string, 10);
    const noteId = parseInt(req.params.noteId as string, 10);
    const userId = (req as any).userId;
    const userRole = ((req as any).userRole || '').toLowerCase();
    const { title, content } = req.body;

    if (isNaN(meetingId) || isNaN(noteId) || !title || !content) {
      res.status(400).json({ error: 'Invalid parameters' });
      return;
    }

    const note = await prisma.meetingNote.findUnique({
      where: { id: noteId },
      include: { meeting: true },
    });

    if (!note || note.meetingId !== meetingId) {
      res.status(404).json({ error: 'Note not found' });
      return;
    }

    // Permission check: Admins can edit any note, others can only edit their own
    const isAdmin = userRole === 'admin' || userRole === 'super admin';
    if (!isAdmin && note.createdBy !== userId) {
      res.status(403).json({ error: 'Forbidden: You can only edit your own notes' });
      return;
    }

    const updatedNote = await prisma.meetingNote.update({
      where: { id: noteId },
      data: {
        title,
        content,
        updatedBy: userId,
      },
      include: {
        author: { select: { id: true, name: true, email: true } },
        updater: { select: { id: true, name: true, email: true } },
      },
    });

    // Log activity
    await activityService.logActivity({
      actorUserId: userId,
      projectId: note.meeting.projectId || undefined,
      type: 'meeting_note_updated',
      description: `Updated note "${title}" in meeting "${note.meeting.title}"`
    });

    res.status(200).json(updatedNote);
  } catch (error) {
    console.error('Error updating meeting note:', error);
    res.status(500).json({ error: 'Failed to update meeting note' });
  }
};

export const deleteMeetingNote = async (req: Request, res: Response): Promise<void> => {
  try {
    const meetingId = parseInt(req.params.id as string, 10);
    const noteId = parseInt(req.params.noteId as string, 10);
    const userId = (req as any).userId;
    const userRole = ((req as any).userRole || '').toLowerCase();

    if (isNaN(meetingId) || isNaN(noteId)) {
      res.status(400).json({ error: 'Invalid parameters' });
      return;
    }

    const note = await prisma.meetingNote.findUnique({
      where: { id: noteId },
      include: { meeting: true },
    });

    if (!note || note.meetingId !== meetingId) {
      res.status(404).json({ error: 'Note not found' });
      return;
    }

    // Permission check: Admins can delete any note, others can only delete their own
    const isAdmin = userRole === 'admin' || userRole === 'super admin';
    if (!isAdmin && note.createdBy !== userId) {
      res.status(403).json({ error: 'Forbidden: You can only delete your own notes' });
      return;
    }

    await prisma.meetingNote.delete({
      where: { id: noteId },
    });

    // Log activity
    await activityService.logActivity({
      actorUserId: userId,
      projectId: note.meeting.projectId || undefined,
      type: 'meeting_note_deleted',
      description: `Deleted note "${note.title}" from meeting "${note.meeting.title}"`
    });

    res.status(200).json({ message: 'Note deleted successfully' });
  } catch (error) {
    console.error('Error deleting meeting note:', error);
    res.status(500).json({ error: 'Failed to delete meeting note' });
  }
};
