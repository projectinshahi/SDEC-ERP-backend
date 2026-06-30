import { google } from 'googleapis';
import https from 'node:https';
import tls from 'node:tls';
import fs from 'node:fs';

/**
 * TLS trust configuration (opt-in; no effect unless set).
 *
 * Some networks (corporate proxies / antivirus with HTTPS inspection) present an
 * intercepting certificate that Node does not trust by default, so the Google
 * OAuth/Calendar calls fail with "unable to verify the first certificate" and NO
 * Meet link is generated. dotenv is loaded before this module, so .env values are
 * available here:
 *   • GOOGLE_CA_CERT_PATH    — path to the intercepting/corporate root CA (PEM).
 *                              SECURE: trusts that CA in addition to Node's bundle.
 *   • GOOGLE_INSECURE_TLS=true — DEV-ONLY escape hatch: disables verification.
 */
(() => {
  const caPath = process.env.GOOGLE_CA_CERT_PATH;
  const insecure = String(process.env.GOOGLE_INSECURE_TLS).toLowerCase() === 'true';
  try {
    if (caPath) {
      const extra = fs.readFileSync(caPath, 'utf8');
      https.globalAgent = new https.Agent({ ca: [...tls.rootCertificates, extra] });
      console.log('[GoogleCalendar] TLS: trusting extra CA from GOOGLE_CA_CERT_PATH.');
    } else if (insecure) {
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
      console.warn('[GoogleCalendar] ⚠ GOOGLE_INSECURE_TLS=true — TLS certificate verification is DISABLED. Development only; never use in production.');
    }
  } catch (e: any) {
    console.error('[GoogleCalendar] TLS configuration failed:', e?.message || e);
  }
})();

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
    return { eventId: null, meetLink: null, meetingCode: null };
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

    const data = response.data;
    // Google returns the Meet URL on `hangoutLink`, but for a freshly-created
    // conference the URL may instead live under conferenceData.entryPoints (the
    // 'video' entry point). Read BOTH so a valid link is never dropped — this is
    // the root cause of the "Meet link empty" bug.
    const meetLink =
      data.hangoutLink ||
      data.conferenceData?.entryPoints?.find((e) => e.entryPointType === 'video')?.uri ||
      data.conferenceData?.entryPoints?.find((e) => !!e.uri)?.uri ||
      null;

    return {
      eventId: data.id || null,
      meetLink,
      meetingCode: data.conferenceData?.conferenceId || null,
    };
  } catch (error: any) {
    // Surface the ACTUAL Google failure (OAuth expired, invalid refresh token,
    // conferenceData/permission denied) instead of a generic message, so the
    // caller can log it and return a meaningful response.
    const detail =
      error?.response?.data?.error?.message ||
      error?.errors?.[0]?.message ||
      error?.message ||
      'Unknown Google Calendar error';
    console.error('[GoogleCalendar] events.insert failed:', detail, error?.response?.data ?? '');
    throw new Error(detail);
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
