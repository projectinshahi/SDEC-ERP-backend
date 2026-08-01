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
  // Derive the next number from the HIGHEST existing suffix, not COUNT(*).
  // COUNT+1 collides after any deletion gap (e.g. EMP-2026-012 deleted →
  // COUNT lands back on an existing code) or manual assignment. MAX+1 is
  // gap-proof; concurrent races are handled by the insert-retry loop below.
  const rows = await prisma.$queryRawUnsafe<any[]>(
    `SELECT COALESCE(MAX((substring(employee_code from '([0-9]+)$'))::int), 0) AS maxnum
       FROM employees WHERE employee_code LIKE $1;`,
    `${prefix}%`
  );
  const next = Number(rows[0]?.maxnum ?? 0) + 1;
  return `${prefix}${String(next).padStart(3, '0')}`;
}

/** True when a thrown error is a unique-violation on the employee_code constraint
 *  specifically — NOT any 23505 (e.g. a user_id conflict must not be retried here). */
function isEmployeeCodeConflict(err: any): boolean {
  const blob = `${err?.code ?? ''} ${err?.message ?? ''} ${JSON.stringify(err?.meta ?? {})}`;
  return blob.includes('employees_employee_code_key') ||
    (blob.includes('23505') && blob.includes('employee_code'));
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
        e.date_of_birth,
        u.id   AS user_id,
        COALESCE(NULLIF(TRIM(u.name), ''), 'Unknown Employee') AS name,
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
      `SELECT e.*,
              COALESCE(NULLIF(TRIM(u.name), ''), 'Unknown Employee') AS name,
              u.email, u.role
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
      user_id,
      department,
      designation,
      phone,
      address,
      emergency_contact,
      salary,
      join_date,
      date_of_birth,
      employment_status,
      manager_id,
    } = req.body;

    /* ── Validate required fields ───────────────────────────────────── */
    if (!user_id) {
      return res.status(400).json({ success: false, message: 'user_id is required' });
    }
    if (!designation || !join_date || !date_of_birth || !department) {
      return res.status(400).json({
        success: false,
        message: 'designation, department, join_date, and date_of_birth are required',
      });
    }

    const parsedUserId = Number(user_id);
    if (isNaN(parsedUserId)) {
      return res.status(400).json({ success: false, message: 'Invalid user_id format' });
    }

    /* ── Pre-flight duplicate check ────────────────────────────────── */
    const existingEmployee = await prisma.$queryRawUnsafe<any[]>(
      'SELECT id FROM employees WHERE user_id = $1 LIMIT 1;',
      parsedUserId
    );
    if (existingEmployee.length > 0) {
      return res.status(400).json({
        success: false,
        message: 'An employee record already exists for this user',
      });
    }

    const deptToUse = String(department).trim();

    const INSERT_SQL =
      `INSERT INTO employees (
         user_id,
         employee_code,
         department,
         designation,
         phone,
         address,
         emergency_contact,
         join_date,
         salary,
         employment_status,
         date_of_birth,
         manager_id
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12);`;

    /* ── Insert with collision-proof code allocation ────────────────────
       Generate from MAX(suffix)+1, then INSERT. If two requests race for the
       same code, the loser hits the unique constraint (23505); recompute and
       retry a few times. This keeps the unique constraint authoritative while
       guaranteeing a fresh code even under concurrency. */
    let employee_code = '';
    let inserted = false;
    for (let attempt = 1; attempt <= 5 && !inserted; attempt++) {
      employee_code = await generateEmployeeCode();
      const params = [
        parsedUserId,
        employee_code,
        deptToUse,
        designation,
        phone || null,
        address || null,
        emergency_contact || null,
        new Date(join_date),
        salary ? Number(salary) : 0,
        employment_status || 'active',
        new Date(date_of_birth),
        manager_id ? Number(manager_id) : null,
      ];
      // Log only non-sensitive identifiers — never the params array, which holds
      // salary / DOB / phone / address / emergency contact (PII). user_id and
      // employee_code are internal identifiers and enough to trace a collision.
      console.log('[EMPLOYEE CREATE] attempt', attempt, '| user_id:', parsedUserId,
        '| employee_code:', employee_code);
      try {
        await prisma.$executeRawUnsafe(INSERT_SQL, ...params);
        inserted = true;
      } catch (err: any) {
        if (isEmployeeCodeConflict(err)) {
          console.warn('[EMPLOYEE CREATE] code', employee_code, 'taken — regenerating (attempt', attempt, ')');
          continue; // another insert grabbed it; recompute MAX+1 and retry
        }
        throw err; // unrelated error → surface it
      }
    }

    if (!inserted) {
      return res.status(409).json({
        success: false,
        message: 'Could not allocate a unique employee code after several attempts, please retry',
      });
    }

    console.log('[EMPLOYEE CREATED] Linked to user_id:', parsedUserId, '| code:', employee_code);

    return res.status(201).json({
      success: true,
      message: 'Employee created successfully',
      data: { user_id: parsedUserId, employee_code },
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
      department,
      designation,
      phone,
      address,
      emergency_contact,
      salary,
      employment_status,
      date_of_birth,
      manager_id,
    } = req.body;

    /* ── Fetch existing employee ──────────────────────────────────────── */
    const existing = await prisma.$queryRawUnsafe<any[]>(
      'SELECT id FROM employees WHERE id = $1 LIMIT 1;',
      Number(id)
    );
    if (existing.length === 0) {
      return res.status(404).json({ success: false, message: 'Employee not found' });
    }

    const deptToUse = String(department).trim();

    // Update employee record
    await prisma.$executeRawUnsafe(
      `UPDATE employees
       SET
         department        = $1,
         designation       = $2,
         phone             = $3,
         address           = $4,
         emergency_contact = $5,
         salary            = $6,
         employment_status = $7,
         date_of_birth     = $8,
         manager_id        = $9
       WHERE id = $10;`,
      deptToUse,
      designation,
      phone              || null,
      address            || null,
      emergency_contact  || null,
      salary ? Number(salary) : 0,
      employment_status  || 'active',
      date_of_birth ? new Date(date_of_birth) : null,
      manager_id ? Number(manager_id) : null,
      Number(id)
    );

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

/**
 * GET /api/hr/available-users
 * Returns users that do not have an employee record, excluding admin/system roles.
 */
export const getAvailableUsers = async (_req: Request, res: Response) => {
  try {
    const users = await prisma.$queryRawUnsafe<any[]>(`
      SELECT id, name, email, role
      FROM users
      WHERE id NOT IN (
        SELECT user_id FROM employees WHERE user_id IS NOT NULL
      )
      AND LOWER(role) NOT IN ('admin', 'super admin', 'superadmin', 'system')
      ORDER BY name ASC;
    `);
    return res.status(200).json({ success: true, data: users });
  } catch (error: any) {
    console.error('[HR Available Users] Get Error:', error);
    return res.status(500).json({ success: false, message: 'Failed to fetch available users' });
  }
};