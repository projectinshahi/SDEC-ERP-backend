import { Request, Response } from 'express';
import { timingSafeEqual } from 'crypto';
import prisma from '../config/db.js';
import { DEFAULT_PREFS, runDueReminders } from '../services/push.service.js';

const uid = (req: Request) => Number((req as any).userId);

const PLATFORMS = ['android', 'iOS'];
const MAX_TOKEN_LENGTH = 4096;

/* ── POST /api/devices  { token, platform } ───────────────────────────── */
export const registerDevice = async (req: Request, res: Response) => {
  try {
    const { token, platform } = req.body ?? {};
    if (typeof token !== 'string' || !token.trim() || token.length > MAX_TOKEN_LENGTH) {
      return res.status(400).json({ error: `token must be a non-empty string of at most ${MAX_TOKEN_LENGTH} characters` });
    }
    if (!PLATFORMS.includes(platform)) {
      return res.status(400).json({ error: `platform must be one of: ${PLATFORMS.join(', ')}` });
    }
    // Atomic upsert by token: a token already held by another user (shared phone,
    // re-login) moves to the caller — a phone only ever pushes to whoever is signed in.
    await prisma.$executeRaw`
      INSERT INTO device_tokens (user_id, token, platform)
      VALUES (${uid(req)}, ${token.trim()}, ${platform})
      ON CONFLICT (token) DO UPDATE
        SET user_id = EXCLUDED.user_id, platform = EXCLUDED.platform, updated_at = now()`;
    return res.status(204).end();
  } catch (error: any) {
    // No token in the log.
    console.error('[Devices] Failed to register device:', error?.code ?? error?.name);
    return res.status(500).json({ error: 'Failed to register device' });
  }
};

/* ── DELETE /api/devices/:token — only the caller's own; 204 either way ── */
export const unregisterDevice = async (req: Request, res: Response) => {
  try {
    await prisma.device_tokens.deleteMany({ where: { token: String(req.params.token), user_id: uid(req) } });
    return res.status(204).end();
  } catch (error: any) {
    console.error('[Devices] Failed to unregister device:', error?.code ?? error?.name);
    return res.status(500).json({ error: 'Failed to unregister device' });
  }
};

/* ── Notification preferences ─────────────────────────────────────────── */
// API (camelCase) ↔ column (snake_case).
const PREF_FIELDS = {
  push: 'push',
  taskUpdates: 'task_updates',
  mentions: 'mentions',
  dueReminders: 'due_reminders',
} as const;

const serializePrefs = (p: typeof DEFAULT_PREFS) => ({
  push: p.push, taskUpdates: p.task_updates, mentions: p.mentions, dueReminders: p.due_reminders,
});

/* GET /api/notification-preferences */
export const getNotificationPreferences = async (req: Request, res: Response) => {
  try {
    const row = await prisma.notification_preferences.findUnique({ where: { user_id: uid(req) } });
    return res.status(200).json(serializePrefs(row ?? DEFAULT_PREFS));
  } catch (error) {
    console.error('[Prefs] Failed to load preferences:', error);
    return res.status(500).json({ error: 'Failed to load notification preferences' });
  }
};

/* PUT /api/notification-preferences — any subset of the four booleans */
export const updateNotificationPreferences = async (req: Request, res: Response) => {
  try {
    const body = req.body ?? {};
    const data: Partial<typeof DEFAULT_PREFS> = {};
    for (const [key, column] of Object.entries(PREF_FIELDS)) {
      if (body[key] === undefined) continue;
      if (typeof body[key] !== 'boolean') return res.status(400).json({ error: `${key} must be a boolean` });
      data[column] = body[key];
    }
    const userId = uid(req);
    const row = await prisma.notification_preferences.upsert({
      where: { user_id: userId },
      update: data,
      create: { user_id: userId, ...data },
    });
    return res.status(200).json(serializePrefs(row));
  } catch (error) {
    console.error('[Prefs] Failed to update preferences:', error);
    return res.status(500).json({ error: 'Failed to update notification preferences' });
  }
};

/* ── POST /api/internal/due-reminders — external scheduler (Render Cron Job) ── */
export const runDueRemindersCron = async (req: Request, res: Response) => {
  const secret = process.env.CRON_SECRET;
  const given = Buffer.from(req.get('x-cron-secret') ?? '');
  // Unset CRON_SECRET = endpoint disabled, never "open".
  if (!secret || given.length !== Buffer.byteLength(secret) || !timingSafeEqual(given, Buffer.from(secret))) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const sent = await runDueReminders();
    return res.status(200).json({ sent });
  } catch (error) {
    console.error('[DueReminders] run failed:', error);
    return res.status(500).json({ error: 'Failed to run due reminders' });
  }
};
