-- Phase 2.1 — Phone identity foundation on `users` (models: users.phone, users.phone_verified)
-- Apply with: psql "$DATABASE_URL" -f src/prisma/migrations/user_phone_identity.sql
-- Safe to run more than once (idempotent). Also applied automatically on backend
-- boot by src/config/initDb.ts — this file is only for applying it to an already
-- running database without a redeploy.
--
-- WHY NOT `prisma migrate dev`: this project has never used Prisma's migration
-- engine. `src/prisma/migrations/` holds hand-applied .sql files, PROD has no
-- _prisma_migrations table at all, and `prisma migrate diff` reports 238 lines of
-- pre-existing drift between the datamodel and the live DB (30 DROP FOREIGN KEY,
-- 5 DROP INDEX, 1 DROP COLUMN). Running migrate/db push would apply ALL of that
-- and destroy data far outside Phase 2. Additive, idempotent DDL is the safe and
-- established path here.
--
-- BACKWARD COMPATIBILITY: purely additive. Existing users have phone NULL and are
-- not read, written, or constrained by anything below. No data is deleted or
-- overwritten. Pre-check found ZERO duplicate phone numbers (raw or digits-only)
-- in either the DEV or PROD database, so the unique index below cannot fail.

-- 1. Verification flag. Data model ONLY in this phase — no OTP/SMS provider,
--    no verification API. Nothing sets this to true yet.
--    NOT NULL DEFAULT false is a metadata-only change on PG 11+ (no table rewrite),
--    so existing rows get `false` instantly.
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_verified BOOLEAN NOT NULL DEFAULT false;

-- 2. Unique + indexed phone.
--    A Postgres unique index ignores NULLs, so this is exactly "unique among
--    non-null phone numbers" — every existing user without a number is unaffected.
--    It doubles as the btree index that Phase 2.2 contact lookup needs.
--    Name matches the index Prisma's `@unique` generates, so `migrate diff` stays clean.
CREATE UNIQUE INDEX IF NOT EXISTS users_phone_key ON users (phone);

-- NOT DONE HERE — 5 PROD rows still hold pre-Phase-2 unnormalized phone numbers
-- (three bare 10-digit, two already +91XXXXXXXXXX). They are valid data and are
-- deliberately NOT rewritten by this migration. Phase 2.2 lookup will need them in
-- E.164; run a reviewed one-shot backfill through utils/phone.normalizePhone before
-- that phase rather than a blind UPDATE here.
