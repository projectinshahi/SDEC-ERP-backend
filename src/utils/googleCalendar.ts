import { google } from 'googleapis';

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || 'https://developers.google.com/oauthplayground';
const REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN;

const oAuth2Client = new google.auth.OAuth2(
  CLIENT_ID,
  CLIENT_SECRET,
  REDIRECT_URI
);

if (REFRESH_TOKEN) {
  oAuth2Client.setCredentials({ refresh_token: REFRESH_TOKEN });
}

const calendar = google.calendar({ version: 'v3', auth: oAuth2Client });

export interface CreateEventParams {
  title: string;
  description?: string;
  startTime: Date;
  endTime: Date;
  timeZone?: string;
  attendees?: string[];
}

export const createGoogleCalendarEvent = async ({
  title,
  description,
  startTime,
  endTime,
  timeZone = 'Asia/Kolkata',
  attendees,
}: CreateEventParams) => {
  if (!CLIENT_ID || !CLIENT_SECRET || !REFRESH_TOKEN) {
    console.warn('Google Calendar credentials not fully configured. Skipping Meet generation.');
    return { eventId: null, meetLink: null };
  }

  try {
    const event = {
      summary: title,
      description: description,
      start: {
        dateTime: startTime.toISOString(),
        timeZone,
      },
      end: {
        dateTime: endTime.toISOString(),
        timeZone,
      },
      attendees: attendees?.map(email => ({ email })),
      conferenceData: {
        createRequest: {
          requestId: `sdec-meet-${Date.now()}-${Math.random().toString(36).substring(7)}`,
          conferenceSolutionKey: {
            type: 'hangoutsMeet',
          },
        },
      },
    };

    const response = await calendar.events.insert({
      calendarId: 'primary',
      requestBody: event,
      conferenceDataVersion: 1, // Required to generate Meet link
      sendUpdates: 'all',       // Send email invitations automatically
    });

    return {
      eventId: response.data.id || null,
      meetLink: response.data.hangoutLink || null,
    };
  } catch (error) {
    console.error('Error creating Google Calendar event:', error);
    throw new Error('Failed to create Google Meet link');
  }
};

export const updateGoogleCalendarEvent = async (
  eventId: string,
  {
    title,
    description,
    startTime,
    endTime,
    timeZone = 'Asia/Kolkata',
    attendees,
  }: Partial<CreateEventParams>
) => {
  if (!CLIENT_ID || !CLIENT_SECRET || !REFRESH_TOKEN) return;

  try {
    const currentEvent = await calendar.events.get({
      calendarId: 'primary',
      eventId,
    });

    const updatedEvent = {
      ...currentEvent.data,
      summary: title ?? currentEvent.data.summary,
      description: description ?? currentEvent.data.description,
      start: startTime ? { dateTime: startTime.toISOString(), timeZone } : currentEvent.data.start,
      end: endTime ? { dateTime: endTime.toISOString(), timeZone } : currentEvent.data.end,
      attendees: attendees ? attendees.map(email => ({ email })) : currentEvent.data.attendees,
    };

    await calendar.events.update({
      calendarId: 'primary',
      eventId,
      requestBody: updatedEvent,
      sendUpdates: 'all', // Send update emails automatically
    });
  } catch (error) {
    console.error('Error updating Google Calendar event:', error);
    // Not throwing here to allow local DB update to succeed even if Google fails
  }
};

export const deleteGoogleCalendarEvent = async (eventId: string) => {
  if (!CLIENT_ID || !CLIENT_SECRET || !REFRESH_TOKEN) return;

  try {
    await calendar.events.delete({
      calendarId: 'primary',
      eventId,
      sendUpdates: 'all', // Notify attendees of cancellation
    });
  } catch (error) {
    console.error('Error deleting Google Calendar event:', error);
    // Not throwing here to allow local DB delete to succeed
  }
};
