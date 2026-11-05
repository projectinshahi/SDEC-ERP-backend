import { initializeApp, cert } from 'firebase-admin/app';
import { getMessaging, type Messaging } from 'firebase-admin/messaging';
import prisma from '../config/db.js';
import { getMyTaskAudience } from '../utils/myTaskAccess.js';

/**
 * PUSH NOTIFICATIONS (Firebase Cloud Messaging) for the My Task mobile app.
 *
 * sendPush is the ONLY function that talks to FCM. Every caller fires it AFTER
 * its own DB writes and socket emits, and never awaits it on the request path —
 * a push failure can never delay or fail an HTTP response. It never throws.
 *
 * PRIVACY: logs carry error codes and counts only — never tokens, titles or bodies.
 *
 * Self-check: npx tsx src/services/push.service.selfcheck.ts
 */

export type PushCategory = 'taskUpdates' | 'mentions' | 'dueReminders' | 'messages';

export interface PushMessage {
  title: string;
  body: string;
  type: string;
  entityType: string;
  entityId: number | string;
}

type Sender = Pick<Messaging, 'sendEachForMulticast'>;
let messaging: Sender | null = null;

/** Called once at startup. No FIREBASE_SERVICE_ACCOUNT → one warning, every push a no-op. */
export function initPush() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT?.trim();
  if (!raw) {
    console.warn('⚠️  FIREBASE_SERVICE_ACCOUNT is not set — push notifications are disabled.');
    return;
  }
  try {
    // The service-account JSON itself, or the same JSON base64-encoded.
    const json = raw.startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
    messaging = getMessaging(initializeApp({ credential: cert(JSON.parse(json)) }));
    console.log('✅ Firebase push notifications enabled');
  } catch {
    // The parse error is deliberately not logged: its message can quote the key.
    console.error('❌ FIREBASE_SERVICE_ACCOUNT is not valid service-account JSON (or base64 of it) — push disabled.');
  }
}

/** Test hook: swap in a fake FCM sender (null = disabled). */
export function __setMessagingForTest(m: Sender | null) {
  messaging = m;
}

/** No notification_preferences row = these defaults. */
export const DEFAULT_PREFS = { push: true, task_updates: true, mentions: true, due_reminders: false };

/** 'messages' has no switch of its own — it follows `push` only. */
const CATEGORY_COLUMN = {
  taskUpdates: 'task_updates',
  mentions: 'mentions',
  dueReminders: 'due_reminders',
  messages: null,
} as const;

/** FCM reports these for tokens that will never work again — the only ones we delete. */
const DEAD_TOKEN_CODES = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
]);

const FCM_BATCH = 500;
const MAX_TEXT = 120;
export const truncate = (s: string, n = MAX_TEXT) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);

export async function sendPush(userIds: number[], msg: PushMessage, category: PushCategory): Promise<void> {
  try {
    if (!messaging) return;
    const ids = Array.from(new Set(userIds)).filter((id) => Number.isInteger(id) && id > 0);
    if (!ids.length) return;

    const prefs = await prisma.notification_preferences.findMany({ where: { user_id: { in: ids } } });
    const prefsByUser = new Map(prefs.map((p) => [p.user_id, p]));
    const column = CATEGORY_COLUMN[category];
    const allowed = ids.filter((id) => {
      const p = prefsByUser.get(id) ?? DEFAULT_PREFS;
      return p.push && (column === null || p[column]);
    });
    if (!allowed.length) return;

    const tokens = (await prisma.device_tokens.findMany({
      where: { user_id: { in: allowed } },
      select: { token: true },
    })).map((t) => t.token);
    if (!tokens.length) return;

    const dead: string[] = [];
    const otherErrors: Record<string, number> = {};
    for (let i = 0; i < tokens.length; i += FCM_BATCH) {
      const chunk = tokens.slice(i, i + FCM_BATCH);
      const res = await messaging.sendEachForMulticast({
        tokens: chunk,
        notification: { title: truncate(msg.title), body: truncate(msg.body) },
        data: { type: msg.type, entity_type: msg.entityType, entity_id: String(msg.entityId) },
        android: { priority: 'high', notification: { channelId: 'task_updates' } },
        apns: { payload: { aps: { sound: 'default' } } },
      });
      res.responses.forEach((r, j) => {
        if (r.success) return;
        const code = r.error?.code ?? 'unknown';
        if (DEAD_TOKEN_CODES.has(code)) dead.push(chunk[j]);
        else otherErrors[code] = (otherErrors[code] ?? 0) + 1;
      });
    }
    // Other failures may be payload/server problems — the token itself is fine, keep it.
    if (Object.keys(otherErrors).length) console.warn('[Push] some sends failed:', otherErrors);
    if (dead.length) await prisma.device_tokens.deleteMany({ where: { token: { in: dead } } });
  } catch (err: any) {
    console.error('[Push] send failed:', err?.code ?? err?.name ?? 'unknown error');
  }
}

