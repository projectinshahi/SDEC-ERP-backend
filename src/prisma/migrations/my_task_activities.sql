-- My Tasks Activity Timeline table (model my_task_activities)
-- Apply with: psql "$DATABASE_URL" -f src/prisma/migrations/my_task_activities.sql
-- Safe to run more than once (idempotent). Also created automatically on backend
-- boot by src/config/initDb.ts — this file is only for applying it to an already
-- running database without a redeploy.
--
-- Fixes Prisma P2021 (public.my_task_activities does not exist): /api/my-tasks/workspace
-- INCLUDEs the `activities` relation, so a missing table makes the whole endpoint throw.

CREATE TABLE IF NOT EXISTS my_task_activities (
  id SERIAL PRIMARY KEY,
  task_id INTEGER NOT NULL REFERENCES my_tasks(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  action VARCHAR(255) NOT NULL,
  details JSONB DEFAULT '{}',
  created_at TIMESTAMP(6) NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS my_task_activities_task_id_idx ON my_task_activities (task_id);
