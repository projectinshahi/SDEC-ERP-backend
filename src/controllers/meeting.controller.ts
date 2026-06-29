import { Request, Response } from 'express';
import prisma from '../config/db.js';
import { activityService } from '../services/activity.service.js';
import { notificationService } from '../services/notification.service.js';
import {
  createGoogleCalendarEvent,
  updateGoogleCalendarEvent,
  deleteGoogleCalendarEvent,
} from '../utils/googleCalendar.js';
import { isGlobalAdmin } from '../utils/roles.js';

// Module discriminator set per-route (development = project meetings, the existing
// behavior; sales = lead/deal/customer/team meetings with per-user visibility).
type MeetingModule = 'development' | 'sales';
const getMeetingModule = (req: Request): MeetingModule =>
  ((req as any).meetingModule as MeetingModule) || 'development';
const isFounder = (req: Request): boolean => isGlobalAdmin((req as any).userRole || '');

// Human-readable labels for each meeting type — used for type-aware search.
const MEETING_TYPE_LABELS: Record<string, string> = {
  DAILY_STANDUP: 'Daily Standup', SPRINT_PLANNING: 'Sprint Planning',
  SPRINT_REVIEW: 'Sprint Review', RETROSPECTIVE: 'Retrospective',
  CLIENT_MEETING: 'Client Meeting', INTERNAL_DISCUSSION: 'Internal Discussion',
  BUG_REVIEW: 'Bug Review', EMERGENCY_MEETING: 'Emergency Meeting', OTHER: 'Other',
};

type DerivableMeeting = { status: string; meetingDate: Date; startTime: string; endTime: string };

/**
 * Live status of a meeting, derived from the clock (matching the badge logic on
 * the client). A meeting explicitly marked CANCELLED stays cancelled; otherwise
 * it is UPCOMING (before start), ONGOING (between start/end), or COMPLETED.
 */
function deriveStatus(m: DerivableMeeting, now: Date): 'UPCOMING' | 'ONGOING' | 'COMPLETED' | 'CANCELLED' {
  if (m.status === 'CANCELLED') return 'CANCELLED';
  const dateStr = new Date(m.meetingDate).toISOString().split('T')[0];
  const start = new Date(`${dateStr}T${(m.startTime || '00:00')}:00`);
  if (isNaN(start.getTime())) return m.status === 'COMPLETED' ? 'COMPLETED' : 'UPCOMING';
  const end = m.endTime ? new Date(`${dateStr}T${m.endTime}:00`) : null;
  if (now < start) return 'UPCOMING';
  if (end && now > end) return 'COMPLETED';
  return 'ONGOING';
}

/**
 * GET /api/meetings
 * Server-side search + filtering + pagination. Search spans title, description,
 * project name, organizer name and meeting type. Filters: type, status (live,
 * clock-derived), project, organizer, date range. Every meeting in the page
 * carries a `computedStatus` so the client renders the badge without re-deriving.
 */
