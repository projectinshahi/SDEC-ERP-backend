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

  } catch (error) {
    console.error('❌ Failed to initialize database:', error);
  }
};
