-- Push notifications (FCM): device tokens, per-user push preferences, due-reminder marker.
-- Apply with: psql "$DATABASE_URL" -f src/prisma/migrations/push_notifications.sql
-- Idempotent and purely additive. Also applied automatically on boot by
-- src/config/initDb.ts — this file is for an already-running database.

CREATE TABLE IF NOT EXISTS device_tokens (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token VARCHAR(4096) NOT NULL UNIQUE,
  platform VARCHAR(20) NOT NULL,
  created_at TIMESTAMP(6) NOT NULL DEFAULT now(),
  updated_at TIMESTAMP(6) NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS device_tokens_user_id_idx ON device_tokens (user_id);

CREATE TABLE IF NOT EXISTS notification_preferences (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  push BOOLEAN NOT NULL DEFAULT true,
  task_updates BOOLEAN NOT NULL DEFAULT true,
  mentions BOOLEAN NOT NULL DEFAULT true,
  due_reminders BOOLEAN NOT NULL DEFAULT false
);

ALTER TABLE my_tasks ADD COLUMN IF NOT EXISTS due_reminder_sent_at TIMESTAMP(6);
