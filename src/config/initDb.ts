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
        stage VARCHAR(100) NOT NULL DEFAULT 'New',
        order_index INTEGER NOT NULL DEFAULT 0,
        priority VARCHAR(50) NOT NULL DEFAULT 'medium',
        score INTEGER NOT NULL DEFAULT 0,
        tags TEXT,
        "customerId" INTEGER REFERENCES "Customer"(id) ON DELETE SET NULL,
        "ownerId" INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        "createdAt" TIMESTAMP DEFAULT NOW(),
        "updatedAt" TIMESTAMP DEFAULT NOW()
      );
    `);

    // Safe-upgrade existing Lead/Customer tables with the pipeline columns.
    await prisma.$executeRawUnsafe(`
      ALTER TABLE "Lead" ADD COLUMN IF NOT EXISTS stage VARCHAR(100) NOT NULL DEFAULT 'New';
    `);
    await prisma.$executeRawUnsafe(`
      ALTER TABLE "Lead" ADD COLUMN IF NOT EXISTS order_index INTEGER NOT NULL DEFAULT 0;
    `);
    await prisma.$executeRawUnsafe(`
      ALTER TABLE "Lead" ADD COLUMN IF NOT EXISTS score INTEGER NOT NULL DEFAULT 0;
    `);
    await prisma.$executeRawUnsafe(`
      ALTER TABLE "Lead" ADD COLUMN IF NOT EXISTS tags TEXT;
    `);
    await prisma.$executeRawUnsafe(`
      ALTER TABLE "Customer" ADD COLUMN IF NOT EXISTS address TEXT;
    `);
    await prisma.$executeRawUnsafe(`
      UPDATE "Lead" SET stage = 'New' WHERE stage IS NULL OR stage = '';
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

    await prisma.$executeRawUnsafe(`
      INSERT INTO lead_stages (name, order_index, is_default)
      SELECT v.name, v.order_index, TRUE
      FROM (VALUES
        ('New', 1),
        ('Discovery Meet', 2),
        ('BRD Shared', 3),
        ('Estimation Planning', 4),
        ('Proposal', 5)
      ) AS v(name, order_index)
      WHERE NOT EXISTS (SELECT 1 FROM lead_stages);
    `);

    await prisma.$executeRawUnsafe(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM lead_stages WHERE name = 'Contacted')
           AND NOT EXISTS (SELECT 1 FROM lead_stages WHERE name = 'Discovery Meet') THEN
          UPDATE lead_stages SET name = 'Discovery Meet' WHERE name = 'Contacted';
          UPDATE "Lead" SET stage = 'Discovery Meet' WHERE stage = 'Contacted';
        END IF;

        IF EXISTS (SELECT 1 FROM lead_stages WHERE name = 'Interested')
           AND NOT EXISTS (SELECT 1 FROM lead_stages WHERE name = 'BRD Shared') THEN
          UPDATE lead_stages SET name = 'BRD Shared' WHERE name = 'Interested';
          UPDATE "Lead" SET stage = 'BRD Shared' WHERE stage = 'Interested';
        END IF;

        IF EXISTS (SELECT 1 FROM lead_stages WHERE name = 'Negotiating')
           AND NOT EXISTS (SELECT 1 FROM lead_stages WHERE name = 'Estimation Planning') THEN
          UPDATE lead_stages SET name = 'Estimation Planning' WHERE name = 'Negotiating';
          UPDATE "Lead" SET stage = 'Estimation Planning' WHERE stage = 'Negotiating';
        END IF;

        -- Add the Proposal column when the board is the canonical default set
        -- (New + the three renamed stages) and Proposal is missing.
        IF NOT EXISTS (SELECT 1 FROM lead_stages WHERE name = 'Proposal')
           AND EXISTS (SELECT 1 FROM lead_stages WHERE name = 'Estimation Planning')
           AND NOT EXISTS (
             SELECT 1 FROM lead_stages
             WHERE name NOT IN ('New', 'Discovery Meet', 'BRD Shared', 'Estimation Planning')
           ) THEN
          INSERT INTO lead_stages (name, order_index, is_default)
          VALUES ('Proposal', (SELECT MAX(order_index) FROM lead_stages) + 1, TRUE);
        END IF;

        -- Normalise to the canonical order ONLY when the board is exactly the
        -- five default stages — never reshuffle a board the admin customised.
        IF (SELECT COUNT(*) FROM lead_stages) = 5
           AND NOT EXISTS (
             SELECT 1 FROM lead_stages
             WHERE name NOT IN ('New', 'Discovery Meet', 'BRD Shared', 'Estimation Planning', 'Proposal')
           ) THEN
          UPDATE lead_stages SET order_index = 1, is_default = TRUE WHERE name = 'New';
          UPDATE lead_stages SET order_index = 2, is_default = TRUE WHERE name = 'Discovery Meet';
          UPDATE lead_stages SET order_index = 3, is_default = TRUE WHERE name = 'BRD Shared';
          UPDATE lead_stages SET order_index = 4, is_default = TRUE WHERE name = 'Estimation Planning';
          UPDATE lead_stages SET order_index = 5, is_default = TRUE WHERE name = 'Proposal';
        END IF;
      END $$;
    `);
    console.log('✅ "lead_stages" table is verified and seeded.');

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
      JSON.stringify(['sales.view', 'sales.create', 'sales.edit', 'sales.delete', 'sales.assign', 'sales.scoring', 'sales.approve', 'sales.config', 'sales.team.manage', 'sales.targets.manage', 'sales.incentive.manage', 'sales.reports.view']),
      JSON.stringify(['sales.view', 'sales.create', 'sales.edit', 'sales.delete', 'sales.assign', 'sales.approve', 'sales.config', 'sales.team.manage', 'sales.targets.manage', 'sales.incentive.manage']),
      JSON.stringify(['sales.view', 'sales.create', 'sales.edit']),
      JSON.stringify(['sales.view']),
      // SE-030+ — Director: org-wide reporting visibility (read-mostly).
      JSON.stringify(['sales.view', 'sales.reports.view']),
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
    console.log('✅ Default sales roles (Admin/Sales Manager/BDE/Viewer/Director) verified.');


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
    created_at TIMESTAMP DEFAULT NOW()
  );
`);
    console.log('✅ employees table verified');

    // Attendance
    await prisma.$executeRawUnsafe(`
  CREATE TABLE IF NOT EXISTS attendance (
    id SERIAL PRIMARY KEY,
    employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    check_in TIMESTAMP,
    lunch_out TIMESTAMP,
    lunch_in TIMESTAMP,
    check_out TIMESTAMP,
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
    created_at TIMESTAMP DEFAULT NOW()
  );
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
    console.log('✅ recruitments table verified');

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
        'hr.leave.approve',
        'hr.payroll.process',
        'hr.recruitment'
      ]),
      'Employee self service',
      JSON.stringify([
        'hr.attendance',
        'hr.leave.apply'
      ])
    );
    console.log('✅ HR roles seeded');
  }
  catch (error) {
    console.error('❌ Failed to initialize database:', error);
  }
};