export const getMeetings = async (req: Request, res: Response) => {
  try {
    const q = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
    const search = q(req.query.search);
    const type = q(req.query.type);
    const statusFilter = q(req.query.status);
    const projectId = q(req.query.projectId);
    const organizerId = q(req.query.organizerId);
    const dateFrom = q(req.query.dateFrom);
    const dateTo = q(req.query.dateTo);
    const page = Math.max(1, parseInt(q(req.query.page) || '1') || 1);
    const limit = Math.min(100, Math.max(1, parseInt(q(req.query.limit) || '10') || 10));

    const module = getMeetingModule(req);
    const founder = isFounder(req);
    const userId = Number((req as any).userId);

    const where: any = { module };
    if (module === 'sales') {
      const leadId = parseInt(q(req.query.leadId));
      if (!isNaN(leadId)) where.leadId = leadId;
      const dealId = parseInt(q(req.query.dealId));
      if (!isNaN(dealId)) where.dealId = dealId;
    }
    if (type && type !== 'ALL') where.meetingType = type;
    if (projectId && projectId !== 'ALL') where.projectId = projectId;
    if (organizerId && organizerId !== 'ALL') {
      const oid = parseInt(organizerId);
      if (!isNaN(oid)) where.organizerId = oid;
    }
    if (dateFrom || dateTo) {
      where.meetingDate = {};
      if (dateFrom) where.meetingDate.gte = new Date(dateFrom);
      if (dateTo) {
        const d = new Date(dateTo);
        d.setHours(23, 59, 59, 999);
        where.meetingDate.lte = d;
      }
    }
    const andClauses: any[] = [];
    if (search) {
      const matchingTypes = Object.entries(MEETING_TYPE_LABELS)
        .filter(([, label]) => label.toLowerCase().includes(search.toLowerCase()))
        .map(([val]) => val);
      andClauses.push({
        OR: [
          { title: { contains: search, mode: 'insensitive' } },
          { description: { contains: search, mode: 'insensitive' } },
          { project: { is: { name: { contains: search, mode: 'insensitive' } } } },
          { organizer: { is: { name: { contains: search, mode: 'insensitive' } } } },
          ...(matchingTypes.length ? [{ meetingType: { in: matchingTypes as any } }] : []),
        ],
      });
    }
    // Sales visibility: a non-founder only sees meetings they organize or attend.
    if (module === 'sales' && !founder) {
      andClauses.push({ OR: [{ organizerId: userId }, { attendees: { has: userId } }] });
    }
    if (andClauses.length) where.AND = andClauses;

    // Fetch the SQL-filtered set, then derive live status and paginate in JS
    // (status is clock-derived and can't be expressed in the SQL WHERE).
    const rows = await prisma.meeting.findMany({
      where,
      orderBy: { meetingDate: 'desc' },
      include: {
        project: { select: { id: true, name: true } },
        organizer: { select: { id: true, name: true, email: true } },
        lead: { select: { id: true, title: true } },
        deal: { select: { id: true, title: true } },
        customer: { select: { id: true, name: true } },
        team: { select: { id: true, name: true } },
      },
    });

    const now = new Date();
    let withStatus = rows.map((m) => ({ ...m, computedStatus: deriveStatus(m, now) }));
    if (statusFilter && statusFilter !== 'ALL') {
      withStatus = withStatus.filter((m) => m.computedStatus === statusFilter);
    }

    const total = withStatus.length;
    const totalPages = Math.max(1, Math.ceil(total / limit));
    const safePage = Math.min(page, totalPages);
    const data = withStatus.slice((safePage - 1) * limit, safePage * limit);

    return res.status(200).json({
      success: true,
      data,
      pagination: { total, page: safePage, limit, totalPages },
    });
  } catch (error) {
    console.error('Error fetching meetings:', error);
    return res.status(500).json({ success: false, message: 'Server error fetching meetings' });
  }
};

/**
 * GET /api/meetings/analytics
 * Organization-wide, fully live meeting metrics. Single lightweight scan +
 * JS aggregation (no groupBy). Returns the KPI counts, per-type counts, and the
 * total of pending (non-completed) action items across every meeting.
 */
