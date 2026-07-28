import prisma from './db.js';
import { createHash } from 'crypto';

/** SHA-256 hash function */
function hashPassword(plain: string): string {
  return createHash('sha256').update(plain).digest('hex');
}
export const initDb = async () => {
  console.log('🔄 Initializing database schema and configurations...');
  try {
    // 0. Ensure users table exists with all required columns (including password)
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        email VARCHAR(255) UNIQUE NOT NULL,
        password VARCHAR(255),
        role VARCHAR(255) DEFAULT 'User',
        status VARCHAR(50) DEFAULT 'active',
        "resetPasswordToken" VARCHAR(255),
        "resetPasswordExpires" TIMESTAMP,
        "createdAt" TIMESTAMP DEFAULT NOW()
      );
    `);
    // Add missing columns if they don't exist
    await prisma.$executeRawUnsafe(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS password VARCHAR(255);
    `);
    await prisma.$executeRawUnsafe(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS phone VARCHAR(50);
    `);
    await prisma.$executeRawUnsafe(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS "resetPasswordToken" VARCHAR(255);
    `);
    await prisma.$executeRawUnsafe(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS "resetPasswordExpires" TIMESTAMP;
    `);
    console.log('✅ "users" table is verified (with all required columns including phone).');

    // ✅ SEED ADMIN USER if no users exist
    const userCount = await prisma.$queryRawUnsafe<any[]>(
      'SELECT COUNT(*) as count FROM users;'
    );
    const existingUsers = Number(userCount[0]?.count || 0);

    if (existingUsers === 0) {
      console.log('📧 No users found. Seeding admin user...');
      const adminEmail = 'admin@gmail.com';
      const adminPassword = 'admin123';
      const hashedPassword = hashPassword(adminPassword);

      await prisma.$executeRawUnsafe(
        `INSERT INTO users (name, email, password, role, status) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (email) DO NOTHING;`,
        'ERP Admin',
        adminEmail,
        hashedPassword,
        'admin',
        'active'
      );
      console.log(`✅ Admin user seeded: ${adminEmail}`);
    }

    // ✅ SEED FOUNDER USER (idempotent — skips if email already exists)
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (name, email, password, role, status) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (email) DO NOTHING;`,
      'Founder',
      'founder@gmail.com',
      hashPassword('Founder@123'),
      'Super Admin',
      'active'
    );
    console.log('✅ Founder user seeded/verified: founder@gmail.com');

    // Ensure roles table exists
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS roles (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) UNIQUE NOT NULL,
        description TEXT DEFAULT '',
        permissions JSONB DEFAULT '[]',
        "createdAt" TIMESTAMP DEFAULT NOW()
      );
    `);
    console.log('✅ "roles" table is verified.');

    // Employee = self-service staff. ONLY the Staff-Leave permissions, so the HR
    // module opens on the Leave page and the sidebar shows Leave only. Deliberately
    // NO 'hr.view': that is a broad HR-admin grant that would unlock every HR page
    // (all HR sidebar items OR-in hr.view) and — via the hr.leave.view backfill
    // below — HR-Admin leave (view/approve ALL employees' leave). Leave routes and
    // the Leave page gate on hr.leave.self, so employees need only that.
    await prisma.$executeRawUnsafe(`
      INSERT INTO roles (name, description, permissions)
      VALUES (
        'Employee',
        'Self-service employee role — can only view and manage their own leave requests',
        '["hr.leave.self", "hr.leave.apply"]'::jsonb
      )
      ON CONFLICT (name) DO UPDATE
        SET permissions = '["hr.leave.self", "hr.leave.apply"]'::jsonb;
    `);
    console.log('✅ "Employee" role seeded/verified with hr.leave.self, hr.leave.apply (staff leave self-service).');


    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS column_config (
        id SERIAL PRIMARY KEY,
        table_name VARCHAR(255) NOT NULL,
        column_key VARCHAR(255) NOT NULL,
        column_label VARCHAR(255) NOT NULL,
        is_visible BOOLEAN DEFAULT TRUE,
        order_index INTEGER NOT NULL,
        CONSTRAINT unique_table_column UNIQUE (table_name, column_key)
      );
    `);
    console.log('✅ "column_config" table is verified.');

    // 2. Seed default users table column configs
    await prisma.$executeRawUnsafe(`
      INSERT INTO column_config (table_name, column_key, column_label, is_visible, order_index)
      VALUES 
        ('users', 'name', 'User Name', TRUE, 1),
        ('users', 'email', 'Email Address', TRUE, 2),
        ('users', 'role', 'Access Role', TRUE, 3),
        ('users', 'status', 'Status', TRUE, 4)
      ON CONFLICT (table_name, column_key) DO NOTHING;
    `);
    console.log('✅ Default column configurations seeded.');

    // 3. Create kanban_boards table
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS kanban_boards (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        project_name VARCHAR(255) NOT NULL DEFAULT '',
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    console.log('✅ "kanban_boards" table is verified.');

    // 4. Create kanban_columns table if it doesn't exist
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS kanban_columns (
        id VARCHAR(255) PRIMARY KEY,
        label VARCHAR(255) NOT NULL,
        order_index INTEGER NOT NULL
      );
    `);
    // Add board_id column if missing (safe upgrade for existing DBs)
    await prisma.$executeRawUnsafe(`
      ALTER TABLE kanban_columns ADD COLUMN IF NOT EXISTS board_id INTEGER;
    `);
    console.log('✅ "kanban_columns" table is verified (with board_id).');

    // 5. Create kanban_tasks table if it doesn't exist
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS kanban_tasks (
        id VARCHAR(255) PRIMARY KEY,
        title VARCHAR(255) NOT NULL,
        description TEXT,
        priority VARCHAR(50) NOT NULL,
        assignee VARCHAR(255) NOT NULL,
        status VARCHAR(255) NOT NULL,
        "dueDate" VARCHAR(50) NOT NULL,
        order_index INTEGER DEFAULT 0
      );
    `);
    // Add board_id column if missing (safe upgrade for existing DBs)
    await prisma.$executeRawUnsafe(`
      ALTER TABLE kanban_tasks ADD COLUMN IF NOT EXISTS board_id INTEGER;
    `);
    await prisma.$executeRawUnsafe(`
      ALTER TABLE kanban_tasks ADD COLUMN IF NOT EXISTS estimated_hours NUMERIC DEFAULT 0;
    `);
    await prisma.$executeRawUnsafe(`
      ALTER TABLE kanban_tasks ADD COLUMN IF NOT EXISTS actual_hours NUMERIC DEFAULT 0;
    `);
    await prisma.$executeRawUnsafe(`
      ALTER TABLE kanban_tasks ADD COLUMN IF NOT EXISTS origin_task_id VARCHAR(255);
    `);
    console.log('✅ "kanban_tasks" table is verified (with board_id, estimated_hours, actual_hours, origin_task_id).');

    // 5. Create project_members table if it doesn't exist
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS project_members (
        id SERIAL PRIMARY KEY,
        project_id VARCHAR(255) NOT NULL,
        user_id INTEGER NOT NULL,
        role VARCHAR(50) NOT NULL DEFAULT 'viewer',
        CONSTRAINT unique_project_member UNIQUE (project_id, user_id)
      );
    `);
    console.log('✅ "project_members" table is verified.');

    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS project_categories (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) UNIQUE NOT NULL,
        order_index INTEGER NOT NULL DEFAULT 0,
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    await prisma.$executeRawUnsafe(`
      INSERT INTO project_categories (name, order_index, is_active)
      SELECT v.name, v.order_index, TRUE
      FROM (VALUES
        ('ERP', 1),
        ('E-Commerce', 2),
        ('Website', 3),
        ('Internal', 4),
        ('CRM', 5),
        ('Mobile App', 6),
        ('Web App', 7)
      ) AS v(name, order_index)
      WHERE NOT EXISTS (SELECT 1 FROM project_categories);
    `);
    // Classify projects: nullable category NAME (denormalized; renames cascade).
    await prisma.$executeRawUnsafe(`
      ALTER TABLE projects ADD COLUMN IF NOT EXISTS category VARCHAR(100);
    `);
    console.log('✅ "project_categories" table is verified and seeded; projects.category verified.');

    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "Customer" (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        email VARCHAR(255),
        phone VARCHAR(50),
        company VARCHAR(255),
        industry VARCHAR(100),
        website VARCHAR(255),
        address TEXT,
        status VARCHAR(50) DEFAULT 'active',
        "createdAt" TIMESTAMP DEFAULT NOW(),
        "updatedAt" TIMESTAMP DEFAULT NOW(),
        "ownerId" INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE
      );
    `);
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "Lead" (
        id SERIAL PRIMARY KEY,
        title VARCHAR(255) NOT NULL,
        description TEXT,
        source VARCHAR(100) NOT NULL DEFAULT 'manual',
        "flaggedForReview" BOOLEAN NOT NULL DEFAULT FALSE,
        status VARCHAR(50) NOT NULL DEFAULT 'new',
        stage VARCHAR(100) NOT NULL DEFAULT 'NQL',
        order_index INTEGER NOT NULL DEFAULT 0,
        priority VARCHAR(50) NOT NULL DEFAULT 'medium',
        score INTEGER NOT NULL DEFAULT 0,
        temperature VARCHAR(10) NOT NULL DEFAULT 'COLD',
        tags TEXT,
        "customerId" INTEGER REFERENCES "Customer"(id) ON DELETE SET NULL,
        "ownerId" INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        "createdAt" TIMESTAMP DEFAULT NOW(),
        "updatedAt" TIMESTAMP DEFAULT NOW()
      );
    `);

    // Safe-upgrade existing Lead/Customer tables with the pipeline columns.
    await prisma.$executeRawUnsafe(`
      ALTER TABLE "Lead" ADD COLUMN IF NOT EXISTS stage VARCHAR(100) NOT NULL DEFAULT 'NQL';
    `);
    await prisma.$executeRawUnsafe(`
      ALTER TABLE "Lead" ADD COLUMN IF NOT EXISTS order_index INTEGER NOT NULL DEFAULT 0;
    `);
    await prisma.$executeRawUnsafe(`
      ALTER TABLE "Lead" ADD COLUMN IF NOT EXISTS score INTEGER NOT NULL DEFAULT 0;
    `);
    // Lead Temperature (COLD / WARM / HOT) — classification that replaces score in the UI.
    await prisma.$executeRawUnsafe(`
      ALTER TABLE "Lead" ADD COLUMN IF NOT EXISTS temperature VARCHAR(10) NOT NULL DEFAULT 'COLD';
    `);
    // Backfill any pre-existing rows to the sensible default.
    await prisma.$executeRawUnsafe(`
      UPDATE "Lead" SET temperature = 'COLD' WHERE temperature IS NULL OR temperature = '';
    `);
    await prisma.$executeRawUnsafe(`
      ALTER TABLE "Lead" ADD COLUMN IF NOT EXISTS tags TEXT;
    `);
    // Customer district (CR-01). Nullable with NO backfill — existing Opportunities
    // stay blank until someone edits them, exactly as specified.
    await prisma.$executeRawUnsafe(`
      ALTER TABLE "Lead" ADD COLUMN IF NOT EXISTS district VARCHAR(100);
    `);
    await prisma.$executeRawUnsafe(`
      ALTER TABLE "Customer" ADD COLUMN IF NOT EXISTS address TEXT;
    `);
    // Customer columns added after the table's first release — a pre-existing
    // "Customer" table (created before these columns) is missing them, and the
    // CREATE TABLE IF NOT EXISTS above no-ops, so back-fill them here. Without
    // this, prisma.customer.findMany() throws P2022 "column does not exist".
    await prisma.$executeRawUnsafe(`
      ALTER TABLE "Customer" ADD COLUMN IF NOT EXISTS website VARCHAR(255);
    `);
    await prisma.$executeRawUnsafe(`
      ALTER TABLE "Customer" ADD COLUMN IF NOT EXISTS status VARCHAR(50) DEFAULT 'active';
    `);

    // ── Companies (CRM accounts) ──────────────────────────────────────────────
    // Central account entity extracted from the free-text `Customer.company` string
    // so Contacts + Pipeline share ONE normalized record (global dedup by lower(name)).
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS companies (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        industry VARCHAR(100),
        website VARCHAR(255),
        address TEXT,
        gst VARCHAR(50),
        notes TEXT,
        "ownerId" INTEGER REFERENCES users(id) ON DELETE SET NULL,
        "createdAt" TIMESTAMP DEFAULT NOW(),
        "updatedAt" TIMESTAMP DEFAULT NOW()
      );
    `);
    // Global dedup: at most one company per case-insensitive name.
    await prisma.$executeRawUnsafe(`
      CREATE UNIQUE INDEX IF NOT EXISTS companies_lower_name_uq ON companies (lower(name));
    `);
    // Contact ← Company link + the new contact fields.
    await prisma.$executeRawUnsafe(`
      ALTER TABLE "Customer" ADD COLUMN IF NOT EXISTS "companyId" INTEGER REFERENCES companies(id) ON DELETE SET NULL;
    `);
    await prisma.$executeRawUnsafe(`
      ALTER TABLE "Customer" ADD COLUMN IF NOT EXISTS designation VARCHAR(150);
    `);
    await prisma.$executeRawUnsafe(`
      ALTER TABLE "Customer" ADD COLUMN IF NOT EXISTS whatsapp VARCHAR(50);
    `);
    // One-time, idempotent data migration: pull every distinct Customer.company string
    // into a normalized Company row (global, case-insensitive), carrying the MOST
    // complete industry/website/address, then link each Contact to its Company. The
    // NOT EXISTS / companyId IS NULL guards make it a no-op on re-run and self-healing
    // for any new company strings added later.
    await prisma.$executeRawUnsafe(`
      INSERT INTO companies (name, industry, website, address, "ownerId", "createdAt", "updatedAt")
      SELECT DISTINCT ON (lower(trim(c.company)))
             trim(c.company), c.industry, c.website, c.address, c."ownerId", NOW(), NOW()
      FROM "Customer" c
      WHERE c.company IS NOT NULL AND trim(c.company) <> ''
        AND NOT EXISTS (SELECT 1 FROM companies co WHERE lower(co.name) = lower(trim(c.company)))
      ORDER BY lower(trim(c.company)),
               (CASE WHEN c.industry IS NOT NULL AND c.industry <> '' THEN 0 ELSE 1 END)
             + (CASE WHEN c.website  IS NOT NULL AND c.website  <> '' THEN 0 ELSE 1 END)
             + (CASE WHEN c.address  IS NOT NULL AND c.address  <> '' THEN 0 ELSE 1 END),
               c."createdAt";
    `);
    await prisma.$executeRawUnsafe(`
      UPDATE "Customer" c
      SET "companyId" = co.id
      FROM companies co
      WHERE lower(co.name) = lower(trim(c.company))
        AND c.company IS NOT NULL AND trim(c.company) <> ''
        AND c."companyId" IS NULL;
    `);

    // Pipeline (Opportunity) → Company link (Phase 2). Additive + backward-compatible:
    // existing Leads keep working unchanged; companyId is back-filled from each lead's
    // linked Contact's company so the Company↔Pipeline relationship is populated for
    // existing data. Idempotent (ADD IF NOT EXISTS + companyId IS NULL guard); self-heals
    // for new leads on the next boot. `customerId` remains the optional primary Contact.
    await prisma.$executeRawUnsafe(`
      ALTER TABLE "Lead" ADD COLUMN IF NOT EXISTS "companyId" INTEGER REFERENCES companies(id) ON DELETE SET NULL;
    `);
    await prisma.$executeRawUnsafe(`
      UPDATE "Lead" l
      SET "companyId" = c."companyId"
      FROM "Customer" c
      WHERE l."customerId" = c.id
        AND c."companyId" IS NOT NULL
        AND l."companyId" IS NULL;
    `);

    // Any pre-existing lead with no stage must still belong to exactly one stage
    // (NQL = the first stage of the standardized 8-stage funnel).
    await prisma.$executeRawUnsafe(`
      UPDATE "Lead" SET stage = 'NQL' WHERE stage IS NULL OR stage = '';
    `);
    console.log('✅ "Lead"/"Customer" pipeline columns verified.');

    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS lead_stages (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) UNIQUE NOT NULL,
        order_index INTEGER NOT NULL,
        is_default BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // ── Pipeline stages: the standardized 8-stage funnel is the single source of truth ──
    // NQL → MQL → SQL → PQL → SAL → WON → HOLD → LOST. Fresh install: seed the canonical
    // 8 (only when the board is empty).
    await prisma.$executeRawUnsafe(`
      INSERT INTO lead_stages (name, order_index, is_default)
      SELECT v.name, v.order_index, TRUE
      FROM (VALUES
        ('NQL', 1), ('MQL', 2), ('SQL', 3), ('PQL', 4),
        ('SAL', 5), ('WON', 6), ('HOLD', 7), ('LOST', 8)
      ) AS v(name, order_index)
      WHERE NOT EXISTS (SELECT 1 FROM lead_stages);
    `);

    // Existing installs: remap the previous taxonomy (legacy names, the 5-stage default,
    // and the Phase-3 unified deal stages) onto the 8-stage funnel. Cascades Lead.stage
    // (a name string with NO FK) FIRST, then merges/renames the lead_stages row. Idempotent
    // — every rename becomes a no-op once the board is already the funnel.
    const STAGE_REMAP: [string, string][] = [
      // legacy → …
      ['Contacted', 'MQL'], ['Interested', 'SQL'], ['Negotiating', 'PQL'],
      // canonical 5-stage default →
      ['New', 'NQL'], ['Discovery Meet', 'MQL'], ['BRD Shared', 'SQL'],
      ['Estimation Planning', 'PQL'], ['Proposal', 'SAL'],
      // Phase-3 unified deal stages → funnel
      ['Proposal Sent', 'SAL'], ['Demo Done', 'SAL'], ['Contract Review', 'SAL'],
      ['Negotiation', 'SAL'], ['Closed Won', 'WON'], ['Closed Lost', 'LOST'],
    ];
    for (const [oldName, newName] of STAGE_REMAP) {
      await prisma.$executeRawUnsafe(`UPDATE "Lead" SET stage = '${newName}' WHERE stage = '${oldName}';`);
      await prisma.$executeRawUnsafe(`
        DO $$
        BEGIN
          IF EXISTS (SELECT 1 FROM lead_stages WHERE name = '${newName}') THEN
            DELETE FROM lead_stages WHERE name = '${oldName}';
          ELSIF EXISTS (SELECT 1 FROM lead_stages WHERE name = '${oldName}') THEN
            UPDATE lead_stages SET name = '${newName}' WHERE name = '${oldName}';
          END IF;
        END $$;
      `);
    }

    const FUNNEL = ['NQL', 'MQL', 'SQL', 'PQL', 'SAL', 'WON', 'HOLD', 'LOST'];

    // Case-normalize any stray stage that is a funnel name in a DIFFERENT case (e.g. a legacy
    // lowercase 'won' left over from the old status-mirror). Merge it into the canonical stage
    // so it can never become a duplicate 9th column. Cascades Lead.stage first, then merges the
    // row (or renames it up when the canonical form doesn't exist yet). Truly-custom stages
    // (names that aren't a funnel stage in any case) are left untouched.
    for (const name of FUNNEL) {
      await prisma.$executeRawUnsafe(`UPDATE "Lead" SET stage = '${name}' WHERE UPPER(TRIM(stage)) = '${name}' AND stage <> '${name}';`);
      await prisma.$executeRawUnsafe(`
        DO $$
        BEGIN
          IF EXISTS (SELECT 1 FROM lead_stages WHERE name = '${name}') THEN
            DELETE FROM lead_stages WHERE UPPER(TRIM(name)) = '${name}' AND name <> '${name}';
          ELSE
            UPDATE lead_stages SET name = '${name}' WHERE UPPER(TRIM(name)) = '${name}' AND name <> '${name}';
          END IF;
        END $$;
      `);
    }

    // Ensure any missing funnel stage exists (adds WON/HOLD/LOST on an upgraded board;
    // ON CONFLICT DO NOTHING keeps existing rows/orders untouched).
    for (let i = 0; i < FUNNEL.length; i++) {
      await prisma.$executeRawUnsafe(
        `INSERT INTO lead_stages (name, order_index, is_default) VALUES ('${FUNNEL[i]}', ${i + 1}, TRUE) ON CONFLICT (name) DO NOTHING;`,
      );
    }
    // Normalise to the canonical order ONLY when the board is exactly the 8 funnel stages
    // — never reshuffle a board the admin customised with extra stages.
    await prisma.$executeRawUnsafe(`
      DO $$
      BEGIN
        IF (SELECT COUNT(*) FROM lead_stages) = 8
           AND NOT EXISTS (SELECT 1 FROM lead_stages WHERE name NOT IN ('NQL','MQL','SQL','PQL','SAL','WON','HOLD','LOST')) THEN
          UPDATE lead_stages SET order_index = 1, is_default = TRUE WHERE name = 'NQL';
          UPDATE lead_stages SET order_index = 2, is_default = TRUE WHERE name = 'MQL';
          UPDATE lead_stages SET order_index = 3, is_default = TRUE WHERE name = 'SQL';
          UPDATE lead_stages SET order_index = 4, is_default = TRUE WHERE name = 'PQL';
          UPDATE lead_stages SET order_index = 5, is_default = TRUE WHERE name = 'SAL';
          UPDATE lead_stages SET order_index = 6, is_default = TRUE WHERE name = 'WON';
          UPDATE lead_stages SET order_index = 7, is_default = TRUE WHERE name = 'HOLD';
          UPDATE lead_stages SET order_index = 8, is_default = TRUE WHERE name = 'LOST';
        END IF;
      END $$;
    `);
    console.log('✅ "lead_stages" table is verified and seeded (8-stage funnel).');

    // Reconcile Lead.status with Lead.stage (single source of truth). Pipeline
    // stage drives status (a lower-cased mirror of the stage name); older leads
    // whose stage was changed via the Edit modal before status-sync existed can
    // have a stale status, which made the Kanban board (stage) and the table /
    // details (status) disagree. Realign every such lead — EXCEPT action-terminal
    // ones (converted/disqualified), whose status is intentionally decoupled from
    // the stage. Idempotent: once aligned, the WHERE clause matches nothing.
    await prisma.$executeRawUnsafe(`
      UPDATE "Lead"
      SET status = LOWER(stage)
      WHERE LOWER(status) <> LOWER(stage)
        AND LOWER(status) NOT IN ('converted', 'disqualified');
    `);
    console.log('✅ Lead status reconciled with pipeline stage.');

    // Lead notes — historical free-text communication log per lead.
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS lead_notes (
        id SERIAL PRIMARY KEY,
        lead_id INTEGER NOT NULL REFERENCES "Lead"(id) ON DELETE CASCADE,
        author_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        content TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);
    console.log('✅ "lead_notes" table is verified.');

    // Deal notes — editable per-deal notes (mirrors lead_notes; separate from the
    // append-only activity_logs audit trail). Supports add/edit/delete on the
    // Deal Details page.
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS deal_notes (
        id SERIAL PRIMARY KEY,
        deal_id INTEGER NOT NULL REFERENCES "Deal"(id) ON DELETE CASCADE,
        author_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        content TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);
    await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS deal_notes_deal_id_idx ON deal_notes(deal_id);`);
    console.log('✅ "deal_notes" table is verified.');

    // ── Lead Qualification & Follow-up Module ─────────────────────────────────
    // Follow-up / reminder records (reuses the FollowUp model). Self-heal the
    // table for fresh DBs and add the reminder columns for existing ones.
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "FollowUp" (
        id SERIAL PRIMARY KEY,
        title VARCHAR(255) NOT NULL,
        notes TEXT,
        "scheduledDate" TIMESTAMP NOT NULL,
        status VARCHAR(50) DEFAULT 'pending',
        "leadId" INTEGER REFERENCES "Lead"(id) ON DELETE CASCADE,
        "dealId" INTEGER,
        "ownerId" INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        "createdAt" TIMESTAMP DEFAULT NOW(),
        "updatedAt" TIMESTAMP DEFAULT NOW()
      );
    `);
    await prisma.$executeRawUnsafe(`ALTER TABLE "FollowUp" ADD COLUMN IF NOT EXISTS "type" VARCHAR(50) DEFAULT 'follow_up';`);
    await prisma.$executeRawUnsafe(`ALTER TABLE "FollowUp" ADD COLUMN IF NOT EXISTS "reminderNotified" BOOLEAN DEFAULT FALSE;`);
    await prisma.$executeRawUnsafe(`ALTER TABLE "FollowUp" ADD COLUMN IF NOT EXISTS "completedAt" TIMESTAMP;`);
    console.log('✅ "FollowUp" table is verified (with reminder columns).');

    // Lead interactions — Call / Email / Meeting log per lead.
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS lead_interactions (
        id SERIAL PRIMARY KEY,
        lead_id INTEGER NOT NULL REFERENCES "Lead"(id) ON DELETE CASCADE,
        author_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        type VARCHAR(20) NOT NULL,
        notes TEXT NOT NULL,
        interaction_date TIMESTAMP NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    console.log('✅ "lead_interactions" table is verified.');

    // Lead scoring criteria — admin-configured factors + weights.
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS lead_scoring_criteria (
        id SERIAL PRIMARY KEY,
        factor VARCHAR(100) UNIQUE NOT NULL,
        label VARCHAR(150) NOT NULL,
        weight INTEGER NOT NULL DEFAULT 0,
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);
    // Seed the default scoring factors. The five active factors sum to 100
    // (matching the business example); the rest ship inactive for admins to enable.
    await prisma.$executeRawUnsafe(`
      INSERT INTO lead_scoring_criteria (factor, label, weight, is_active, updated_at)
      VALUES
        ('interest_level',    'Interest Level',    30, TRUE, NOW()),
        ('company_size',      'Company Size',      25, TRUE, NOW()),
        ('responsiveness',    'Responsiveness',    20, TRUE, NOW()),
        ('source_quality',    'Source Quality',    15, TRUE, NOW()),
        ('interactions',      'Interaction Count', 10, TRUE, NOW()),
        ('industry',          'Industry',          10, FALSE, NOW()),
        ('budget',            'Budget',            15, FALSE, NOW()),
        ('meeting_scheduled', 'Meeting Scheduled', 10, FALSE, NOW())
      ON CONFLICT (factor) DO NOTHING;
    `);
    console.log('✅ "lead_scoring_criteria" table is verified and seeded.');

    // Disqualification reason on leads.
    await prisma.$executeRawUnsafe(`ALTER TABLE "Lead" ADD COLUMN IF NOT EXISTS disqualify_reason TEXT;`);
    // Referral name — stores the referrer's name when lead source is 'referral'.
    await prisma.$executeRawUnsafe(`ALTER TABLE "Lead" ADD COLUMN IF NOT EXISTS referral_name VARCHAR(255);`);
    // Lead value — dedicated numeric column for the monetary value of a lead.
    await prisma.$executeRawUnsafe(`ALTER TABLE "Lead" ADD COLUMN IF NOT EXISTS lead_value DOUBLE PRECISION;`);
    // Backfill: extract "Lead Value: <number>" from description into the new column,
    // then strip that line from description so notes display cleanly.
    await prisma.$executeRawUnsafe(`
      UPDATE "Lead"
      SET lead_value = CAST(
        (regexp_match(description, 'Lead Value:\s*([0-9]+\.?[0-9]*)', 'i'))[1]
        AS DOUBLE PRECISION
      )
      WHERE lead_value IS NULL
        AND description ~ 'Lead Value:\s*[0-9]';
    `);
    await prisma.$executeRawUnsafe(`
      UPDATE "Lead"
      SET description = NULLIF(
        btrim(regexp_replace(description, '(?m)^Lead Value:\s*[0-9]+\.?[0-9]*\s*$', '', 'gi')),
        ''
      )
      WHERE description ~ 'Lead Value:\s*[0-9]';
    `);

    // ── Deal Pipeline ─────────────────────────────────────────────────────────
    // Self-heal the Deal table on a fresh DB, then add the pipeline columns.
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "Deal" (
        id SERIAL PRIMARY KEY,
        title VARCHAR(255) NOT NULL,
        amount DOUBLE PRECISION NOT NULL DEFAULT 0,
        status VARCHAR(50) NOT NULL DEFAULT 'open',
        "opportunityId" INTEGER,
        "customerId" INTEGER NOT NULL REFERENCES "Customer"(id) ON DELETE CASCADE,
        "ownerId" INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        "createdAt" TIMESTAMP DEFAULT NOW(),
        "updatedAt" TIMESTAMP DEFAULT NOW()
      );
    `);
    await prisma.$executeRawUnsafe(`ALTER TABLE "Deal" ADD COLUMN IF NOT EXISTS stage VARCHAR(100) NOT NULL DEFAULT 'Proposal Sent';`);
    await prisma.$executeRawUnsafe(`ALTER TABLE "Deal" ADD COLUMN IF NOT EXISTS order_index INTEGER NOT NULL DEFAULT 0;`);
    await prisma.$executeRawUnsafe(`ALTER TABLE "Deal" ADD COLUMN IF NOT EXISTS source VARCHAR(100);`);
    await prisma.$executeRawUnsafe(`ALTER TABLE "Deal" ADD COLUMN IF NOT EXISTS notes TEXT;`);
    await prisma.$executeRawUnsafe(`ALTER TABLE "Deal" ADD COLUMN IF NOT EXISTS description TEXT;`);
    await prisma.$executeRawUnsafe(`ALTER TABLE "Deal" ADD COLUMN IF NOT EXISTS "leadId" INTEGER;`);
    // One lead → at most one deal (NULLs are distinct in Postgres, so a plain unique works).
    await prisma.$executeRawUnsafe(`CREATE UNIQUE INDEX IF NOT EXISTS "Deal_leadId_key" ON "Deal"("leadId");`);
    // Deal & Pipeline Management columns (currency, forecasting, win/loss, linkage).
    await prisma.$executeRawUnsafe(`ALTER TABLE "Deal" ADD COLUMN IF NOT EXISTS currency VARCHAR(10) NOT NULL DEFAULT 'INR';`);
    await prisma.$executeRawUnsafe(`ALTER TABLE "Deal" ADD COLUMN IF NOT EXISTS probability INTEGER NOT NULL DEFAULT 20;`);
    await prisma.$executeRawUnsafe(`ALTER TABLE "Deal" ADD COLUMN IF NOT EXISTS expected_close_date TIMESTAMP;`);
    await prisma.$executeRawUnsafe(`ALTER TABLE "Deal" ADD COLUMN IF NOT EXISTS closed_at TIMESTAMP;`);
    await prisma.$executeRawUnsafe(`ALTER TABLE "Deal" ADD COLUMN IF NOT EXISTS products TEXT;`);
    await prisma.$executeRawUnsafe(`ALTER TABLE "Deal" ADD COLUMN IF NOT EXISTS services TEXT;`);
    await prisma.$executeRawUnsafe(`ALTER TABLE "Deal" ADD COLUMN IF NOT EXISTS competitors TEXT;`);
    await prisma.$executeRawUnsafe(`ALTER TABLE "Deal" ADD COLUMN IF NOT EXISTS attachments TEXT;`);
    await prisma.$executeRawUnsafe(`ALTER TABLE "Deal" ADD COLUMN IF NOT EXISTS win_reason TEXT;`);
    await prisma.$executeRawUnsafe(`ALTER TABLE "Deal" ADD COLUMN IF NOT EXISTS loss_reason TEXT;`);
    await prisma.$executeRawUnsafe(`ALTER TABLE "Deal" ADD COLUMN IF NOT EXISTS won_event_at TIMESTAMP;`);
    await prisma.$executeRawUnsafe(`ALTER TABLE "Deal" ADD COLUMN IF NOT EXISTS close_reminder_notified BOOLEAN NOT NULL DEFAULT FALSE;`);
    await prisma.$executeRawUnsafe(`ALTER TABLE "Deal" ADD COLUMN IF NOT EXISTS project_id VARCHAR(255);`);
    // Deal activity audit trail reuses activity_logs — add the deal foreign key.
    await prisma.$executeRawUnsafe(`ALTER TABLE activity_logs ADD COLUMN IF NOT EXISTS deal_id INTEGER;`);
    // Structured payload for activity entries (additive). Holds the Stage Transition
    // Dialog data on `stage_changed` ({fromStage,toStage,checklist,note}); future-ready
    // for approvals/attachments/signatures. Reuses the existing timeline — no new table.
    await prisma.$executeRawUnsafe(`ALTER TABLE activity_logs ADD COLUMN IF NOT EXISTS metadata JSONB;`);
    console.log('✅ "Deal" pipeline + management columns verified.');

    // Deal stages — the controlled, ordered set used by the deal board & analytics.
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS deal_stages (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) UNIQUE NOT NULL,
        order_index INTEGER NOT NULL,
        is_default BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    await prisma.$executeRawUnsafe(`
      INSERT INTO deal_stages (name, order_index, is_default)
      VALUES
        ('Proposal Sent',   1, TRUE),
        ('Demo Done',       2, FALSE),
        ('Contract Review', 3, FALSE),
        ('Negotiation',     4, FALSE),
        ('Closed Won',      5, FALSE),
        ('Closed Lost',     6, FALSE)
      ON CONFLICT (name) DO NOTHING;
    `);
    console.log('✅ "deal_stages" table is verified and seeded.');

    // ── Sales Execution Layer ─────────────────────────────────────────────────
    // SE-021.1 — per-stage stalled threshold (days) + deal stage-change tracking.
    await prisma.$executeRawUnsafe(`ALTER TABLE deal_stages ADD COLUMN IF NOT EXISTS stalled_threshold_days INTEGER NOT NULL DEFAULT 14;`);
    // Seed sensible defaults per the business examples (idempotent — only first run).
    await prisma.$executeRawUnsafe(`UPDATE deal_stages SET stalled_threshold_days = 7  WHERE name = 'Proposal Sent'   AND stalled_threshold_days = 14;`);
    await prisma.$executeRawUnsafe(`UPDATE deal_stages SET stalled_threshold_days = 14 WHERE name = 'Negotiation'     AND stalled_threshold_days = 14;`);
    await prisma.$executeRawUnsafe(`UPDATE deal_stages SET stalled_threshold_days = 10 WHERE name = 'Contract Review' AND stalled_threshold_days = 14;`);

    await prisma.$executeRawUnsafe(`ALTER TABLE "Deal" ADD COLUMN IF NOT EXISTS last_stage_change_at TIMESTAMP;`);
    await prisma.$executeRawUnsafe(`ALTER TABLE "Deal" ADD COLUMN IF NOT EXISTS stalled BOOLEAN NOT NULL DEFAULT FALSE;`);
    await prisma.$executeRawUnsafe(`ALTER TABLE "Deal" ADD COLUMN IF NOT EXISTS stalled_notified_at TIMESTAMP;`);
    // Backfill the stage clock for pre-existing deals so detection has a baseline.
    await prisma.$executeRawUnsafe(`UPDATE "Deal" SET last_stage_change_at = COALESCE("updatedAt", "createdAt", NOW()) WHERE last_stage_change_at IS NULL;`);
    console.log('✅ Deal stalled-detection columns verified.');

    // ══════════════════════════════════════════════════════════════════════════
    // PHASE 3 · STAGE 3A — Pipeline revenue model + A-i historical deal migration.
    // ADDITIVE & NON-BREAKING: the Deal entity + every deal-based report/target/incentive
    // are UNTOUCHED here (they keep reading "Deal"); we only give Pipeline (Lead) its own
    // revenue columns and copy historical Deal revenue onto the matching opportunity, so
    // Pipeline CAN later become the single source of truth. Reads are repointed and the
    // Deals module removed in a LATER stage, only AFTER the parity check below is verified
    // against production data. Every statement is idempotent (safe to re-run on each boot).
    // ══════════════════════════════════════════════════════════════════════════
    for (const col of [
      `opp_status VARCHAR(50) DEFAULT 'open'`,
      `currency VARCHAR(10) DEFAULT 'INR'`,
      `probability INTEGER DEFAULT 20`,
      `expected_close_date TIMESTAMP`,
      `closed_at TIMESTAMP`,
      `win_reason TEXT`,
      `loss_reason TEXT`,
      `opp_loss_from_stage VARCHAR(100)`,
      `won_event_at TIMESTAMP`,
      `close_reminder_notified BOOLEAN DEFAULT FALSE`,
      `last_stage_change_at TIMESTAMP`,
      `stalled BOOLEAN DEFAULT FALSE`,
      `stalled_notified_at TIMESTAMP`,
      `opp_project_id VARCHAR(255)`,
      `products TEXT`,
      `services TEXT`,
      `competitors TEXT`,
      `migrated_from_deal_id INTEGER`,
    ]) {
      await prisma.$executeRawUnsafe(`ALTER TABLE "Lead" ADD COLUMN IF NOT EXISTS ${col};`);
    }
    // One opportunity per source deal (multiple NULLs allowed in a Postgres unique index).
    await prisma.$executeRawUnsafe(`CREATE UNIQUE INDEX IF NOT EXISTS "Lead_migrated_from_deal_id_key" ON "Lead" (migrated_from_deal_id);`);

    // Migrated deals map onto the standardized 8-stage funnel (already seeded above): the
    // deal stage folds to WON / LOST / SAL — no separate deal-stage columns are added.
    const dealStageToFunnel = `CASE WHEN d.stage = 'Closed Won' OR d.status = 'won' THEN 'WON' WHEN d.stage = 'Closed Lost' OR d.status = 'lost' THEN 'LOST' ELSE 'SAL' END`;

    // A-i (1/2): deals WITH a linked lead → copy revenue onto that opportunity (once). The
    // deal AMOUNT is the authoritative revenue, so lead_value is overwritten with it.
    await prisma.$executeRawUnsafe(`
      UPDATE "Lead" l SET
        lead_value = d.amount,
        opp_status = CASE WHEN d.stage = 'Closed Won'  OR d.status = 'won'  THEN 'won'
                          WHEN d.stage = 'Closed Lost' OR d.status = 'lost' THEN 'lost'
                          ELSE 'open' END,
        currency = COALESCE(d.currency, 'INR'),
        probability = COALESCE(d.probability, l.probability),
        expected_close_date = d.expected_close_date,
        closed_at = d.closed_at,
        win_reason = d.win_reason,
        loss_reason = d.loss_reason,
        opp_loss_from_stage = d.loss_from_stage,
        won_event_at = d.won_event_at,
        close_reminder_notified = COALESCE(d.close_reminder_notified, FALSE),
        last_stage_change_at = d.last_stage_change_at,
        stalled = COALESCE(d.stalled, FALSE),
        stalled_notified_at = d.stalled_notified_at,
        opp_project_id = d.project_id,
        products = d.products, services = d.services, competitors = d.competitors,
        stage = ${dealStageToFunnel},
        -- Revenue is attributed BY OWNER (targets/incentives/leaderboards). The opportunity now
        -- IS the deal, so it must carry the DEAL's owner — else a deal reassigned independently
        -- of its lead would credit the wrong person and break target/incentive parity.
        "ownerId" = d."ownerId",
        migrated_from_deal_id = d.id
      FROM "Deal" d
      WHERE d."leadId" = l.id AND l.migrated_from_deal_id IS NULL;
    `);

    // A-i (2/2): deals WITHOUT a lead (created directly) → create a Pipeline opportunity.
    await prisma.$executeRawUnsafe(`
      INSERT INTO "Lead" (
        title, description, source, status, stage, priority, temperature,
        "customerId", "companyId", "ownerId", lead_value, opp_status, currency, probability,
        expected_close_date, closed_at, win_reason, loss_reason, opp_loss_from_stage,
        won_event_at, close_reminder_notified, last_stage_change_at, stalled, stalled_notified_at,
        opp_project_id, products, services, competitors, migrated_from_deal_id, "createdAt", "updatedAt"
      )
      SELECT
        d.title, d.description, COALESCE(d.source, 'manual'), 'converted', ${dealStageToFunnel}, 'medium', 'WARM',
        d."customerId", c."companyId", d."ownerId", d.amount,
        CASE WHEN d.stage = 'Closed Won'  OR d.status = 'won'  THEN 'won'
             WHEN d.stage = 'Closed Lost' OR d.status = 'lost' THEN 'lost'
             ELSE 'open' END,
        COALESCE(d.currency, 'INR'), COALESCE(d.probability, 20),
        d.expected_close_date, d.closed_at, d.win_reason, d.loss_reason, d.loss_from_stage,
        d.won_event_at, COALESCE(d.close_reminder_notified, FALSE), d.last_stage_change_at,
        COALESCE(d.stalled, FALSE), d.stalled_notified_at,
        d.project_id, d.products, d.services, d.competitors, d.id, d."createdAt", d."updatedAt"
      FROM "Deal" d
      LEFT JOIN "Customer" c ON c.id = d."customerId"
      WHERE d."leadId" IS NULL
        AND NOT EXISTS (SELECT 1 FROM "Lead" l2 WHERE l2.migrated_from_deal_id = d.id);
    `);

    // PARITY SELF-CHECK — logs Deal (source) vs migrated Pipeline totals every boot so the
    // migration is verifiable against real data BEFORE reads are repointed / Deals removed.
    try {
      const parity: any[] = await prisma.$queryRawUnsafe(`
        SELECT
          (SELECT COALESCE(SUM(amount), 0) FROM "Deal" WHERE status = 'won' OR stage = 'Closed Won')::float AS deal_won_revenue,
          (SELECT COALESCE(SUM(lead_value), 0) FROM "Lead" WHERE migrated_from_deal_id IS NOT NULL AND opp_status = 'won')::float AS pipe_won_revenue,
          (SELECT COUNT(*) FROM "Deal")::int AS deal_count,
          (SELECT COUNT(*) FROM "Lead" WHERE migrated_from_deal_id IS NOT NULL)::int AS migrated_count
      `);
      const p = parity?.[0] || {};
      const ok = Number(p.deal_won_revenue) === Number(p.pipe_won_revenue) && Number(p.deal_count) === Number(p.migrated_count);
      console.log(`🔎 Phase 3 A-i PARITY: deals=${p.deal_count} migrated=${p.migrated_count} | won-revenue deal=${p.deal_won_revenue} pipeline=${p.pipe_won_revenue} → ${ok ? 'MATCH ✅' : 'MISMATCH ⚠ — review before repointing reads'}`);
    } catch (e) {
      console.error('Phase 3 A-i parity check failed:', e);
    }
    console.log('✅ Phase 3 (3A) — Pipeline revenue model + A-i historical deal migration verified.');

    // ── Project archive ⇒ status integrity ────────────────────────────────────
    // Archiving a project must force status = 'archived'. We preserve the prior
    // status in status_before_archive so restore can put it back.
    await prisma.$executeRawUnsafe(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS status_before_archive VARCHAR(50);`);
    // Backfill any legacy rows that are archived but still carry a live status:
    // (1) remember the live status once, then (2) flip status to 'archived'.
    await prisma.$executeRawUnsafe(`UPDATE projects SET status_before_archive = status WHERE is_archived = TRUE AND LOWER(status) <> 'archived' AND status_before_archive IS NULL;`);
    await prisma.$executeRawUnsafe(`UPDATE projects SET status = 'archived' WHERE is_archived = TRUE AND LOWER(status) <> 'archived';`);
    console.log('✅ Project archive/status integrity verified.');

    // SE-020.1 — saved pipeline filter views (personal / team / global scope).
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS saved_views (
        id SERIAL PRIMARY KEY,
        name VARCHAR(150) NOT NULL,
        entity VARCHAR(20) NOT NULL DEFAULT 'deal',
        scope VARCHAR(20) NOT NULL DEFAULT 'personal',
        filters JSONB NOT NULL DEFAULT '{}',
        owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);
    console.log('✅ "saved_views" table is verified.');

    // SE-023 / SE-024 — sales tasks linked to exactly one Lead OR one Deal.
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS sales_tasks (
        id SERIAL PRIMARY KEY,
        title VARCHAR(255) NOT NULL,
        type VARCHAR(40) NOT NULL DEFAULT 'follow_up',
        status VARCHAR(30) NOT NULL DEFAULT 'open',
        priority VARCHAR(20) NOT NULL DEFAULT 'medium',
        due_date TIMESTAMP,
        notes TEXT,
        blocked BOOLEAN NOT NULL DEFAULT FALSE,
        blocker_reason TEXT,
        completed_at TIMESTAMP,
        lead_id INTEGER REFERENCES "Lead"(id) ON DELETE CASCADE,
        deal_id INTEGER REFERENCES "Deal"(id) ON DELETE CASCADE,
        assignee_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_by_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW(),
        CONSTRAINT sales_task_one_parent CHECK (
          ((lead_id IS NOT NULL)::int + (deal_id IS NOT NULL)::int) = 1
        )
      );
    `);
    console.log('✅ "sales_tasks" table is verified.');

    // SE-022 — document approval workflow + immutable audit history.
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS document_approvals (
        id SERIAL PRIMARY KEY,
        doc_type VARCHAR(50) NOT NULL,
        title VARCHAR(255) NOT NULL,
        version VARCHAR(50) NOT NULL DEFAULT 'v1',
        change_notes TEXT NOT NULL,
        comments TEXT,
        file_name VARCHAR(255) NOT NULL,
        file_url TEXT NOT NULL,
        file_size INTEGER NOT NULL DEFAULT 0,
        status VARCHAR(20) NOT NULL DEFAULT 'pending',
        manager_comments TEXT,
        decision_at TIMESTAMP,
        sent_to_client BOOLEAN NOT NULL DEFAULT FALSE,
        sent_at TIMESTAMP,
        lead_id INTEGER REFERENCES "Lead"(id) ON DELETE CASCADE,
        deal_id INTEGER REFERENCES "Deal"(id) ON DELETE CASCADE,
        submitted_by_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        reviewed_by_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS document_approval_history (
        id SERIAL PRIMARY KEY,
        approval_id INTEGER NOT NULL REFERENCES document_approvals(id) ON DELETE CASCADE,
        action VARCHAR(30) NOT NULL,
        actor_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        comments TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    console.log('✅ "document_approvals" + history tables are verified.');

    // SE-025.1 — monthly revenue target per sales owner (BDE dashboard).
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS sales_targets (
        id SERIAL PRIMARY KEY,
        owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        period VARCHAR(7) NOT NULL,
        target_amount DOUBLE PRECISION NOT NULL DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW(),
        CONSTRAINT sales_target_owner_period UNIQUE (owner_id, period)
      );
    `);
    console.log('✅ "sales_targets" table is verified.');

    // ── Sales Performance, Targets, Incentives & Teams ───────────────────────
    // SE-026.1 completion outcome + notes; SE-027 recurrence link; SE-029.1 overdue guard.
    await prisma.$executeRawUnsafe(`ALTER TABLE sales_tasks ADD COLUMN IF NOT EXISTS outcome VARCHAR(40);`);
    await prisma.$executeRawUnsafe(`ALTER TABLE sales_tasks ADD COLUMN IF NOT EXISTS completion_notes TEXT;`);
    await prisma.$executeRawUnsafe(`ALTER TABLE sales_tasks ADD COLUMN IF NOT EXISTS recurrence_rule_id INTEGER;`);
    await prisma.$executeRawUnsafe(`ALTER TABLE sales_tasks ADD COLUMN IF NOT EXISTS overdue_notified_at TIMESTAMP;`);
    await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS sales_tasks_status_due_idx ON sales_tasks (status, due_date);`);
    console.log('✅ sales_tasks completion/recurrence/overdue columns verified.');

    // SE-040.1 — target types + period types + team attribution. Widen the unique
    // key from (owner,period) to (owner,period,period_type,type). Existing rows
    // default to revenue/monthly so the BDE dashboard keeps resolving them.
    await prisma.$executeRawUnsafe(`ALTER TABLE sales_targets ADD COLUMN IF NOT EXISTS type VARCHAR(20) NOT NULL DEFAULT 'revenue';`);
    await prisma.$executeRawUnsafe(`ALTER TABLE sales_targets ADD COLUMN IF NOT EXISTS period_type VARCHAR(12) NOT NULL DEFAULT 'monthly';`);
    await prisma.$executeRawUnsafe(`ALTER TABLE sales_targets ADD COLUMN IF NOT EXISTS team_id INTEGER;`);
    await prisma.$executeRawUnsafe(`ALTER TABLE sales_targets DROP CONSTRAINT IF EXISTS sales_target_owner_period;`);
    await prisma.$executeRawUnsafe(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sales_target_owner_period_type') THEN
          ALTER TABLE sales_targets ADD CONSTRAINT sales_target_owner_period_type UNIQUE (owner_id, period, period_type, type);
        END IF;
      END $$;
    `);
    console.log('✅ sales_targets type/period_type/team columns verified.');

    // Target Management module — optional human label + description on a target.
    await prisma.$executeRawUnsafe(`ALTER TABLE sales_targets ADD COLUMN IF NOT EXISTS name VARCHAR(150);`);
    await prisma.$executeRawUnsafe(`ALTER TABLE sales_targets ADD COLUMN IF NOT EXISTS description TEXT;`);
    console.log('✅ sales_targets name/description columns verified.');

    // SE-027.1/2 — recurring task rules (one Lead OR one Deal template parent).
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS recurrence_rules (
        id SERIAL PRIMARY KEY,
        title VARCHAR(255) NOT NULL,
        type VARCHAR(40) NOT NULL DEFAULT 'follow_up',
        priority VARCHAR(20) NOT NULL DEFAULT 'medium',
        notes TEXT,
        frequency VARCHAR(12) NOT NULL,
        interval INTEGER NOT NULL DEFAULT 1,
        start_date TIMESTAMP NOT NULL,
        end_date TIMESTAMP,
        active BOOLEAN NOT NULL DEFAULT TRUE,
        assignee_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        lead_id INTEGER REFERENCES "Lead"(id) ON DELETE CASCADE,
        deal_id INTEGER REFERENCES "Deal"(id) ON DELETE CASCADE,
        last_generated_at TIMESTAMP,
        next_run_at TIMESTAMP,
        created_by_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW(),
        CONSTRAINT recurrence_rule_one_parent CHECK (
          ((lead_id IS NOT NULL)::int + (deal_id IS NOT NULL)::int) = 1
        )
      );
    `);
    await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS recurrence_rules_active_next_idx ON recurrence_rules (active, next_run_at);`);
    console.log('✅ "recurrence_rules" table is verified.');

    // SE-042.1 — per-BDE incentive slabs.
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS incentive_slabs (
        id SERIAL PRIMARY KEY,
        owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        min_achievement_pct DOUBLE PRECISION NOT NULL DEFAULT 0,
        max_achievement_pct DOUBLE PRECISION,
        incentive_pct DOUBLE PRECISION,
        incentive_amount DOUBLE PRECISION,
        active BOOLEAN NOT NULL DEFAULT TRUE,
        created_by_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);
    console.log('✅ "incentive_slabs" table is verified.');

    // SE-044.1 — sales teams + membership (a user belongs to at most one team).
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS sales_teams (
        id SERIAL PRIMARY KEY,
        name VARCHAR(150) NOT NULL,
        description TEXT,
        manager_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        archived BOOLEAN NOT NULL DEFAULT FALSE,
        created_by_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS sales_team_members (
        id SERIAL PRIMARY KEY,
        team_id INTEGER NOT NULL REFERENCES sales_teams(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
        role VARCHAR(12) NOT NULL DEFAULT 'bde',
        joined_at TIMESTAMP DEFAULT NOW()
      );
    `);
    console.log('✅ "sales_teams" + members tables are verified.');

    // ── Sales Reporting & Analytics ──────────────────────────────────────────
    // SE-036 — stage the deal was in when marked Closed Lost (lost-deal analysis).
    await prisma.$executeRawUnsafe(`ALTER TABLE "Deal" ADD COLUMN IF NOT EXISTS loss_from_stage VARCHAR(100);`);

    // SE-030.1 — persisted daily activity snapshot (one row per owner per day).
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS daily_reports (
        id SERIAL PRIMARY KEY,
        owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        report_date DATE NOT NULL,
        calls INTEGER NOT NULL DEFAULT 0,
        meetings INTEGER NOT NULL DEFAULT 0,
        leads_created INTEGER NOT NULL DEFAULT 0,
        leads_contacted INTEGER NOT NULL DEFAULT 0,
        follow_ups_completed INTEGER NOT NULL DEFAULT 0,
        deals_created INTEGER NOT NULL DEFAULT 0,
        deals_won INTEGER NOT NULL DEFAULT 0,
        deals_lost INTEGER NOT NULL DEFAULT 0,
        revenue_won DOUBLE PRECISION NOT NULL DEFAULT 0,
        generated_at TIMESTAMP DEFAULT NOW(),
        CONSTRAINT daily_report_owner_date UNIQUE (owner_id, report_date)
      );
    `);
    await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS daily_reports_date_idx ON daily_reports (report_date);`);
    console.log('✅ "daily_reports" table is verified.');

    // SE-030.2 — report scheduler config.
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS report_schedules (
        id SERIAL PRIMARY KEY,
        name VARCHAR(150) NOT NULL,
        report_type VARCHAR(50) NOT NULL DEFAULT 'daily_activity',
        frequency VARCHAR(12) NOT NULL,
        recipients JSONB NOT NULL DEFAULT '[]',
        active BOOLEAN NOT NULL DEFAULT TRUE,
        last_run_at TIMESTAMP,
        last_status VARCHAR(20),
        next_run_at TIMESTAMP,
        created_by_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);
    console.log('✅ "report_schedules" table is verified.');

    // ── Ticket Tracking (Development + Sales) ────────────────────────────────
    // One `tickets` table serves both modules via the `module` discriminator
    // ('development' | 'sales'). Snake-case columns match lib/api/tickets.ts.
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS tickets (
        id SERIAL PRIMARY KEY,
        title VARCHAR(255) NOT NULL,
        description TEXT,
        status VARCHAR(50) NOT NULL DEFAULT 'open',
        priority VARCHAR(50) NOT NULL DEFAULT 'medium',
        module VARCHAR(20) NOT NULL DEFAULT 'development',
        category VARCHAR(100),
        source VARCHAR(100),
        project_id VARCHAR(255) REFERENCES projects(id) ON DELETE SET NULL,
        lead_id INTEGER REFERENCES "Lead"(id) ON DELETE SET NULL,
        deal_id INTEGER REFERENCES "Deal"(id) ON DELETE SET NULL,
        customer_id INTEGER REFERENCES "Customer"(id) ON DELETE SET NULL,
        team_id INTEGER REFERENCES sales_teams(id) ON DELETE SET NULL,
        assigned_to INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        due_date TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);
    // Safe-upgrade: a pre-existing `tickets` table (if one was ever created) gets
    // the sales columns it may be missing.
    await prisma.$executeRawUnsafe(`ALTER TABLE tickets ADD COLUMN IF NOT EXISTS module VARCHAR(20) NOT NULL DEFAULT 'development';`);
    await prisma.$executeRawUnsafe(`ALTER TABLE tickets ADD COLUMN IF NOT EXISTS category VARCHAR(100);`);
    await prisma.$executeRawUnsafe(`ALTER TABLE tickets ADD COLUMN IF NOT EXISTS source VARCHAR(100);`);
    await prisma.$executeRawUnsafe(`ALTER TABLE tickets ADD COLUMN IF NOT EXISTS lead_id INTEGER;`);
    await prisma.$executeRawUnsafe(`ALTER TABLE tickets ADD COLUMN IF NOT EXISTS deal_id INTEGER;`);
    await prisma.$executeRawUnsafe(`ALTER TABLE tickets ADD COLUMN IF NOT EXISTS customer_id INTEGER;`);
    await prisma.$executeRawUnsafe(`ALTER TABLE tickets ADD COLUMN IF NOT EXISTS team_id INTEGER;`);
    await prisma.$executeRawUnsafe(`ALTER TABLE tickets ADD COLUMN IF NOT EXISTS due_date TIMESTAMP;`);
    await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS tickets_module_idx ON tickets (module);`);
    await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS tickets_assigned_to_idx ON tickets (assigned_to);`);
    await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS tickets_created_by_idx ON tickets (created_by);`);

    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS ticket_attachments (
        id SERIAL PRIMARY KEY,
        ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
        file_name VARCHAR(255) NOT NULL,
        file_url TEXT NOT NULL,
        file_size INTEGER NOT NULL,
        description VARCHAR(500),
        uploaded_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        uploaded_at TIMESTAMP DEFAULT NOW()
      );
    `);
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS ticket_discussions (
        id SERIAL PRIMARY KEY,
        ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
        sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        message TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS ticket_discussion_reads (
        id SERIAL PRIMARY KEY,
        ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        last_read_at TIMESTAMP DEFAULT NOW(),
        CONSTRAINT unique_ticket_discussion_read UNIQUE (ticket_id, user_id)
      );
    `);
    // activity_logs gains a ticket_id foreign key (mirrors blocker_id/deal_id).
    await prisma.$executeRawUnsafe(`ALTER TABLE activity_logs ADD COLUMN IF NOT EXISTS ticket_id INTEGER;`);
    await prisma.$executeRawUnsafe(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'activity_logs_ticket_id_fkey') THEN
          ALTER TABLE activity_logs ADD CONSTRAINT activity_logs_ticket_id_fkey
            FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE SET NULL;
        END IF;
      END $$;
    `);
    console.log('✅ "tickets" + attachments/discussions tables are verified.');

    // ── Meetings: extend for Sales (module + lead/deal/customer/team) ─────────
    // Additive + nullable; existing development meetings default to 'development'
    // and keep their (now-optional) project. Table name is "Meeting" (no @@map).
    await prisma.$executeRawUnsafe(`ALTER TABLE "Meeting" ADD COLUMN IF NOT EXISTS module VARCHAR(20) NOT NULL DEFAULT 'development';`);
    await prisma.$executeRawUnsafe(`ALTER TABLE "Meeting" ADD COLUMN IF NOT EXISTS lead_id INTEGER;`);
    await prisma.$executeRawUnsafe(`ALTER TABLE "Meeting" ADD COLUMN IF NOT EXISTS deal_id INTEGER;`);
    await prisma.$executeRawUnsafe(`ALTER TABLE "Meeting" ADD COLUMN IF NOT EXISTS customer_id INTEGER;`);
    await prisma.$executeRawUnsafe(`ALTER TABLE "Meeting" ADD COLUMN IF NOT EXISTS team_id INTEGER;`);
    // Sales meetings carry no project → projectId must be nullable.
    await prisma.$executeRawUnsafe(`ALTER TABLE "Meeting" ALTER COLUMN "projectId" DROP NOT NULL;`);
    await prisma.$executeRawUnsafe(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Meeting_lead_id_fkey') THEN
          ALTER TABLE "Meeting" ADD CONSTRAINT "Meeting_lead_id_fkey" FOREIGN KEY (lead_id) REFERENCES "Lead"(id) ON DELETE SET NULL;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Meeting_deal_id_fkey') THEN
          ALTER TABLE "Meeting" ADD CONSTRAINT "Meeting_deal_id_fkey" FOREIGN KEY (deal_id) REFERENCES "Deal"(id) ON DELETE SET NULL;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Meeting_customer_id_fkey') THEN
          ALTER TABLE "Meeting" ADD CONSTRAINT "Meeting_customer_id_fkey" FOREIGN KEY (customer_id) REFERENCES "Customer"(id) ON DELETE SET NULL;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Meeting_team_id_fkey') THEN
          ALTER TABLE "Meeting" ADD CONSTRAINT "Meeting_team_id_fkey" FOREIGN KEY (team_id) REFERENCES sales_teams(id) ON DELETE SET NULL;
        END IF;
      END $$;
    `);
    await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS meeting_module_idx ON "Meeting" (module);`);
    console.log('✅ "Meeting" sales columns (module/lead/deal/customer/team) verified.');

    // ── Sales Tickets & Meetings — permission grants (idempotent) ─────────────
    // Independent per-action keys (sales.tickets.* / sales.meetings.*). The
    // coarse Sales bridge already maps sales.create/edit/delete → .create/.edit/
    // .delete, so we only need to seed the explicit View keys + capability keys
    // (.assign / .schedule are exact-match, never bridged). Admin bypasses by name.
    await prisma.$executeRawUnsafe(`
      UPDATE roles SET permissions = (
        SELECT jsonb_agg(DISTINCT p) FROM jsonb_array_elements(
          permissions || '["sales.tickets.view","sales.tickets.create","sales.tickets.edit","sales.tickets.delete","sales.tickets.assign","sales.meetings.view","sales.meetings.create","sales.meetings.edit","sales.meetings.delete","sales.meetings.schedule"]'::jsonb
        ) AS p
      )
      WHERE LOWER(name) IN ('admin','sales manager')
        AND NOT (permissions @> '["sales.tickets.view"]'::jsonb);
    `);
    await prisma.$executeRawUnsafe(`
      UPDATE roles SET permissions = (
        SELECT jsonb_agg(DISTINCT p) FROM jsonb_array_elements(
          permissions || '["sales.tickets.view","sales.tickets.create","sales.tickets.edit","sales.meetings.view","sales.meetings.create","sales.meetings.edit","sales.meetings.schedule"]'::jsonb
        ) AS p
      )
      WHERE name = 'BDE'
        AND NOT (permissions @> '["sales.tickets.view"]'::jsonb);
    `);
    await prisma.$executeRawUnsafe(`
      UPDATE roles SET permissions = (
        SELECT jsonb_agg(DISTINCT p) FROM jsonb_array_elements(
          permissions || '["sales.tickets.view","sales.meetings.view"]'::jsonb
        ) AS p
      )
      WHERE name IN ('Viewer','Director')
        AND NOT (permissions @> '["sales.tickets.view"]'::jsonb);
    `);
    console.log('✅ Sales tickets/meetings permissions seeded to default roles.');

    // Seed the sales role set so Admin / Manager / BDE / Viewer exist with the
    // right permission arrays. Idempotent; admins also bypass checks by name.
    // sales.approve gates the manager approval workflow (SE-022.2); sales.config
    // gates stage-threshold configuration (SE-021.1).
    await prisma.$executeRawUnsafe(
      `INSERT INTO roles (name, description, permissions)
       VALUES
         ('Admin', 'Full system access', $1::jsonb),
         ('Sales Manager', 'Lead assignment and follow-up management', $2::jsonb),
         ('BDE', 'Business Development Executive — manage assigned leads', $3::jsonb),
         ('Viewer', 'Read-only access', $4::jsonb),
         ('Director', 'Organization-level reporting & analytics visibility', $5::jsonb)
       ON CONFLICT (name) DO NOTHING;`,
      // Admin keeps the coarse master (it also bypasses checks by role name).
      JSON.stringify(['sales.view', 'sales.create', 'sales.edit', 'sales.delete', 'sales.assign', 'sales.scoring', 'sales.approve', 'sales.config', 'sales.team.manage', 'sales.targets.manage', 'sales.incentive.manage', 'sales.reports.view']),
      // GRANULAR role sets (1:1 with Development): explicit per-tab View keys +
      // coarse action keys (create/edit/delete) + capability keys. NO sales.view
      // master, so visibility is scoped exactly to the granted "View …" keys.
      // Manager is TEAM-scoped: NO sales.reports.view (org reporting is Director/
      // Admin only — see canViewOrgReports). Team performance is the Team page.
      JSON.stringify(['sales.dashboard.view', 'sales.dashboard.analytics', 'sales.leads.view', 'sales.deals.view', 'sales.contacts.view', 'sales.followups.view', 'sales.pipeline.view', 'sales.teams.view', 'sales.tasks.view', 'sales.tasks.team.view', 'sales.tasks.team.update', 'sales.targets.view', 'sales.create', 'sales.edit', 'sales.delete', 'sales.assign', 'sales.approve', 'sales.config', 'sales.team.manage', 'sales.targets.manage', 'sales.incentive.manage']),
      // BDE — restricted to the Pipeline workspace: NO master customer data (Contacts /
      // Companies) and NO coarse sales.create/sales.edit (they bridge to company/contact
      // writes via salesGrants). Its own tools (leads / deals / follow-ups / tasks) get
      // GRANULAR create/edit/complete instead, so nothing non-master is lost.
      JSON.stringify(['sales.dashboard.view', 'sales.leads.view', 'sales.leads.create', 'sales.leads.edit', 'sales.deals.view', 'sales.deals.create', 'sales.deals.edit', 'sales.followups.view', 'sales.followups.create', 'sales.followups.edit', 'sales.followups.complete', 'sales.pipeline.view', 'sales.tasks.view', 'sales.tasks.create', 'sales.tasks.edit', 'sales.tasks.complete', 'sales.targets.view']),
      JSON.stringify(['sales.dashboard.view', 'sales.leads.view', 'sales.deals.view', 'sales.contacts.view', 'sales.pipeline.view']),
      // SE-030+ — Director: org-wide reporting visibility (read-mostly).
      JSON.stringify(['sales.dashboard.view', 'sales.dashboard.analytics', 'sales.leads.view', 'sales.deals.view', 'sales.contacts.view', 'sales.pipeline.view', 'sales.teams.view', 'sales.tasks.view', 'sales.targets.view', 'sales.reports.view']),
    );
    // Grant SE-022/021 permissions to existing Admin/Sales Manager roles on
    // upgraded DBs (the INSERT above no-ops once the rows already exist).
    await prisma.$executeRawUnsafe(`
      UPDATE roles
         SET permissions = (
           SELECT jsonb_agg(DISTINCT p)
           FROM jsonb_array_elements(permissions || '["sales.approve","sales.config"]'::jsonb) AS p
         )
       WHERE LOWER(name) IN ('admin', 'sales manager')
         AND NOT (permissions @> '["sales.approve"]'::jsonb);
    `);
    // Grant SE-040/042/044 permissions (team / targets / incentive management)
    // to Admin + Sales Manager on upgraded DBs (separately guarded so it fires
    // even on DBs that already received sales.approve above).
    await prisma.$executeRawUnsafe(`
      UPDATE roles
         SET permissions = (
           SELECT jsonb_agg(DISTINCT p)
           FROM jsonb_array_elements(permissions || '["sales.team.manage","sales.targets.manage","sales.incentive.manage"]'::jsonb) AS p
         )
       WHERE LOWER(name) IN ('admin', 'sales manager')
         AND NOT (permissions @> '["sales.team.manage"]'::jsonb);
    `);
    // Grant SE-030+ org reporting (sales.reports.view) to Admin + Director on
    // upgraded DBs (Managers stay team-scoped, so they do NOT receive it).
    await prisma.$executeRawUnsafe(`
      UPDATE roles
         SET permissions = (
           SELECT jsonb_agg(DISTINCT p)
           FROM jsonb_array_elements(permissions || '["sales.reports.view"]'::jsonb) AS p
         )
       WHERE LOWER(name) IN ('admin', 'director')
         AND NOT (permissions @> '["sales.reports.view"]'::jsonb);
    `);
    // GRANULAR RBAC migration — convert the default Sales roles from the coarse
    // `sales.view` master (which unlocked every tab) to explicit per-tab View
    // keys, so visibility is scoped 1:1 like the Development module. Drops only
    // `sales.view`; keeps every other key (coarse create/edit/delete + capability
    // keys), so no action capability is lost. Guarded by `@> ["sales.view"]` so
    // it runs exactly once per role and never touches admin-customised roles.
    const migrateRoleViews = async (roleName: string, views: string[]) => {
      await prisma.$executeRawUnsafe(
        `UPDATE roles SET permissions = (
           SELECT jsonb_agg(DISTINCT v)
           FROM jsonb_array_elements_text((permissions - 'sales.view') || $1::jsonb) v
         )
         WHERE name = $2 AND permissions @> '["sales.view"]'::jsonb;`,
        JSON.stringify(views),
        roleName,
      );
    };
    await migrateRoleViews('Sales Manager', ['sales.dashboard.view', 'sales.dashboard.analytics', 'sales.leads.view', 'sales.deals.view', 'sales.contacts.view', 'sales.followups.view', 'sales.pipeline.view', 'sales.teams.view', 'sales.tasks.view', 'sales.tasks.team.view', 'sales.tasks.team.update', 'sales.targets.view']);
    // Remediation: managers seeded/migrated with org reporting before this fix
    // stay team-scoped (strip sales.reports.view; Director/Admin keep it).
    await prisma.$executeRawUnsafe(
      `UPDATE roles SET permissions = (permissions - 'sales.reports.view') WHERE name = 'Sales Manager' AND permissions @> '["sales.reports.view"]'::jsonb;`,
    );
    // BDE stays out of Contacts/Companies (master customer data) — no sales.contacts.view.
    await migrateRoleViews('BDE', ['sales.dashboard.view', 'sales.leads.view', 'sales.deals.view', 'sales.followups.view', 'sales.pipeline.view', 'sales.tasks.view', 'sales.targets.view']);
    await migrateRoleViews('Viewer', ['sales.dashboard.view', 'sales.leads.view', 'sales.deals.view', 'sales.contacts.view', 'sales.pipeline.view']);
    await migrateRoleViews('Director', ['sales.dashboard.view', 'sales.dashboard.analytics', 'sales.leads.view', 'sales.deals.view', 'sales.contacts.view', 'sales.pipeline.view', 'sales.teams.view', 'sales.tasks.view', 'sales.targets.view', 'sales.reports.view']);
    // Lead Analytics is now its own INDEPENDENT permission (sales.leads.analytics),
    // no longer implied by sales.dashboard.analytics. Grant it to every role that
    // already had dashboard analytics (Sales Manager, Director, …) so their existing
    // Lead Analytics access is preserved. Runs after the seed INSERT + migrations
    // above, so fresh AND upgraded DBs both receive it. Idempotent; Admin bypasses
    // by role name. BDE/Viewer (no dashboard.analytics) intentionally do NOT get it.
    await prisma.$executeRawUnsafe(`
      UPDATE roles
         SET permissions = (
           SELECT jsonb_agg(DISTINCT p)
           FROM jsonb_array_elements(permissions || '["sales.leads.analytics"]'::jsonb) AS p
         )
       WHERE permissions @> '["sales.dashboard.analytics"]'::jsonb
         AND NOT (permissions @> '["sales.leads.analytics"]'::jsonb);
    `);
    // Pipeline column management is its own INDEPENDENT permission set, separate
    // per module (Leads / Deals) and from editing the records themselves. Grant
    // all four to Admin + Sales Manager (managers own pipeline STRUCTURE); BDEs /
    // Viewers / Directors do NOT manage columns. Idempotent; Admin also bypasses
    // by role name. Runs on fresh + upgraded DBs.
    await prisma.$executeRawUnsafe(`
      UPDATE roles
         SET permissions = (
           SELECT jsonb_agg(DISTINCT p)
           FROM jsonb_array_elements(
             permissions || '["sales.leads.pipeline.manage","sales.leads.pipeline.delete","sales.deals.pipeline.manage","sales.deals.pipeline.delete"]'::jsonb
           ) AS p
         )
       WHERE LOWER(name) IN ('admin', 'sales manager')
         AND NOT (permissions @> '["sales.leads.pipeline.manage"]'::jsonb);
    `);
    // Target History is its own INDEPENDENT permission (sales.targets.history.view),
    // controllable separately from Targets in Role Management. Grant it to every
    // role that can already view Targets so existing access to the read-only
    // history page is preserved on upgrade; admins can then revoke it
    // independently. Idempotent; Admin bypasses by name. Runs on fresh + upgraded
    // DBs (after the seed INSERT above, so freshly-seeded target-viewers get it too).
    await prisma.$executeRawUnsafe(`
      UPDATE roles
         SET permissions = (
           SELECT jsonb_agg(DISTINCT p)
           FROM jsonb_array_elements(permissions || '["sales.targets.history.view"]'::jsonb) AS p
         )
       WHERE permissions @> '["sales.targets.view"]'::jsonb
         AND NOT (permissions @> '["sales.targets.history.view"]'::jsonb);
    `);

    // Companies is a new peer of Contacts. Grant the four Companies keys to every
    // role that can already see Contacts, so existing sales roles get the new module
    // on upgrade (SuperAdmin/Admin bypass by name; the sales.view bridge also covers
    // sales.companies.view). Idempotent; runs after the seed INSERT so fresh roles get it.
    await prisma.$executeRawUnsafe(`
      UPDATE roles
         SET permissions = (
           SELECT jsonb_agg(DISTINCT p)
           FROM jsonb_array_elements(permissions || '["sales.companies.view","sales.companies.create","sales.companies.edit","sales.companies.delete"]'::jsonb) AS p
         )
       WHERE permissions @> '["sales.contacts.view"]'::jsonb
         AND NOT (permissions @> '["sales.companies.view"]'::jsonb);
    `);
    console.log('✅ Default sales roles migrated to granular per-tab View permissions.');

    // ── BDE lockdown — restrict BDE to the Pipeline workspace (Contacts/Companies blocked) ──
    // Runs AFTER the Companies auto-grant above (which adds companies to anyone with
    // sales.contacts.view) so it strips what that would re-add. Removes the master-data view/
    // write keys AND the coarse sales.create/sales.edit (they bridge to company/contact writes
    // via salesGrants), then re-grants the granular create/edit/complete BDE needs for its own
    // tools so no non-master workflow regresses. Idempotent; guarded to run only until converged.
    await prisma.$executeRawUnsafe(`
      UPDATE roles
         SET permissions = (
           SELECT COALESCE(jsonb_agg(DISTINCT p), '[]'::jsonb)
           FROM jsonb_array_elements(
             (permissions
               - 'sales.contacts.view' - 'sales.contacts.create' - 'sales.contacts.edit' - 'sales.contacts.delete'
               - 'sales.companies.view' - 'sales.companies.create' - 'sales.companies.edit' - 'sales.companies.delete'
               - 'sales.create' - 'sales.edit')
             || '["sales.leads.create","sales.leads.edit","sales.deals.create","sales.deals.edit","sales.followups.create","sales.followups.edit","sales.followups.complete","sales.tasks.create","sales.tasks.edit","sales.tasks.complete"]'::jsonb
           ) AS p
         )
       WHERE name = 'BDE'
         AND (
           permissions @> '["sales.contacts.view"]'::jsonb
           OR permissions @> '["sales.companies.view"]'::jsonb
           OR permissions @> '["sales.create"]'::jsonb
           OR permissions @> '["sales.edit"]'::jsonb
           OR NOT (permissions @> '["sales.leads.create"]'::jsonb)
         );
    `);
    console.log('✅ BDE role restricted to Pipeline workspace (Companies/Contacts blocked, write-bridge closed).');


    /* =========================
   HR MODULE TABLES
========================= */

    // Employees
    await prisma.$executeRawUnsafe(`
  CREATE TABLE IF NOT EXISTS employees (
    id SERIAL PRIMARY KEY,
    user_id INTEGER UNIQUE REFERENCES users(id) ON DELETE SET NULL,
    employee_code VARCHAR(50) UNIQUE NOT NULL,
    department VARCHAR(100) NOT NULL,
    designation VARCHAR(100) NOT NULL,
    phone VARCHAR(20),
    address TEXT,
    emergency_contact VARCHAR(20),
    join_date TIMESTAMP NOT NULL,
    salary DOUBLE PRECISION DEFAULT 0,
    manager_id INTEGER REFERENCES employees(id) ON DELETE SET NULL,
    employment_status VARCHAR(50) DEFAULT 'active',
    date_of_birth DATE,
    created_at TIMESTAMP DEFAULT NOW()
  );
