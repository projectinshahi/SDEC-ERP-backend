import prisma from './db.js';
import { createHash } from 'crypto';

/** SHA-256 hash function */
function hashPassword(plain: string): string {
  return createHash('sha256').update(plain).digest('hex');
}

/**
 * Initializes database tables and configuration values dynamically.
 * Self-healing DB check that creates and seeds the column_config table.
 */
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

    // ── Lead Management Module ────────────────────────────────────────────────
    // Provision the core sales tables on a fresh DB so initDb is self-sufficient
    // (mirrors the users/roles/kanban_* pattern). No-ops where the schema already
    // exists (created by `prisma db push`).
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
    // Any pre-existing lead with no stage must still belong to exactly one stage.
    await prisma.$executeRawUnsafe(`
      UPDATE "Lead" SET stage = 'New' WHERE stage IS NULL OR stage = '';
    `);
    console.log('✅ "Lead"/"Customer" pipeline columns verified.');

    // Pipeline stages — the controlled, ordered set used by the board & analytics.
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS lead_stages (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) UNIQUE NOT NULL,
        order_index INTEGER NOT NULL,
        is_default BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    // Seed the four default stages in fixed order (idempotent).
    await prisma.$executeRawUnsafe(`
      INSERT INTO lead_stages (name, order_index, is_default)
      VALUES
        ('New', 1, TRUE),
        ('Contacted', 2, FALSE),
        ('Interested', 3, FALSE),
        ('Negotiating', 4, FALSE)
      ON CONFLICT (name) DO NOTHING;
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
      INSERT INTO lead_scoring_criteria (factor, label, weight, is_active)
      VALUES
        ('interest_level',    'Interest Level',    30, TRUE),
        ('company_size',      'Company Size',      25, TRUE),
        ('responsiveness',    'Responsiveness',    20, TRUE),
        ('source_quality',    'Source Quality',    15, TRUE),
        ('interactions',      'Interaction Count', 10, TRUE),
        ('industry',          'Industry',          10, FALSE),
        ('budget',            'Budget',            15, FALSE),
        ('meeting_scheduled', 'Meeting Scheduled', 10, FALSE)
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
         ('Viewer', 'Read-only access', $4::jsonb)
       ON CONFLICT (name) DO NOTHING;`,
      JSON.stringify(['sales.view', 'sales.create', 'sales.edit', 'sales.delete', 'sales.assign', 'sales.scoring', 'sales.approve', 'sales.config']),
      JSON.stringify(['sales.view', 'sales.create', 'sales.edit', 'sales.delete', 'sales.assign', 'sales.approve', 'sales.config']),
      JSON.stringify(['sales.view', 'sales.create', 'sales.edit']),
      JSON.stringify(['sales.view']),
    );
    // Grant the two new sales permissions to existing Admin/Sales Manager roles
    // on upgraded DBs (the INSERT above no-ops once the rows already exist).
    await prisma.$executeRawUnsafe(`
      UPDATE roles
         SET permissions = (
           SELECT jsonb_agg(DISTINCT p)
           FROM jsonb_array_elements(permissions || '["sales.approve","sales.config"]'::jsonb) AS p
         )
       WHERE LOWER(name) IN ('admin', 'sales manager')
         AND NOT (permissions @> '["sales.approve"]'::jsonb);
    `);
    console.log('✅ Default sales roles (Admin/Sales Manager/BDE/Viewer) verified.');

  } catch (error) {
    console.error('❌ Failed to initialize database:', error);
  }
};