export const getMeetingAnalytics = async (req: Request, res: Response) => {
  try {
    const module = getMeetingModule(req);
    const founder = isFounder(req);
    const userId = Number((req as any).userId);
    const scope: any = { module };
    if (module === 'sales' && !founder) {
      scope.OR = [{ organizerId: userId }, { attendees: { has: userId } }];
    }
    const [meetings, openActionItems] = await Promise.all([
      prisma.meeting.findMany({
        where: scope,
        select: { status: true, meetingDate: true, startTime: true, endTime: true, meetingType: true },
      }),
      prisma.actionItem.count({ where: { status: { not: 'COMPLETED' }, meeting: { is: scope } } }),
    ]);

    const now = new Date();
    let scheduled = 0, completed = 0, ongoing = 0, upcoming = 0, cancelled = 0;
    const meetingTypeCounts: Record<string, number> = {};
    for (const key of Object.keys(MEETING_TYPE_LABELS)) meetingTypeCounts[key] = 0;

    for (const m of meetings) {
      if (m.status === 'SCHEDULED') scheduled++;
      const ds = deriveStatus(m, now);
      if (ds === 'COMPLETED') completed++;
      else if (ds === 'ONGOING') ongoing++;
      else if (ds === 'UPCOMING') upcoming++;
      else if (ds === 'CANCELLED') cancelled++;
      meetingTypeCounts[m.meetingType] = (meetingTypeCounts[m.meetingType] || 0) + 1;
    }

    return res.status(200).json({
      success: true,
      data: {
        totalMeetings: meetings.length,
        scheduled,
        completed,
        ongoing,
        upcoming,
        cancelled,
        openActionItems,
        meetingTypeCounts,
      },
    });
  } catch (error) {
    console.error('Error fetching meeting analytics:', error);
    return res.status(500).json({ success: false, message: 'Server error fetching meeting analytics' });
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
        lead: { select: { id: true, title: true } },
        deal: { select: { id: true, title: true } },
        customer: { select: { id: true, name: true } },
        team: { select: { id: true, name: true } },
        actionItems: true,
      },
    });

    if (!meeting) {
      return res.status(404).json({ success: false, message: 'Meeting not found' });
    }

    // Sales visibility: a non-founder may only open meetings they organize/attend.
    const userId = Number((req as any).userId);
    if (meeting.module === 'sales' && !isFounder(req) && meeting.organizerId !== userId && !(meeting.attendees as number[]).includes(userId)) {
      return res.status(403).json({ success: false, message: 'Forbidden: you do not have access to this meeting' });
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
    const { title, description, projectId, meetingType, meetingDate, startTime, endTime, location, meetingLink, attendees, notes, actionItems, leadId, dealId, customerId, teamId } = req.body;
    const organizerId = (req as any).userId; // Fixed: use userId instead of user?.id
    const module = getMeetingModule(req);

    // Validation — development meetings require a project; sales meetings do not
    // (they link a lead/deal/customer/team instead).
    const requireProject = module === 'development';
    if (!title || (requireProject && !projectId) || !meetingType || !meetingDate || !startTime || !endTime || !organizerId) {
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
        projectId: projectId || null,
        module,
        leadId: leadId ?? null,
        dealId: dealId ?? null,
        customerId: customerId ?? null,
        teamId: teamId ?? null,
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
        lead: { select: { id: true, title: true } },
        deal: { select: { id: true, title: true } },
        customer: { select: { id: true, name: true } },
        team: { select: { id: true, name: true } },
      },
    });

    // Persist any action items supplied with the meeting (title + assignee
    // required; due date / priority optional). Invalid rows are skipped.
    if (Array.isArray(actionItems) && actionItems.length > 0) {
      const rows = actionItems
        .filter((a: any) => a && a.title && a.assignedTo)
        .map((a: any) => ({
          meetingId: meeting.id,
          title: String(a.title).slice(0, 255),
          description: a.description ? String(a.description) : null,
          assignedTo: Number(a.assignedTo),
          dueDate: a.dueDate ? new Date(a.dueDate) : null,
          priority: (a.priority || 'MEDIUM') as any,
        }))
        .filter((a) => !isNaN(a.assignedTo));
      if (rows.length > 0) {
        await prisma.actionItem.createMany({ data: rows });
      }
    }

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

    const { title, description, meetingType, meetingDate, startTime, endTime, location, meetingLink, attendees, notes, status, leadId, dealId, customerId, teamId } = req.body;

    const existingMeeting = await prisma.meeting.findUnique({ where: { id } });
    if (!existingMeeting) {
      return res.status(404).json({ success: false, message: 'Meeting not found' });
    }
    // Sales visibility: a non-founder may only edit meetings they organize/attend.
    const actorId = Number((req as any).userId);
    if (existingMeeting.module === 'sales' && !isFounder(req) && existingMeeting.organizerId !== actorId && !(existingMeeting.attendees as number[]).includes(actorId)) {
      return res.status(403).json({ success: false, message: 'Forbidden: you do not have access to this meeting' });
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
        leadId: leadId !== undefined ? leadId : undefined,
        dealId: dealId !== undefined ? dealId : undefined,
        customerId: customerId !== undefined ? customerId : undefined,
        teamId: teamId !== undefined ? teamId : undefined,
      },
      include: {
        project: { select: { id: true, name: true } },
        organizer: { select: { id: true, name: true, email: true } },
        lead: { select: { id: true, title: true } },
        deal: { select: { id: true, title: true } },
        customer: { select: { id: true, name: true } },
        team: { select: { id: true, name: true } },
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
        projectId: meeting.projectId || undefined,
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
    if (!existingMeeting) {
      return res.status(404).json({ success: false, message: 'Meeting not found' });
    }
    // Sales visibility: a non-founder may only delete meetings they organize/attend.
    const actorId = Number((req as any).userId);
    if (existingMeeting.module === 'sales' && !isFounder(req) && existingMeeting.organizerId !== actorId && !(existingMeeting.attendees as number[]).includes(actorId)) {
      return res.status(403).json({ success: false, message: 'Forbidden: you do not have access to this meeting' });
    }

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
        projectId: existingMeeting.projectId || undefined,
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