const CLOSED_STATUSES = ['done', 'approved'];

/**
 * Fire-and-forget push about a My Task. Recipients are `to` (default: creator +
 * members), always narrowed to people on the task, minus the actor and `exclude`.
 * Skipped for done/approved tasks unless `includeClosed` (the status change itself).
 * Returns the promise only so tests can await it; callers use `void notifyTask(...)`.
 */
export async function notifyTask(
  taskId: number,
  actorId: number,
  build: (actorName: string, taskTitle: string) => { title: string; body: string },
  opts: { type: string; category?: PushCategory; to?: number[]; exclude?: number[]; includeClosed?: boolean },
): Promise<void> {
  try {
    const [task, audience, actor] = await Promise.all([
      prisma.my_tasks.findUnique({ where: { id: taskId }, select: { title: true, status: true } }),
      getMyTaskAudience(taskId),
      prisma.users.findUnique({ where: { id: actorId }, select: { name: true } }),
    ]);
    if (!task) return;
    if (!opts.includeClosed && CLOSED_STATUSES.includes(task.status)) return;

    const skip = new Set([actorId, ...(opts.exclude ?? [])]);
    const recipients = (opts.to ?? audience).filter((u) => audience.includes(u) && !skip.has(u));
    if (!recipients.length) return;

    const { title, body } = build(actor?.name || 'Someone', task.title);
    await sendPush(recipients, { title, body, type: opts.type, entityType: 'my_task', entityId: taskId }, opts.category ?? 'taskUpdates');
  } catch (err: any) {
    console.error('[Push] notifyTask failed:', err?.code ?? err?.name ?? 'unknown error');
  }
}

/* ── Due-date reminders ───────────────────────────────────────────────── */

// ponytail: fixed Asia/Kolkata offset (IST has no DST); swap for Intl-based
// zone math if the business timezone ever becomes configurable.
const BUSINESS_UTC_OFFSET_MIN = 330;
const REMINDER_WINDOW_MS = 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** due_date (a DATE at UTC midnight) + due_time ('HH:mm[:ss]', default 09:00) in business time → instant. */
export function dueInstant(dueDate: Date, dueTime: string | null): { at: Date; hhmm: string } {
  const m = /^(\d{1,2}):(\d{2})/.exec(dueTime ?? '');
  const h = m ? Number(m[1]) : 9;
  const min = m ? Number(m[2]) : 0;
  const at = new Date(
    Date.UTC(dueDate.getUTCFullYear(), dueDate.getUTCMonth(), dueDate.getUTCDate(), h, min) -
    BUSINESS_UTC_OFFSET_MIN * 60_000,
  );
  return { at, hhmm: `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}` };
}

/**
 * Send "Due soon" for every open task due within the next 60 minutes that has not
 * had one yet. Each task is CLAIMED (due_reminder_sent_at null → now) before the
 * push, so overlapping runs (cron + in-process timer) can never double-send.
 * Returns how many tasks were reminded.
 */
export async function runDueReminders(now: Date = new Date()): Promise<number> {
  const horizon = new Date(now.getTime() + REMINDER_WINDOW_MS);
  // Coarse DATE prefilter (±1 day absorbs the timezone offset); exact check below.
  const candidates = await prisma.my_tasks.findMany({
    where: {
      due_reminder_sent_at: null,
      status: { notIn: CLOSED_STATUSES },
      due_date: { gte: new Date(now.getTime() - DAY_MS), lte: new Date(horizon.getTime() + DAY_MS) },
    },
    select: {
      id: true, title: true, due_date: true, due_time: true, created_by: true, in_charge_id: true,
      members: { select: { user_id: true } },
    },
  });

  let sent = 0;
  for (const t of candidates) {
    if (!t.due_date) continue;
    const { at, hhmm } = dueInstant(t.due_date, t.due_time);
    if (at <= now || at > horizon) continue;

    const claimed = await prisma.my_tasks.updateMany({
      where: { id: t.id, due_reminder_sent_at: null },
      data: { due_reminder_sent_at: now },
    });
    if (claimed.count !== 1) continue;

    // Members + In-Charge; a personal task with no members reminds its creator.
    const ids = new Set(t.members.map((m) => m.user_id));
    if (t.in_charge_id) ids.add(t.in_charge_id);
    if (!ids.size) ids.add(t.created_by);

    await sendPush(
      [...ids],
      { title: 'Due soon', body: `${t.title} is due at ${hhmm}`, type: 'due_reminder', entityType: 'my_task', entityId: t.id },
      'dueReminders',
    );
    sent++;
  }
  return sent;
}
