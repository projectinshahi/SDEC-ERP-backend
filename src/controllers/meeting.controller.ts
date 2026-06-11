import { Request, Response } from 'express';
import prisma from '../config/db.js';
import { activityService } from '../services/activity.service.js';
import { notificationService } from '../services/notification.service.js';
import {
  createGoogleCalendarEvent,
  updateGoogleCalendarEvent,
  deleteGoogleCalendarEvent,
} from '../utils/googleCalendar.js';

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

    // Fetch attendees emails
    let attendeeEmails: string[] = [];
    if (attendees && attendees.length > 0) {
      const users = await prisma.users.findMany({
        where: { id: { in: attendees } },
        select: { email: true }
      });
      attendeeEmails = users.map(u => u.email).filter(Boolean);
    }

    // Generate Google Meet Link
    let generatedEventId = null;
    let generatedMeetLink = meetingLink || null; // fallback

    try {
      // Calculate Date objects for Google Calendar
      const [startHour, startMinute] = startTime.split(':').map(Number);
      const [endHour, endMinute] = endTime.split(':').map(Number);
      
      const startDateTime = new Date(meetingDate);
      startDateTime.setHours(startHour, startMinute, 0, 0);

      const endDateTime = new Date(meetingDate);
      endDateTime.setHours(endHour, endMinute, 0, 0);

      const gcal = await createGoogleCalendarEvent({
        title,
        description: description || '',
        startTime: startDateTime,
        endTime: endDateTime,
        timeZone: 'Asia/Kolkata',
        attendees: attendeeEmails,
      });

      if (gcal.eventId) generatedEventId = gcal.eventId;
      if (gcal.meetLink) generatedMeetLink = gcal.meetLink;
    } catch (e) {
      console.error('Failed to generate Google Meet link', e);
      // Fallback: Proceed with meeting creation even if Meet link generation fails
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
        meetingLink: generatedMeetLink,
        googleEventId: generatedEventId,
        organizerId,
        attendees: attendees || [],
        notes: notes || null,
      },
      include: {
        project: { select: { id: true, name: true } },
        organizer: { select: { id: true, name: true, email: true } },
      },
    });

    if (organizerId) {
      await activityService.logActivity({
        actorUserId: organizerId,
        projectId: projectId,
        type: 'meeting_created',
        description: `Created a new Meeting: ${title}`
      });
    }

    // Send notifications to attendees
    if (attendees && attendees.length > 0) {
      await notificationService.createNotifications(attendees, {
        type: 'meeting',
        title: 'New Meeting Scheduled',
        message: `You have been invited to a new meeting: ${title} on ${new Date(meetingDate).toLocaleDateString()}. ${generatedMeetLink ? 'Join link: ' + generatedMeetLink : ''}`,
        entityType: 'meeting',
        entityId: meeting.id
      });
    }

    let responseMessage = 'Meeting created successfully';
    if (!generatedMeetLink) {
      responseMessage = 'Meeting created, but Google Meet link generation failed. Please check Google credentials.';
    }

    return res.status(201).json({ success: true, data: meeting, message: responseMessage });
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

    const existingMeeting = await prisma.meeting.findUnique({ where: { id } });
    if (!existingMeeting) {
      return res.status(404).json({ success: false, message: 'Meeting not found' });
    }

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

    if (existingMeeting.googleEventId) {
      try {
        let attendeeEmails: string[] | undefined;
        if (attendees) {
          const users = await prisma.users.findMany({
            where: { id: { in: attendees } },
            select: { email: true }
          });
          attendeeEmails = users.map(u => u.email).filter(Boolean);
        }

        let startDateTime, endDateTime;
        if (startTime || meetingDate) {
          const targetDate = meetingDate ? new Date(meetingDate) : new Date(existingMeeting.meetingDate);
          const [startHour, startMinute] = (startTime || existingMeeting.startTime).split(':').map(Number);
          startDateTime = new Date(targetDate);
          startDateTime.setHours(startHour, startMinute, 0, 0);
        }
        if (endTime || meetingDate) {
          const targetDate = meetingDate ? new Date(meetingDate) : new Date(existingMeeting.meetingDate);
          const [endHour, endMinute] = (endTime || existingMeeting.endTime).split(':').map(Number);
          endDateTime = new Date(targetDate);
          endDateTime.setHours(endHour, endMinute, 0, 0);
        }

        await updateGoogleCalendarEvent(existingMeeting.googleEventId, {
          title: title,
          description: description,
          startTime: startDateTime,
          endTime: endDateTime,
          timeZone: 'Asia/Kolkata',
          attendees: attendeeEmails,
        });
      } catch (e) {
        console.error('Failed to update Google Meet event', e);
      }
    }

    const userId = Number((req as any).userId);
    if (userId) {
      await activityService.logActivity({
        actorUserId: userId,
        projectId: meeting.projectId,
        type: 'meeting_updated',
        description: `Updated Meeting: ${meeting.title}`
      });
    }

    if (attendees && attendees.length > 0) {
      await notificationService.createNotifications(attendees, {
        type: 'meeting',
        title: 'Meeting Updated',
        message: `The meeting "${title || existingMeeting.title}" has been updated.`,
        entityType: 'meeting',
        entityId: meeting.id
      });
    }

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

    const existingMeeting = await prisma.meeting.findUnique({ where: { id } });

    if (existingMeeting?.googleEventId) {
      try {
        await deleteGoogleCalendarEvent(existingMeeting.googleEventId);
      } catch (e) {
        console.error('Failed to delete Google Meet event', e);
      }
    }

    await prisma.meeting.delete({
      where: { id },
    });

    const userId = Number((req as any).userId);
    if (userId && existingMeeting) {
      await activityService.logActivity({
        actorUserId: userId,
        projectId: existingMeeting.projectId,
        type: 'meeting_deleted',
        description: `Deleted Meeting: ${existingMeeting.title}`
      });
    }

    if (existingMeeting && Array.isArray(existingMeeting.attendees) && existingMeeting.attendees.length > 0) {
      await notificationService.createNotifications(existingMeeting.attendees as number[], {
        type: 'meeting',
        title: 'Meeting Cancelled',
        message: `The meeting "${existingMeeting.title}" has been cancelled.`,
        entityType: 'meeting',
        entityId: id
      });
    }

    return res.status(200).json({ success: true, message: 'Meeting deleted successfully' });
  } catch (error) {
    console.error('Error deleting meeting:', error);
    return res.status(500).json({ success: false, message: 'Server error deleting meeting' });
  }
};
