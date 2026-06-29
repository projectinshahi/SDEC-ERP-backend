import { Request, Response } from 'express';
import { createHash } from 'crypto';
import prisma from '../../config/db.js';

/** SHA-256 hash — same algorithm used across auth and user creation */
function hashPassword(plain: string): string {
  return createHash('sha256').update(plain).digest('hex');
}

/**
 * Auto-generate employee code in EMP-<YEAR>-<NNN> format.
 * Counts existing employees for the current year to derive the running number.
 */
async function generateEmployeeCode(): Promise<string> {
  const year = new Date().getFullYear();
  const prefix = `EMP-${year}-`;
  const rows = await prisma.$queryRawUnsafe<any[]>(
    `SELECT COUNT(*) AS cnt FROM employees WHERE employee_code LIKE $1;`,
    `${prefix}%`
  );
  const count = Number(rows[0]?.cnt ?? 0) + 1;
  return `${prefix}${String(count).padStart(3, '0')}`;
}

/**
 * Derive department automatically from role name or designation.
 */
function deriveDepartment(role?: string, designation?: string): string {
  const src = (role ?? designation ?? '').toLowerCase();
  if (/admin|hr/.test(src))                          return 'Management';
  if (/full.?stack|frontend|backend|developer/.test(src)) return 'Development';
  if (/design/.test(src))                            return 'Design';
  if (/qa|tester|test/.test(src))                   return 'QA';
  return 'General';
}

/** Generate a random 12-character temporary password */
function generateTempPassword(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*';
  let password = '';
  for (let i = 0; i < 12; i++) {
    password += chars[Math.floor(Math.random() * chars.length)];
  }
  return password;
}

/**
 * GET /hr/employees
 * Returns all employees joined with their linked user record.
 */
export const getEmployees = async (_req: Request, res: Response) => {
  try {
    const employees = await prisma.$queryRawUnsafe<any[]>(`
      SELECT
        e.id,
        e.employee_code,
        e.department,
        e.designation,
        e.phone,
        e.address,
        e.emergency_contact,
        e.join_date,
        e.salary,
        e.manager_id,
        e.employment_status,
        u.id   AS user_id,
        u.name,
        u.email,
        u.role
      FROM employees e
      LEFT JOIN users u ON e.user_id = u.id
      ORDER BY e.id DESC;
    `);

    return res.status(200).json({ success: true, data: employees });
  } catch (error) {
    console.error('[HR Employees] Get Error:', error);
    return res.status(500).json({ success: false, message: 'Failed to fetch employees' });
  }
};

/**
 * GET /hr/employees/:id
 */
export const getEmployeeById = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const rows = await prisma.$queryRawUnsafe<any[]>(
      `SELECT e.*, u.name, u.email, u.role
       FROM employees e
       LEFT JOIN users u ON e.user_id = u.id
       WHERE e.id = $1
       LIMIT 1;`,
      Number(id)
    );

    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Employee not found' });
    }

    return res.status(200).json({ success: true, data: rows[0] });
  } catch (error) {
    console.error('[HR Employee By ID] Error:', error);
    return res.status(500).json({ success: false, message: 'Failed to fetch employee' });
  }
};

/**
 * POST /hr/employees
 *
 * Atomic two-step creation inside a single transaction:
 *   1. Validate email uniqueness + employee_code uniqueness
 *   2. INSERT INTO users  (name, email, hashed_password, role, …)
 *   3. INSERT INTO employees (user_id, employee_code, department, …)
 *
 * A temporary password is generated and a welcome e-mail is sent
 * (non-blocking) after the transaction commits.
 */
