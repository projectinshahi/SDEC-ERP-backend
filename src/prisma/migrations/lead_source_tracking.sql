-- Lead Source Tracking migration
-- Apply with: psql "$DATABASE_URL" -f src/prisma/migrations/lead_source_tracking.sql
-- (or run `npx prisma db push` to sync the whole schema). Safe to run more than once.

-- 1. Backfill any existing NULL/empty sources before tightening the column.
UPDATE "Lead" SET "source" = 'manual' WHERE "source" IS NULL OR btrim("source") = '';

-- 2. Make source required with a default so no lead can be persisted without one.
ALTER TABLE "Lead" ALTER COLUMN "source" SET DEFAULT 'manual';
ALTER TABLE "Lead" ALTER COLUMN "source" SET NOT NULL;

-- 3. Add the review flag used when a source is defaulted or a duplicate is detected.
ALTER TABLE "Lead" ADD COLUMN IF NOT EXISTS "flaggedForReview" BOOLEAN NOT NULL DEFAULT false;

-- 4. Allow activity logs to reference a lead (Lead Created / Source Assigned / Source Updated).
ALTER TABLE "activity_logs" ADD COLUMN IF NOT EXISTS "lead_id" INTEGER;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'activity_logs_lead_id_fkey'
  ) THEN
    ALTER TABLE "activity_logs"
      ADD CONSTRAINT "activity_logs_lead_id_fkey"
      FOREIGN KEY ("lead_id") REFERENCES "Lead"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END$$;

-- 5. Helpful index for source-based filtering / reporting.
CREATE INDEX IF NOT EXISTS "Lead_source_idx" ON "Lead" ("source");
