import prisma from './db';

/**
 * Initializes database tables and configuration values dynamically.
 * Self-healing DB check that creates and seeds the column_config table.
 */
export const initDb = async () => {
  console.log('🔄 Initializing database schema and configurations...');
  try {
    // 1. Create column_config table if it doesn't exist
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

    // 3. Create kanban_columns table if it doesn't exist
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS kanban_columns (
        id VARCHAR(255) PRIMARY KEY,
        label VARCHAR(255) NOT NULL,
        order_index INTEGER NOT NULL
      );
    `);
    console.log('✅ "kanban_columns" table is verified.');

    // 4. Create kanban_tasks table if it doesn't exist
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
    console.log('✅ "kanban_tasks" table is verified.');

    // 5. Seed default kanban columns if empty
    const columnCountResult = await prisma.$queryRawUnsafe<any[]>(
      'SELECT COUNT(*) as count FROM kanban_columns;'
    );
    const colCount = Number(columnCountResult[0]?.count || 0);
    if (colCount === 0) {
      await prisma.$executeRawUnsafe(`
        INSERT INTO kanban_columns (id, label, order_index) VALUES
          ('todo', 'To Do', 1),
          ('in-progress', 'In Progress', 2),
          ('review', 'Review', 3),
          ('done', 'Done', 4);
      `);
      console.log('✅ Seeded default kanban columns.');
    }

    // 6. Seed default kanban tasks if empty
    const taskCountResult = await prisma.$queryRawUnsafe<any[]>(
      'SELECT COUNT(*) as count FROM kanban_tasks;'
    );
    const taskCount = Number(taskCountResult[0]?.count || 0);
    if (taskCount === 0) {
      await prisma.$executeRawUnsafe(`
        INSERT INTO kanban_tasks (id, title, description, priority, assignee, status, "dueDate", order_index) VALUES
          ('task-1', 'Implement User Authentication API', 'Create backend routes, verify JWT tokens and secure passwords.', 'high', 'John Doe', 'todo', '2026-06-01', 1),
          ('task-2', 'Design PostgreSQL Schema Layout', 'Structure users, roles and custom metadata parameters.', 'medium', 'Jane Smith', 'in-progress', '2026-06-05', 1),
          ('task-3', 'Conduct Dynamic UI Dashboard Testing', 'Test client table filters, responsive layout drawers and reorders.', 'low', 'Bob Johnson', 'review', '2026-06-10', 1);
      `);
      console.log('✅ Seeded default kanban tasks.');
    }
  } catch (error) {
    console.error('❌ Failed to initialize database:', error);
  }
};
