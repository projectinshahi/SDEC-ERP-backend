import { Request, Response } from 'express';
import prisma from '../config/db.js';

/**
 * GET /api/meetings
 * Returns all meetings with related project and organizer
 */
export const getMeetings = async (req: Request, res: Response) => {
  try {
    const meetings = await prisma.meeting.findMany({
      orderBy: { meetingDate: 'desc' },
      include: {
        project: { select: { id: true, name: true } },
        organizer: { select: { id: true, name: true, email: true } },
      },
    });
    return res.status(200).json({ success: true, data: meetings });
  } catch (error) {
    console.error('Error fetching meetings:', error);
    return res.status(500).json({ success: false, message: 'Server error fetching meetings' });
  }
};

/**
 * GET /api/meetings/:id
 */
export const getMeetingById = async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id as string);
    if (isNaN(id)) {
      return res.status(400).json({ success: false, message: 'Invalid meeting ID' });
    }

    const meeting = await prisma.meeting.findUnique({
      where: { id },
      include: {
        project: { select: { id: true, name: true } },
        organizer: { select: { id: true, name: true, email: true } },
        actionItems: true,
      },
    });

    if (!meeting) {
      return res.status(404).json({ success: false, message: 'Meeting not found' });
    }

    return res.status(200).json({ success: true, data: meeting });
  } catch (error) {
    console.error('Error fetching meeting:', error);
    return res.status(500).json({ success: false, message: 'Server error fetching meeting' });
  }
};

/**
 * POST /api/meetings
 * Create a new meeting
 */
export const createMeeting = async (req: Request, res: Response) => {
  try {
    const { title, description, projectId, meetingType, meetingDate, startTime, endTime, location, meetingLink, attendees, notes } = req.body;
    const organizerId = (req as any).userId; // Fixed: use userId instead of user?.id

    // Validation
    if (!title || !projectId || !meetingType || !meetingDate || !startTime || !endTime || !organizerId) {
      return res.status(400).json({ success: false, message: 'Missing required fields' });
    }

    const meeting = await prisma.meeting.create({
      data: {
        title,
        description: description || null,
        projectId,
        meetingType,
        meetingDate: new Date(meetingDate),
        startTime,
        endTime,
        location: location || null,
        meetingLink: meetingLink || null,
        organizerId,
        attendees: attendees || [],
        notes: notes || null,
      },
      include: {
        project: { select: { id: true, name: true } },
        organizer: { select: { id: true, name: true, email: true } },
      },
    });

    return res.status(201).json({ success: true, data: meeting, message: 'Meeting created successfully' });
  } catch (error) {
    console.error('Error creating meeting:', error);
    return res.status(500).json({ success: false, message: 'Server error creating meeting' });
  }
};

/**
 * PUT /api/meetings/:id
 * Update a meeting
 */
export const updateMeeting = async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id as string);
    if (isNaN(id)) {
      return res.status(400).json({ success: false, message: 'Invalid meeting ID' });
    }

    const { title, description, meetingType, meetingDate, startTime, endTime, location, meetingLink, attendees, notes, status } = req.body;

    const meeting = await prisma.meeting.update({
      where: { id },
      data: {
        title: title || undefined,
        description: description !== undefined ? description : undefined,
        meetingType: meetingType || undefined,
        meetingDate: meetingDate ? new Date(meetingDate) : undefined,
        startTime: startTime || undefined,
        endTime: endTime || undefined,
        location: location !== undefined ? location : undefined,
        meetingLink: meetingLink !== undefined ? meetingLink : undefined,
        attendees: attendees || undefined,
        notes: notes !== undefined ? notes : undefined,
        status: status || undefined,
      },
      include: {
        project: { select: { id: true, name: true } },
        organizer: { select: { id: true, name: true, email: true } },
      },
    });

    return res.status(200).json({ success: true, data: meeting, message: 'Meeting updated successfully' });
  } catch (error) {
    console.error('Error updating meeting:', error);
    return res.status(500).json({ success: false, message: 'Server error updating meeting' });
  }
};

/**
 * DELETE /api/meetings/:id
 * Delete a meeting
 */
export const deleteMeeting = async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id as string);
    if (isNaN(id)) {
      return res.status(400).json({ success: false, message: 'Invalid meeting ID' });
    }

    await prisma.meeting.delete({
      where: { id },
    });

    return res.status(200).json({ success: true, message: 'Meeting deleted successfully' });
  } catch (error) {
    console.error('Error deleting meeting:', error);
    return res.status(500).json({ success: false, message: 'Server error deleting meeting' });
  }
};