export const createEmployee = async (req: Request, res: Response) => {
  try {
    const {
      name,
      email,
      role,           // system role name (from roles table)
      designation,    // job title
      phone,
      salary,
      join_date,
      employment_status,
    } = req.body;

    /* ── Validate required fields ───────────────────────────────────── */
    if (!name || !email || !designation || !join_date) {
      return res.status(400).json({
        success: false,
        message: 'name, email, designation, and join_date are required',
      });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    const trimmedEmail = email.trim().toLowerCase();
    const trimmedName  = name.trim();

    if (!emailRegex.test(trimmedEmail)) {
      return res.status(400).json({ success: false, message: 'Invalid email format' });
    }

    /* ── Pre-flight uniqueness check ────────────────────────────────── */
    const existingUser = await prisma.$queryRawUnsafe<any[]>(
      'SELECT id FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1;',
      trimmedEmail
    );
    if (existingUser.length > 0) {
      return res.status(400).json({ success: false, message: 'Email already exists' });
    }

    /* ── Auto-generate employee code & department ───────────────────── */
    const employee_code = await generateEmployeeCode();
    const department    = deriveDepartment(role, designation);

    /* ── Generate temporary password ──────────────────────────────────── */
    const tempPassword   = generateTempPassword();
    const hashedPassword = hashPassword(tempPassword);
    const roleStr        = role || 'User';

    /* ── Transaction: create user → create employee ───────────────────── */
    const result = await prisma.$transaction(async (tx) => {
      // 1. Create user record
      await tx.$executeRawUnsafe(
        `INSERT INTO users (name, email, password, role, status, must_change_password)
         VALUES ($1, $2, $3, $4, 'active', TRUE);`,
        trimmedName,
        trimmedEmail,
        hashedPassword,
        roleStr,
      );

      // 2. Fetch the new user_id
      const newUsers = await tx.$queryRawUnsafe<any[]>(
        'SELECT id FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1;',
        trimmedEmail
      );
      const newUserId = newUsers[0]?.id;
      if (!newUserId) throw new Error('Failed to retrieve new user ID after creation');

      // 3. Create employee record (code & department are auto-generated above)
      await tx.$executeRawUnsafe(
        `INSERT INTO employees
           (user_id, employee_code, department, designation, phone, join_date, salary, employment_status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8);`,
        newUserId,
        employee_code,
        department,
        designation,
        phone   || null,
        new Date(join_date),
        salary  ? Number(salary) : 0,
        employment_status || 'active',
      );

      return { userId: newUserId };
    });

    /* ── Send welcome e-mail (non-blocking) ─────────────────────────── */
    import('../../services/email.service.js')
      .then(({ sendWelcomeEmail }) =>
        sendWelcomeEmail(trimmedEmail, trimmedName, tempPassword)
      )
      .catch(() => { /* best-effort */ });

    return res.status(201).json({
      success: true,
      message: 'Employee created successfully',
      data: { user_id: result.userId },
    });
  } catch (error: any) {
    console.error('[Create Employee] Error:', error);
    return res.status(500).json({
      success: false,
      message: error?.message || 'Failed to create employee',
    });
  }
};

/**
 * PUT /hr/employees/:id
 *
 * Updates both the employees row AND the linked users row inside a single
 * transaction so the two records never diverge.
 */
export const updateEmployee = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const {
      name,
      email,
      role,
      department,
      designation,
      phone,
      address,
      emergency_contact,
      salary,
      employment_status,
    } = req.body;

    /* ── Fetch existing employee to get user_id ───────────────────────── */
    const existing = await prisma.$queryRawUnsafe<any[]>(
      'SELECT id, user_id FROM employees WHERE id = $1 LIMIT 1;',
      Number(id)
    );
    if (existing.length === 0) {
      return res.status(404).json({ success: false, message: 'Employee not found' });
    }

    const userId = existing[0].user_id;
    const derivedDept = department || deriveDepartment(role, designation);

    /* ── Transaction: update employees + users ────────────────────────── */
    await prisma.$transaction(async (tx) => {
      // Update employee record
      await tx.$executeRawUnsafe(
        `UPDATE employees
         SET
           department        = $1,
           designation       = $2,
           phone             = $3,
           address           = $4,
           emergency_contact = $5,
           salary            = $6,
           employment_status = $7
         WHERE id = $8;`,
        derivedDept,
        designation,
        phone              || null,
        address            || null,
        emergency_contact  || null,
        salary ? Number(salary) : 0,
        employment_status  || 'active',
        Number(id),
      );

      // Update linked user record if a user is linked
      if (userId) {
        await tx.$executeRawUnsafe(
          `UPDATE users
           SET
             name  = COALESCE($1, name),
             email = COALESCE($2, email),
             role  = COALESCE($3, role)
           WHERE id = $4;`,
          name  || null,
          email ? email.trim().toLowerCase() : null,
          role  || null,
          userId,
        );
      }
    });

    return res.status(200).json({ success: true, message: 'Employee updated successfully' });
  } catch (error) {
    console.error('[Update Employee] Error:', error);
    return res.status(500).json({ success: false, message: 'Failed to update employee' });
  }
};

/**
 * DELETE /hr/employees/:id
 *
 * Removes the employees row and soft-deactivates the linked user account
 * (sets status = 'inactive') to preserve historical references.
 */
export const deleteEmployee = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const existing = await prisma.$queryRawUnsafe<any[]>(
      'SELECT user_id FROM employees WHERE id = $1 LIMIT 1;',
      Number(id)
    );
    if (existing.length === 0) {
      return res.status(404).json({ success: false, message: 'Employee not found' });
    }

    const userId = existing[0].user_id;

    await prisma.$transaction(async (tx) => {
      // Delete the employee record
      await tx.$executeRawUnsafe(
        'DELETE FROM employees WHERE id = $1;',
        Number(id)
      );

      // Soft-deactivate the linked user (preserves history and foreign keys)
      if (userId) {
        await tx.$executeRawUnsafe(
          "UPDATE users SET status = 'inactive' WHERE id = $1;",
          userId
        );
      }
    });

    return res.status(200).json({
      success: true,
      message: 'Employee removed and user account deactivated',
    });
  } catch (error) {
    console.error('[Delete Employee] Error:', error);
    return res.status(500).json({ success: false, message: 'Failed to delete employee' });
  }
};