`);
    try {
      await prisma.$executeRawUnsafe(`
        ALTER TABLE employees ADD COLUMN IF NOT EXISTS date_of_birth DATE;
      `);
    } catch (e: any) {
      console.log('Employees table date_of_birth check info:', e.message);
    }
    console.log('✅ employees table verified');

    // Attendance
    await prisma.$executeRawUnsafe(`
  CREATE TABLE IF NOT EXISTS attendance (
    id SERIAL PRIMARY KEY,
    employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    check_in VARCHAR(10),
    lunch_out VARCHAR(10),
    lunch_in VARCHAR(10),
    check_out VARCHAR(10),
    work_hours DOUBLE PRECISION,
    status VARCHAR(50) DEFAULT 'present',
    date DATE NOT NULL,
    created_at TIMESTAMP DEFAULT NOW(),
    late_checkin BOOLEAN DEFAULT false,
    late_after_lunch BOOLEAN DEFAULT false,
    leave_type VARCHAR(50) NULL,
    notes TEXT NULL,
    UNIQUE(employee_id, date)
  );
`);
    // Ensure existing tables are updated with the new columns
    await prisma.$executeRawUnsafe(`
      ALTER TABLE attendance ADD COLUMN IF NOT EXISTS late_checkin BOOLEAN DEFAULT false;
    `);
    await prisma.$executeRawUnsafe(`
      ALTER TABLE attendance ADD COLUMN IF NOT EXISTS late_after_lunch BOOLEAN DEFAULT false;
    `);
    await prisma.$executeRawUnsafe(`
      ALTER TABLE attendance ADD COLUMN IF NOT EXISTS leave_type VARCHAR(50) NULL;
    `);
    await prisma.$executeRawUnsafe(`
      ALTER TABLE attendance ADD COLUMN IF NOT EXISTS notes TEXT NULL;
    `);
    console.log('✅ attendance table verified');

    // Attendance analytics indexes (Phase 1 - Attendance Analytics & Reporting).
    // Additive & idempotent (IF NOT EXISTS); no schema/column change. They speed
    // up the date-range, per-employee and status aggregations used by the
    // analytics endpoints added in a later milestone.
    await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS attendance_date_idx ON attendance (date);`);
    await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS attendance_employee_date_idx ON attendance (employee_id, date);`);
    await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS attendance_status_idx ON attendance (status);`);
    console.log('✅ attendance analytics indexes verified');

    // Leaves
    await prisma.$executeRawUnsafe(`
  CREATE TABLE IF NOT EXISTS leaves (
    id SERIAL PRIMARY KEY,
    employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    leave_type VARCHAR(50) NOT NULL,
    start_date TIMESTAMP NOT NULL,
    end_date TIMESTAMP NOT NULL,
    days INTEGER NOT NULL DEFAULT 1,
    reason TEXT,
    status VARCHAR(50) DEFAULT 'pending',
    approved_by INTEGER,
    half_period VARCHAR(12),
    created_at TIMESTAMP DEFAULT NOW()
  );
`);
    // Half-day session (leave duration/session, SEPARATE from the leave_type
    // category). NULL = full day; 'first_half' = 10:00–13:00 leave; 'second_half'
    // = 14:00–17:30 leave. Additive & idempotent for existing databases.
    await prisma.$executeRawUnsafe(`
      ALTER TABLE leaves ADD COLUMN IF NOT EXISTS half_period VARCHAR(12);
    `);
    console.log('✅ leaves table verified');

    // Payroll
    await prisma.$executeRawUnsafe(`
  CREATE TABLE IF NOT EXISTS payroll (
    id SERIAL PRIMARY KEY,
    employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    basic_salary DOUBLE PRECISION NOT NULL,
    bonus DOUBLE PRECISION DEFAULT 0,
    deduction DOUBLE PRECISION DEFAULT 0,
    net_salary DOUBLE PRECISION NOT NULL,
    month VARCHAR(20) NOT NULL,
    status VARCHAR(50) DEFAULT 'pending',
    created_at TIMESTAMP DEFAULT NOW()
  );
`);
    console.log('✅ payroll table verified');

    // Recruitment
    await prisma.$executeRawUnsafe(`
  CREATE TABLE IF NOT EXISTS candidates (
  id SERIAL PRIMARY KEY,
  full_name VARCHAR(255) NOT NULL,
  email VARCHAR(255),
  phone VARCHAR(20),
  position VARCHAR(150) NOT NULL,
  stage VARCHAR(50) DEFAULT 'Applied',
  experience VARCHAR(100),
  expected_ctc DOUBLE PRECISION,
  resume_url TEXT,
  interview_date TIMESTAMP,
  notes TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);
`);
    await prisma.$executeRawUnsafe(`
      ALTER TABLE candidates ADD COLUMN IF NOT EXISTS department VARCHAR(100);
    `);
    await prisma.$executeRawUnsafe(`
      ALTER TABLE candidates ADD COLUMN IF NOT EXISTS skills TEXT;
    `);
    await prisma.$executeRawUnsafe(`
      ALTER TABLE candidates ADD COLUMN IF NOT EXISTS match_score INTEGER DEFAULT 80;
    `);
    await prisma.$executeRawUnsafe(`
      ALTER TABLE candidates ADD COLUMN IF NOT EXISTS source VARCHAR(100);
    `);
    console.log('✅ recruitments table verified');

    // Documents
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS documents (
        id SERIAL PRIMARY KEY,
        employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
        document_type VARCHAR(100) NOT NULL,
        file_url TEXT NOT NULL,
        file_name VARCHAR(255) NOT NULL,
        expiry_date TIMESTAMP NULL,
        status VARCHAR(50) DEFAULT 'Pending',
        notes TEXT NULL,
        verified_by INTEGER NULL REFERENCES users(id) ON DELETE SET NULL,
        verified_at TIMESTAMP NULL,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    console.log('✅ documents table verified');

    // Performance Cycles
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS performance_cycles (
        id SERIAL PRIMARY KEY,
        title VARCHAR(150) NOT NULL,
        start_date TIMESTAMP NOT NULL,
        end_date TIMESTAMP NOT NULL,
        status VARCHAR(50) DEFAULT 'Upcoming',
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    console.log('✅ performance_cycles table verified');

    // Performance Appraisals
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS performance_appraisals (
        id SERIAL PRIMARY KEY,
        employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
        evaluator_id INTEGER REFERENCES employees(id) ON DELETE SET NULL,
        cycle_id INTEGER NOT NULL REFERENCES performance_cycles(id) ON DELETE CASCADE,
        status VARCHAR(50) DEFAULT 'draft',
        
        self_rating_tech DOUBLE PRECISION,
        self_rating_comm DOUBLE PRECISION,
        self_rating_team DOUBLE PRECISION,
        self_rating_prod DOUBLE PRECISION,
        self_rating_solve DOUBLE PRECISION,
        self_rating_lead DOUBLE PRECISION,
        self_comments TEXT,

        manager_rating_tech DOUBLE PRECISION,
        manager_rating_comm DOUBLE PRECISION,
        manager_rating_team DOUBLE PRECISION,
        manager_rating_prod DOUBLE PRECISION,
        manager_rating_solve DOUBLE PRECISION,
        manager_rating_lead DOUBLE PRECISION,
        manager_comments TEXT,
        manager_scores JSONB,
        overall_rating DOUBLE PRECISION,
        approved_at TIMESTAMP,

        final_rating DOUBLE PRECISION DEFAULT 0,
        final_comments TEXT,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);

    await prisma.$executeRawUnsafe(`
      ALTER TABLE performance_appraisals ADD COLUMN IF NOT EXISTS manager_scores JSONB;
    `);
    await prisma.$executeRawUnsafe(`
      ALTER TABLE performance_appraisals ADD COLUMN IF NOT EXISTS overall_rating DOUBLE PRECISION;
    `);
    await prisma.$executeRawUnsafe(`
      ALTER TABLE performance_appraisals ADD COLUMN IF NOT EXISTS approved_at TIMESTAMP;
    `);
    // console.log('✅ performance_appraisals table verified');

    // Performance Goals
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS performance_goals (
        id SERIAL PRIMARY KEY,
        employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
        appraisal_id INTEGER REFERENCES performance_appraisals(id) ON DELETE SET NULL,
        title VARCHAR(255) NOT NULL,
        description TEXT,
        weight DOUBLE PRECISION DEFAULT 0,
        progress_pct DOUBLE PRECISION DEFAULT 0,
        score DOUBLE PRECISION DEFAULT 0,
        target_date TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);
    // console.log('✅ performance_goals table verified');

    await prisma.$executeRawUnsafe(
      `
  INSERT INTO roles (name, description, permissions)
  VALUES
    ('HR Admin', $1, $2::jsonb),
    ('Employee', $3, $4::jsonb)
  ON CONFLICT (name) DO NOTHING;
  `,
      'Full HR access',
      JSON.stringify([
        'hr.view',
        'hr.create',
        'hr.edit',
        'hr.delete',
        'hr.attendance',
        'hr.analytics.view',
        'hr.leave.view',
        'hr.leave.approve',
        'hr.payroll.process',
        'hr.recruitment',
        'hr.performance.view',
        'hr.performance.create',
        'hr.performance.review',
        'hr.performance.approve'
      ]),
      'Employee self service',
      JSON.stringify([
        'hr.attendance',
        'hr.leave.apply',
        'hr.performance.view'
      ])
    );
    // console.log('✅ HR roles seeded');

    // HR Leave view permissions (independent Staff vs HR-Admin views, 2026-07).
    // Backfill existing roles so nobody loses leave access when the leave routes
    // switched from hr.view/hr.create gating to hr.leave.view/hr.leave.self:
    //  - any role with broad HR access (hr.view) → gets hr.leave.view (HR-Admin leave)
    //  - any role that can apply for leave (hr.leave.apply) → gets hr.leave.self (staff leave)
    // Idempotent: the `NOT ... @>` guard skips roles that already have the key.
    await prisma.$executeRawUnsafe(`
      UPDATE roles
      SET permissions = permissions || '["hr.leave.view"]'::jsonb
      WHERE permissions @> '["hr.view"]'::jsonb
        AND NOT permissions @> '["hr.leave.view"]'::jsonb;
    `);
    await prisma.$executeRawUnsafe(`
      UPDATE roles
      SET permissions = permissions || '["hr.leave.self"]'::jsonb
      WHERE permissions @> '["hr.leave.apply"]'::jsonb
        AND NOT permissions @> '["hr.leave.self"]'::jsonb;
    `);
    console.log('✅ HR leave view permissions (hr.leave.view / hr.leave.self) backfilled.');

    // HR Attendance Analytics view permission (Phase 1). Backfill existing roles
    // that already hold broad HR access (hr.view) so HR admins gain the new
    // analytics-view key without a manual role edit. Idempotent: the NOT @> guard
    // skips roles that already have it.
    await prisma.$executeRawUnsafe(`
      UPDATE roles
      SET permissions = permissions || '["hr.analytics.view"]'::jsonb
      WHERE permissions @> '["hr.view"]'::jsonb
        AND NOT permissions @> '["hr.analytics.view"]'::jsonb;
    `);
    console.log('✅ HR attendance analytics permission (hr.analytics.view) backfilled.');

    // Finance — first-class module role (mirrors Sales/Development). Seeded with
    // the full finance.* view set + the coarse `finance.view` module-access key so
    // the role can open the module and every Finance page. Admins/Founder bypass
    // via isGlobalAdmin; other roles get Finance access only when an admin grants
    // any finance.* permission in Role Management. Idempotent (ON CONFLICT).
    await prisma.$executeRawUnsafe(
      `INSERT INTO roles (name, description, permissions)
       VALUES ('Finance', $1, $2::jsonb)
       ON CONFLICT (name) DO NOTHING;`,
      'Finance module access — income, expenses, transactions & reporting',
      JSON.stringify([
        'finance.view',
        'finance.dashboard.view',
        'finance.income.view',
        'finance.income.create',
        'finance.income.edit',
        'finance.income.delete',
        'finance.expenses.view',
        'finance.expenses.create',
        'finance.expenses.edit',
        'finance.expenses.delete',
        'finance.transactions.view',
        'finance.reports.view',
        'finance.settings.view',
      ]),
    );
    // console.log('✅ Finance role seeded');

    // Finance module tables (Phase 1). Provisioned via idempotent raw SQL (this
    // project has no Prisma migrations); mirrors the FinanceIncome/FinanceExpense
    // models in schema.prisma. Money received = income; money spent = expense.
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS finance_income (
        id             SERIAL PRIMARY KEY,
        title          VARCHAR(255) NOT NULL,
        customer       VARCHAR(255),
        project        VARCHAR(255),
        amount         DOUBLE PRECISION NOT NULL DEFAULT 0,
        income_date    TIMESTAMP NOT NULL DEFAULT NOW(),
        payment_method VARCHAR(50) NOT NULL DEFAULT 'cash',
        status         VARCHAR(20) NOT NULL DEFAULT 'pending',
        notes          TEXT,
        created_by     INTEGER,
        created_at     TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at     TIMESTAMP NOT NULL DEFAULT NOW()
      );
    `);
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS finance_expense (
        id             SERIAL PRIMARY KEY,
        title          VARCHAR(255) NOT NULL,
        category       VARCHAR(100) NOT NULL DEFAULT 'general',
        vendor         VARCHAR(255),
        amount         DOUBLE PRECISION NOT NULL DEFAULT 0,
        expense_date   TIMESTAMP NOT NULL DEFAULT NOW(),
        payment_method VARCHAR(50) NOT NULL DEFAULT 'cash',
        status         VARCHAR(20) NOT NULL DEFAULT 'pending',
        notes          TEXT,
        created_by     INTEGER,
        created_at     TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at     TIMESTAMP NOT NULL DEFAULT NOW()
      );
    `);
    // console.log('✅ Finance tables ensured');

    // Sample Finance data (Phase 1). Seeded ONCE — only when the tables are empty
    // (WHERE NOT EXISTS), so it never duplicates on reboot and disappears the
    // moment real data is entered. Gives the Dashboard/Reports/Transactions live
    // numbers out of the box. Amounts in INR.
    await prisma.$executeRawUnsafe(`
      INSERT INTO finance_income (title, customer, project, amount, income_date, payment_method, status, notes)
      SELECT v.title, v.customer, v.project, v.amount, v.income_date, v.payment_method, v.status, v.notes
      FROM (VALUES
        ('Invoice #INV-1050', 'Acme Corporation',    'Website Redesign', 240000::double precision, '2026-06-28'::timestamp, 'Bank Transfer', 'received', 'Milestone 2 payment'),
        ('Invoice #INV-1051', 'XYZ Retail Pvt Ltd',  'Mobile App',       180000,                    '2026-06-20',            'UPI',           'received', NULL),
        ('June Retainer',     'Globex Ltd',          'Support Retainer',  90000,                    '2026-06-05',            'Bank Transfer', 'received', 'Monthly retainer'),
        ('Invoice #INV-1052', 'Initech',             'ERP Rollout',      320000,                    '2026-06-30',            'Cheque',        'pending',  'Awaiting cheque clearance'),
        ('AMC Renewal',       'Umbrella Inc',         NULL,               60000,                    '2026-05-22',            'Card',          'received', NULL),
        ('Consulting — May',  'Hooli',               'Data Migration',   145000,                    '2026-05-10',            'Bank Transfer', 'received', NULL)
      ) AS v(title, customer, project, amount, income_date, payment_method, status, notes)
      WHERE NOT EXISTS (SELECT 1 FROM finance_income);
    `);
    await prisma.$executeRawUnsafe(`
      INSERT INTO finance_expense (title, category, vendor, amount, expense_date, payment_method, status, notes)
      SELECT v.title, v.category, v.vendor, v.amount, v.expense_date, v.payment_method, v.status, v.notes
      FROM (VALUES
        ('Office Rent — June',   'Rent & Utilities', 'WeWork',      100000::double precision, '2026-06-01'::timestamp, 'Bank Transfer', 'paid',    'Monthly rent'),
        ('Cloud Hosting',        'Software',         'AWS',          45000,                    '2026-06-03',            'Card',          'paid',    NULL),
        ('Marketing Campaign',   'Marketing',       'Google Ads',   80000,                    '2026-06-15',            'Card',          'paid',    'Q2 push'),
        ('Team Lunch',           'Office & Admin',  'Zomato',       12000,                    '2026-06-18',            'UPI',           'paid',    NULL),
        ('Laptops (3 units)',    'Office & Admin',  'Dell',         210000,                   '2026-05-25',            'Bank Transfer', 'paid',    'New hires'),
        ('GST Payment',          'Taxes',            NULL,           95000,                    '2026-06-20',            'Bank Transfer', 'pending', 'Q1 GST'),
        ('Travel — Client Visit','Travel',          'MakeMyTrip',    38000,                    '2026-05-12',            'Card',          'paid',    NULL)
      ) AS v(title, category, vendor, amount, expense_date, payment_method, status, notes)
      WHERE NOT EXISTS (SELECT 1 FROM finance_expense);
    `);
    console.log('✅ Finance sample data ensured');

    // ============================================================
    // My Tasks Module (standalone) — independent tables. NO FK to
    // kanban_tasks / boards / sprints / SalesTask; only users(id).
    // ============================================================
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS my_tasks (
        id SERIAL PRIMARY KEY,
        title VARCHAR(255) NOT NULL,
        description TEXT,
        priority VARCHAR(50) NOT NULL DEFAULT 'medium',
        status VARCHAR(50) NOT NULL DEFAULT 'todo',
        due_date DATE,
        created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMP(6) NOT NULL DEFAULT now(),
        updated_at TIMESTAMP(6) NOT NULL DEFAULT now(),
        last_activity_at TIMESTAMP(6)
      );
    `);
    await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS my_tasks_created_by_idx ON my_tasks (created_by);`);
    await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS my_tasks_due_date_idx ON my_tasks (due_date);`);

    await prisma.$executeRawUnsafe(`
      ALTER TABLE my_tasks
      ADD COLUMN IF NOT EXISTS in_charge_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS due_time VARCHAR(50),
      ADD COLUMN IF NOT EXISTS last_activity_at TIMESTAMP(6),
      ADD COLUMN IF NOT EXISTS waiting_reason VARCHAR(255),
      ADD COLUMN IF NOT EXISTS project_id VARCHAR(255) REFERENCES projects(id) ON DELETE SET NULL;
    `);
    await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS my_tasks_project_id_idx ON my_tasks (project_id);`);
    // One-time backfill (idempotent — only NULLs) so existing tasks aren't all
    // flagged unread on upgrade; new rows get last_activity_at via Prisma default.
    await prisma.$executeRawUnsafe(`
      UPDATE my_tasks SET last_activity_at = COALESCE(updated_at, created_at, now()) WHERE last_activity_at IS NULL;
    `);

    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS my_task_members (
        id SERIAL PRIMARY KEY,
        task_id INTEGER NOT NULL REFERENCES my_tasks(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        added_by INTEGER,
        added_at TIMESTAMP(6) NOT NULL DEFAULT now(),
        CONSTRAINT unique_my_task_member UNIQUE (task_id, user_id)
      );
    `);
    await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS my_task_members_user_id_idx ON my_task_members (user_id);`);

    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS my_task_messages (
        id SERIAL PRIMARY KEY,
        task_id INTEGER NOT NULL REFERENCES my_tasks(id) ON DELETE CASCADE,
        sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        message TEXT NOT NULL,
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMP(6) NOT NULL DEFAULT now(),
        updated_at TIMESTAMP(6) NOT NULL DEFAULT now()
      );
    `);
    await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS my_task_messages_task_id_idx ON my_task_messages (task_id);`);

    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS my_task_attachments (
        id SERIAL PRIMARY KEY,
        task_id INTEGER NOT NULL REFERENCES my_tasks(id) ON DELETE CASCADE,
        message_id INTEGER REFERENCES my_task_messages(id) ON DELETE CASCADE,
        file_name VARCHAR(255) NOT NULL,
        file_url TEXT NOT NULL,
        file_size INTEGER NOT NULL DEFAULT 0,
        uploaded_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        uploaded_at TIMESTAMP(6) NOT NULL DEFAULT now()
      );
    `);
    await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS my_task_attachments_task_id_idx ON my_task_attachments (task_id);`);

    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS my_task_reads (
        id SERIAL PRIMARY KEY,
        task_id INTEGER NOT NULL REFERENCES my_tasks(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        last_read_at TIMESTAMP(6) NOT NULL DEFAULT now(),
        CONSTRAINT unique_my_task_read UNIQUE (task_id, user_id)
      );
    `);

    // Activity Timeline log — one row per task event (created / status / member /
    // etc). The /workspace query INCLUDEs this relation, so a missing table makes
    // the whole endpoint throw Prisma P2021. Mirrors model my_task_activities.
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS my_task_activities (
        id SERIAL PRIMARY KEY,
        task_id INTEGER NOT NULL REFERENCES my_tasks(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        action VARCHAR(255) NOT NULL,
        details JSONB DEFAULT '{}',
        created_at TIMESTAMP(6) NOT NULL DEFAULT now()
      );
    `);
    await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS my_task_activities_task_id_idx ON my_task_activities (task_id);`);
    console.log('✅ My Tasks module tables verified (my_tasks, my_task_members, my_task_messages, my_task_attachments, my_task_reads, my_task_activities).');

    // ============================================================
    // Notice module — company announcements. Configurable categories
    // (seeded once, admin-managed), notices, and a per-user read cursor.
    // ============================================================
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS notice_categories (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) UNIQUE NOT NULL,
        color VARCHAR(20) NOT NULL DEFAULT '#64748b',
        icon VARCHAR(50),
        order_index INTEGER NOT NULL DEFAULT 0,
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    // Seed the 10 default categories ONLY when the table is empty (idempotent —
    // admins may later rename/recolor/reorder/disable without them reappearing).
    await prisma.$executeRawUnsafe(`
      INSERT INTO notice_categories (name, color, icon, order_index, is_active)
      SELECT v.name, v.color, v.icon, v.order_index, TRUE
      FROM (VALUES
        ('General',       '#64748b', 'Megaphone',   1),
        ('HR',            '#3b82f6', 'Users',       2),
        ('Policy',        '#8b5cf6', 'ShieldCheck', 3),
        ('Meeting',       '#6366f1', 'CalendarDays', 4),
        ('Operations',    '#f97316', 'Settings',    5),
        ('IT & Systems',  '#06b6d4', 'Cpu',         6),
        ('Finance',       '#10b981', 'DollarSign',  7),
        ('Emergency',     '#ef4444', 'AlertTriangle', 8),
        ('Maintenance',   '#eab308', 'Wrench',      9),
        ('Celebration',   '#ec4899', 'PartyPopper', 10)
      ) AS v(name, color, icon, order_index)
      WHERE NOT EXISTS (SELECT 1 FROM notice_categories);
    `);
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS notices (
        id SERIAL PRIMARY KEY,
        title VARCHAR(255) NOT NULL,
        body TEXT NOT NULL,
        category_id INTEGER REFERENCES notice_categories(id) ON DELETE SET NULL,
        priority VARCHAR(20) NOT NULL DEFAULT 'medium',
        is_pinned BOOLEAN NOT NULL DEFAULT FALSE,
        is_important BOOLEAN NOT NULL DEFAULT FALSE,
        audience_type VARCHAR(20) NOT NULL DEFAULT 'company',
        status VARCHAR(20) NOT NULL DEFAULT 'published',
        published_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        published_at TIMESTAMP(6) NOT NULL DEFAULT now(),
        expires_at TIMESTAMP(6),
        created_at TIMESTAMP(6) NOT NULL DEFAULT now(),
        updated_at TIMESTAMP(6) NOT NULL DEFAULT now()
      );
    `);
    // Idempotent fixups for any table created by an earlier build with the original
    // NOT NULL / ON DELETE CASCADE publisher FK (CREATE TABLE IF NOT EXISTS won't
    // alter an existing table): keep company notices when their author is deleted.
    await prisma.$executeRawUnsafe(`ALTER TABLE notices ALTER COLUMN published_by DROP NOT NULL;`);
    await prisma.$executeRawUnsafe(`ALTER TABLE notices DROP CONSTRAINT IF EXISTS notices_published_by_fkey;`);
    await prisma.$executeRawUnsafe(`ALTER TABLE notices ADD CONSTRAINT notices_published_by_fkey FOREIGN KEY (published_by) REFERENCES users(id) ON DELETE SET NULL;`);
    // Audience targeting + acknowledgement columns (idempotent for existing tables).
    await prisma.$executeRawUnsafe(`ALTER TABLE notices ADD COLUMN IF NOT EXISTS audience_type VARCHAR(20) NOT NULL DEFAULT 'company';`);
    // Lifecycle status — existing rows are already visible, so they default to 'published'.
    await prisma.$executeRawUnsafe(`ALTER TABLE notices ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'published';`);
    await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS notices_status_idx ON notices (status);`);
    await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS notices_published_at_idx ON notices (published_at);`);
    await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS notices_category_id_idx ON notices (category_id);`);
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS notice_reads (
        id SERIAL PRIMARY KEY,
        notice_id INTEGER NOT NULL REFERENCES notices(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        last_read_at TIMESTAMP(6) NOT NULL DEFAULT now(),
        acknowledged_at TIMESTAMP(6),
        CONSTRAINT unique_notice_read UNIQUE (notice_id, user_id)
      );
    `);
    await prisma.$executeRawUnsafe(`ALTER TABLE notice_reads ADD COLUMN IF NOT EXISTS acknowledged_at TIMESTAMP(6);`);
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS notice_targets (
        id SERIAL PRIMARY KEY,
        notice_id INTEGER NOT NULL REFERENCES notices(id) ON DELETE CASCADE,
        target_type VARCHAR(30) NOT NULL DEFAULT 'department',
        target_value VARCHAR(150) NOT NULL
      );
    `);
    await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS notice_targets_notice_id_idx ON notice_targets (notice_id);`);
    await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS notice_targets_type_value_idx ON notice_targets (target_type, target_value);`);
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS notice_attachments (
        id SERIAL PRIMARY KEY,
        notice_id INTEGER NOT NULL REFERENCES notices(id) ON DELETE CASCADE,
        file_name VARCHAR(255) NOT NULL,
        file_url TEXT NOT NULL,
        file_size INTEGER,
        file_type VARCHAR(120),
        is_link BOOLEAN NOT NULL DEFAULT FALSE,
        uploaded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        uploaded_at TIMESTAMP(6) NOT NULL DEFAULT now()
      );
    `);
    await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS notice_attachments_notice_id_idx ON notice_attachments (notice_id);`);
    console.log('✅ Notice module tables verified and seeded (notice_categories, notices, notice_reads, notice_attachments).');
  }
  catch (error) {
    console.error('❌ Failed to initialize database:', error);
  }
};

