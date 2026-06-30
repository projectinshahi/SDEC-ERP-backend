import { Request, Response } from 'express';
import prisma from '../../config/db.js';

/* ── HELPERS ────────────────────────────────────────────────────────────── */

/**
 * Fetch the employee record associated with the authenticated user ID.
 */
async function getEmployeeByUserId(userId: number): Promise<any | null> {
  const rows = await prisma.$queryRawUnsafe<any[]>(
    `SELECT * FROM employees WHERE user_id = $1 LIMIT 1;`,
    userId
  );
  return rows[0] || null;
}

/**
 * Recalculates final appraisal rating based on category averages and weighted goals scores.
 * Formula: 60% Category Rating Average + 40% Goals Weighted Average.
 * If no goals are set, it defaults to 100% Category Rating Average.
 */
async function recalculateAppraisalFinalRating(appraisalId: number): Promise<void> {
  const appRows = await prisma.$queryRawUnsafe<any[]>(
    `SELECT * FROM performance_appraisals WHERE id = $1 LIMIT 1;`,
    appraisalId
  );
  const appraisal = appRows[0];
  if (!appraisal || appraisal.manager_rating_tech == null) return;

  // Category average (Manager scores)
  const ratings = [
    Number(appraisal.manager_rating_tech),
    Number(appraisal.manager_rating_comm),
    Number(appraisal.manager_rating_team),
    Number(appraisal.manager_rating_prod),
    Number(appraisal.manager_rating_solve),
  ];
  if (appraisal.manager_rating_lead != null) {
    ratings.push(Number(appraisal.manager_rating_lead));
  }
  const catAvg = ratings.reduce((sum, r) => sum + r, 0) / ratings.length;

  // Goals weighted average
  const goals = await prisma.$queryRawUnsafe<any[]>(
    `SELECT * FROM performance_goals WHERE appraisal_id = $1;`,
    appraisalId
  );

  let goalsAvg = 0;
  let hasGoals = false;

  if (goals.length > 0) {
    let totalWeight = 0;
    let weightedScore = 0;
    for (const g of goals) {
      const w = Number(g.weight ?? 0);
      const s = Number(g.score ?? 0);
      weightedScore += s * w;
      totalWeight += w;
    }
    if (totalWeight > 0) {
      goalsAvg = weightedScore / totalWeight;
      hasGoals = true;
    }
  }

  const finalRating = hasGoals ? (0.6 * catAvg + 0.4 * goalsAvg) : catAvg;

  await prisma.$executeRawUnsafe(
    `UPDATE performance_appraisals SET final_rating = $1 WHERE id = $2;`,
    Number(finalRating.toFixed(2)),
    appraisalId
  );
}

/**
 * Checks if the logged-in user has HR Admin/Admin permissions.
 */
async function isHRAdmin(userId: number, roleName: string): Promise<boolean> {
  const normalized = roleName.toLowerCase().replace(/[\s_-]/g, '');
  if (normalized === 'superadmin' || normalized === 'admin' || normalized === 'hradmin') {
    return true;
  }
  // Query role permissions
  const roles = await prisma.$queryRawUnsafe<any[]>(
    'SELECT permissions FROM roles WHERE LOWER(name) = LOWER($1) LIMIT 1;',
    roleName
  );
  if (roles.length > 0 && roles[0].permissions) {
    const perms: string[] = Array.isArray(roles[0].permissions)
      ? roles[0].permissions
      : JSON.parse(roles[0].permissions);
    return perms.includes('hr.performance.approve') || perms.includes('hr.performance.create');
  }
  return false;
}

/**
 * Checks if the user is a manager (has review permissions).
 */
async function isManager(roleName: string): Promise<boolean> {
  const roles = await prisma.$queryRawUnsafe<any[]>(
    'SELECT permissions FROM roles WHERE LOWER(name) = LOWER($1) LIMIT 1;',
    roleName
  );
  if (roles.length > 0 && roles[0].permissions) {
    const perms: string[] = Array.isArray(roles[0].permissions)
      ? roles[0].permissions
      : JSON.parse(roles[0].permissions);
    return perms.includes('hr.performance.review');
  }
  return false;
}

/* ── REVIEW CYCLES ──────────────────────────────────────────────────────── */

/**
 * GET /api/hr/performance/cycles
 */
export const getCycles = async (_req: Request, res: Response) => {
  try {
    const cycles = await prisma.$queryRawUnsafe<any[]>(
      `SELECT * FROM performance_cycles ORDER BY created_at DESC;`
    );
    res.status(200).json({ success: true, data: cycles });
  } catch (error) {
    console.error('[Performance Cycles Get Error]', error);
    res.status(500).json({ success: false, message: 'Failed to fetch review cycles' });
  }
};

/**
 * POST /api/hr/performance/cycles
 */
export const createCycle = async (req: Request, res: Response) => {
  try {
    const { title, start_date, end_date, status = 'Upcoming' } = req.body;

    if (!title || !start_date || !end_date) {
      return res.status(400).json({
        success: false,
        message: 'title, start_date, and end_date are required',
      });
    }

    await prisma.$executeRawUnsafe(
      `INSERT INTO performance_cycles (title, start_date, end_date, status)
       VALUES ($1, $2::timestamp, $3::timestamp, $4);`,
      title,
      start_date,
      end_date,
      status
    );

    res.status(201).json({ success: true, message: 'Review cycle created successfully' });
  } catch (error) {
    console.error('[Performance Cycle Create Error]', error);
    res.status(500).json({ success: false, message: 'Failed to create review cycle' });
  }
};

/* ── APPRAISALS ─────────────────────────────────────────────────────────── */

/**
 * GET /api/hr/performance
 */
export const getAppraisals = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    const roleName = (req as any).userRole;

    const isAdmin = await isHRAdmin(userId, roleName);
    const isMgr = await isManager(roleName);
    const employee = await getEmployeeByUserId(userId);

    let query = `
      SELECT
        pa.*,
        pc.title as cycle_title,
        pc.status as cycle_status,
        e.employee_code,
        u.name as employee_name,
        e.department,
        e.designation,
        mgr.employee_code as manager_code,
        mgru.name as manager_name
      FROM performance_appraisals pa
      JOIN performance_cycles pc ON pa.cycle_id = pc.id
      JOIN employees e ON pa.employee_id = e.id
      LEFT JOIN users u ON e.user_id = u.id
      LEFT JOIN employees mgr ON pa.evaluator_id = mgr.id
      LEFT JOIN users mgru ON mgr.user_id = mgru.id
    `;

    let appraisals: any[] = [];

    if (isAdmin) {
      query += ` ORDER BY pa.created_at DESC;`;
      appraisals = await prisma.$queryRawUnsafe<any[]>(query);
    } else if (isMgr) {
      if (!employee) {
        return res.status(200).json({ success: true, data: [] });
      }
      query += ` WHERE pa.employee_id = $1 OR pa.evaluator_id = $1 ORDER BY pa.created_at DESC;`;
      appraisals = await prisma.$queryRawUnsafe<any[]>(query, employee.id);
    } else {
      if (!employee) {
        return res.status(200).json({ success: true, data: [] });
      }
      query += ` WHERE pa.employee_id = $1 ORDER BY pa.created_at DESC;`;
      appraisals = await prisma.$queryRawUnsafe<any[]>(query, employee.id);
    }

    res.status(200).json({ success: true, data: appraisals });
  } catch (error) {
    console.error('[Performance Appraisals Get Error]', error);
    res.status(500).json({ success: false, message: 'Failed to fetch appraisals' });
  }
};

/**
 * POST /api/hr/performance
 */
export const createAppraisal = async (req: Request, res: Response) => {
  try {
    const { employee_id, cycle_id, evaluator_id } = req.body;

    if (!employee_id || !cycle_id) {
      return res.status(400).json({
        success: false,
        message: 'employee_id and cycle_id are required',
      });
    }

    // Resolve manager automatically if not provided
    let finalEvaluatorId = evaluator_id;
    if (!finalEvaluatorId) {
      const empRows = await prisma.$queryRawUnsafe<any[]>(
        `SELECT manager_id FROM employees WHERE id = $1 LIMIT 1;`,
        Number(employee_id)
      );
      finalEvaluatorId = empRows[0]?.manager_id || null;
    }

    // Check for duplicate
    const duplicate = await prisma.$queryRawUnsafe<any[]>(
      `SELECT id FROM performance_appraisals WHERE employee_id = $1 AND cycle_id = $2 LIMIT 1;`,
      Number(employee_id),
      Number(cycle_id)
    );

    if (duplicate.length > 0) {
      return res.status(400).json({
        success: false,
        message: 'An appraisal assignment for this employee in this cycle already exists.',
      });
    }

    await prisma.$executeRawUnsafe(
      `INSERT INTO performance_appraisals (employee_id, evaluator_id, cycle_id, status)
       VALUES ($1, $2, $3, 'Pending Self Review');`,
      Number(employee_id),
      finalEvaluatorId ? Number(finalEvaluatorId) : null,
      Number(cycle_id)
    );

    res.status(201).json({ success: true, message: 'Appraisal assigned successfully' });
  } catch (error) {
    console.error('[Performance Appraisal Create Error]', error);
    res.status(500).json({ success: false, message: 'Failed to assign appraisal' });
  }
};

/**
 * GET /api/hr/performance/:id
 */
export const getAppraisalById = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const userId = (req as any).userId;
    const roleName = (req as any).userRole;

    const appraisals = await prisma.$queryRawUnsafe<any[]>(
      `SELECT
        pa.*,
        pc.title as cycle_title,
        e.employee_code,
        u.name as employee_name,
        e.department,
        e.designation,
        mgr.employee_code as manager_code,
        mgru.name as manager_name
      FROM performance_appraisals pa
      JOIN performance_cycles pc ON pa.cycle_id = pc.id
      JOIN employees e ON pa.employee_id = e.id
      LEFT JOIN users u ON e.user_id = u.id
      LEFT JOIN employees mgr ON pa.evaluator_id = mgr.id
      LEFT JOIN users mgru ON mgr.user_id = mgru.id
      WHERE pa.id = $1 LIMIT 1;`,
      Number(id)
    );

    if (appraisals.length === 0) {
      return res.status(404).json({ success: false, message: 'Appraisal not found' });
    }

    const appraisal = appraisals[0];

    // Enforce scoping
    const isAdmin = await isHRAdmin(userId, roleName);
    const employee = await getEmployeeByUserId(userId);

    if (!isAdmin) {
      if (!employee) {
        return res.status(403).json({ success: false, message: 'Forbidden: access denied' });
      }
      const isSelf = appraisal.employee_id === employee.id;
      const isReviewer = appraisal.evaluator_id === employee.id;
      if (!isSelf && !isReviewer) {
        return res.status(403).json({ success: false, message: 'Forbidden: access denied' });
      }
    }

    // Fetch related goals
    const goals = await prisma.$queryRawUnsafe<any[]>(
      `SELECT * FROM performance_goals WHERE appraisal_id = $1 ORDER BY created_at DESC;`,
      Number(id)
    );

    res.status(200).json({ success: true, data: { ...appraisal, goals } });
  } catch (error) {
    console.error('[Performance Appraisal Single Get Error]', error);
    res.status(500).json({ success: false, message: 'Failed to fetch appraisal details' });
  }
};

/**
 * PUT /api/hr/performance/:id
 */
export const updateAppraisal = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { evaluator_id, cycle_id } = req.body;

    if (!evaluator_id || !cycle_id) {
      return res.status(400).json({
        success: false,
        message: 'evaluator_id and cycle_id are required',
      });
    }

    await prisma.$executeRawUnsafe(
      `UPDATE performance_appraisals
       SET evaluator_id = $1, cycle_id = $2, updated_at = NOW()
       WHERE id = $3;`,
      Number(evaluator_id),
      Number(cycle_id),
      Number(id)
    );

    res.status(200).json({ success: true, message: 'Appraisal updated successfully' });
  } catch (error) {
    console.error('[Performance Appraisal Update Error]', error);
    res.status(500).json({ success: false, message: 'Failed to update appraisal' });
  }
};

/**
 * PATCH /api/hr/performance/:id/status
 */
export const updateAppraisalStatus = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { status, final_comments } = req.body;

    if (!status) {
      return res.status(400).json({ success: false, message: 'status is required' });
    }

    await prisma.$executeRawUnsafe(
      `UPDATE performance_appraisals
       SET status = $1, final_comments = COALESCE($2, final_comments), updated_at = NOW()
       WHERE id = $3;`,
      status,
      final_comments || null,
      Number(id)
    );

    res.status(200).json({ success: true, message: 'Appraisal status updated successfully' });
  } catch (error) {
    console.error('[Performance Appraisal Status Update Error]', error);
    res.status(500).json({ success: false, message: 'Failed to update appraisal status' });
  }
};

/**
 * DELETE /api/hr/performance/:id
 */
export const deleteAppraisal = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    await prisma.$executeRawUnsafe(
      `DELETE FROM performance_appraisals WHERE id = $1;`,
      Number(id)
    );

    res.status(200).json({ success: true, message: 'Appraisal deleted successfully' });
  } catch (error) {
    console.error('[Performance Appraisal Delete Error]', error);
    res.status(500).json({ success: false, message: 'Failed to delete appraisal' });
  }
};

/* ── REVIEWS (SELF & MANAGER) ───────────────────────────────────────────── */

/**
 * PATCH /api/hr/performance/:id/self-review
 */
export const submitSelfReview = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const userId = (req as any).userId;
    const {
      self_rating_tech,
      self_rating_comm,
      self_rating_team,
      self_rating_prod,
      self_rating_solve,
      self_rating_lead,
      self_comments,
      is_draft = false,
    } = req.body;

    const appraisals = await prisma.$queryRawUnsafe<any[]>(
      `SELECT employee_id FROM performance_appraisals WHERE id = $1 LIMIT 1;`,
      Number(id)
    );

    if (appraisals.length === 0) {
      return res.status(404).json({ success: false, message: 'Appraisal not found' });
    }

    const employee = await getEmployeeByUserId(userId);
    if (!employee || appraisals[0].employee_id !== employee.id) {
      return res.status(403).json({
        success: false,
        message: 'Forbidden: You can only submit self review for your own appraisal.',
      });
    }

    const status = is_draft ? 'self_review' : 'manager_review';

    await prisma.$executeRawUnsafe(
      `UPDATE performance_appraisals
       SET
         self_rating_tech = $1,
         self_rating_comm = $2,
         self_rating_team = $3,
         self_rating_prod = $4,
         self_rating_solve = $5,
         self_rating_lead = $6,
         self_comments = $7,
         status = $8,
         updated_at = NOW()
       WHERE id = $9;`,
      self_rating_tech != null ? Number(self_rating_tech) : null,
      self_rating_comm != null ? Number(self_rating_comm) : null,
      self_rating_team != null ? Number(self_rating_team) : null,
      self_rating_prod != null ? Number(self_rating_prod) : null,
      self_rating_solve != null ? Number(self_rating_solve) : null,
      self_rating_lead != null ? Number(self_rating_lead) : null,
      self_comments || null,
      status,
      Number(id)
    );

    res.status(200).json({
      success: true,
      message: is_draft ? 'Self review draft saved' : 'Self review submitted successfully',
    });
  } catch (error) {
    console.error('[Performance Self Review Error]', error);
    res.status(500).json({ success: false, message: 'Failed to submit self review' });
  }
};

/**
 * PATCH /api/hr/performance/:id/manager-review
 */
export const submitManagerReview = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const userId = (req as any).userId;
    const roleName = (req as any).userRole;
    const {
      manager_rating_tech,
      manager_rating_comm,
      manager_rating_team,
      manager_rating_prod,
      manager_rating_solve,
      manager_rating_lead,
      manager_comments,
      strengths,
      improvement_areas,
      promotion_recommendation,
      is_draft = false,
    } = req.body;

    const appraisals = await prisma.$queryRawUnsafe<any[]>(
      `SELECT evaluator_id FROM performance_appraisals WHERE id = $1 LIMIT 1;`,
      Number(id)
    );

    if (appraisals.length === 0) {
      return res.status(404).json({ success: false, message: 'Appraisal not found' });
    }

    const isAdmin = await isHRAdmin(userId, roleName);
    const employee = await getEmployeeByUserId(userId);

    if (!isAdmin) {
      if (!employee || appraisals[0].evaluator_id !== employee.id) {
        return res.status(403).json({
          success: false,
          message: 'Forbidden: You are not the assigned evaluator for this appraisal.',
        });
      }
    }

    const status = is_draft ? 'manager_review' : 'completed';

    const managerScoresObj = {
      tech: manager_rating_tech != null ? Number(manager_rating_tech) : null,
      comm: manager_rating_comm != null ? Number(manager_rating_comm) : null,
      team: manager_rating_team != null ? Number(manager_rating_team) : null,
      prod: manager_rating_prod != null ? Number(manager_rating_prod) : null,
      solve: manager_rating_solve != null ? Number(manager_rating_solve) : null,
      lead: manager_rating_lead != null ? Number(manager_rating_lead) : null,
      strengths: strengths || null,
      improvement_areas: improvement_areas || null,
      promotion_recommendation: promotion_recommendation || null,
    };

    // Save reviewer ratings
    await prisma.$executeRawUnsafe(
      `UPDATE performance_appraisals
       SET
         manager_rating_tech = $1,
         manager_rating_comm = $2,
         manager_rating_team = $3,
         manager_rating_prod = $4,
         manager_rating_solve = $5,
         manager_rating_lead = $6,
         manager_comments = $7,
         manager_scores = $8::jsonb,
         status = $9,
         updated_at = NOW()
       WHERE id = $10;`,
      manager_rating_tech != null ? Number(manager_rating_tech) : null,
      manager_rating_comm != null ? Number(manager_rating_comm) : null,
      manager_rating_team != null ? Number(manager_rating_team) : null,
      manager_rating_prod != null ? Number(manager_rating_prod) : null,
      manager_rating_solve != null ? Number(manager_rating_solve) : null,
      manager_rating_lead != null ? Number(manager_rating_lead) : null,
      manager_comments || null,
      JSON.stringify(managerScoresObj),
      status,
      Number(id)
    );

    if (!is_draft) {
      // Auto calculate and save final/overall ratings
      const scoresList = [
        Number(manager_rating_tech),
        Number(manager_rating_comm),
        Number(manager_rating_team),
        Number(manager_rating_prod),
        Number(manager_rating_solve)
      ];
      if (manager_rating_lead != null) {
        scoresList.push(Number(manager_rating_lead));
      }
      const avgScore = Number((scoresList.reduce((sum, r) => sum + r, 0) / scoresList.length).toFixed(2));

      await prisma.$executeRawUnsafe(
        `UPDATE performance_appraisals
         SET overall_rating = $1, final_rating = $1
         WHERE id = $2;`,
        avgScore,
        Number(id)
      );
    }

    res.status(200).json({
      success: true,
      message: is_draft ? 'Manager review draft saved' : 'Manager review submitted successfully',
    });
  } catch (error) {
    console.error('[Performance Manager Review Error]', error);
    res.status(500).json({ success: false, message: 'Failed to submit manager review' });
  }
};

/**
 * PATCH /api/hr/performance/:id/approve
 */
export const approveAppraisal = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { final_comments } = req.body;

    const appraisals = await prisma.$queryRawUnsafe<any[]>(
      `SELECT status FROM performance_appraisals WHERE id = $1 LIMIT 1;`,
      Number(id)
    );

    if (appraisals.length === 0) {
      return res.status(404).json({ success: false, message: 'Appraisal not found' });
    }

    await prisma.$executeRawUnsafe(
      `UPDATE performance_appraisals
       SET approved_at = NOW(), final_comments = $1, updated_at = NOW()
       WHERE id = $2;`,
      final_comments || null,
      Number(id)
    );

    res.status(200).json({ success: true, message: 'Appraisal approved successfully' });
  } catch (error) {
    console.error('[Performance Appraisal Approve Error]', error);
    res.status(500).json({ success: false, message: 'Failed to approve appraisal' });
  }
};

/**
 * PATCH /api/hr/performance/:id/reject
 */
export const rejectAppraisal = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const userId = (req as any).userId;
    const roleName = (req as any).userRole;
    const { comments } = req.body;

    const appraisals = await prisma.$queryRawUnsafe<any[]>(
      `SELECT status, evaluator_id FROM performance_appraisals WHERE id = $1 LIMIT 1;`,
      Number(id)
    );

    if (appraisals.length === 0) {
      return res.status(404).json({ success: false, message: 'Appraisal not found' });
    }

    const isAdmin = await isHRAdmin(userId, roleName);
    const employee = await getEmployeeByUserId(userId);

    if (!isAdmin) {
      if (!employee || appraisals[0].evaluator_id !== employee.id) {
        return res.status(403).json({
          success: false,
          message: 'Forbidden: You are not authorized to reject this review.',
        });
      }
    }

    await prisma.$executeRawUnsafe(
      `UPDATE performance_appraisals
       SET status = 'rejected', final_comments = $1, overall_rating = NULL, final_rating = NULL, updated_at = NOW()
       WHERE id = $2;`,
      comments || null,
      Number(id)
    );

    res.status(200).json({ success: true, message: 'Appraisal review rejected and returned' });
  } catch (error) {
    console.error('[Performance Appraisal Reject Error]', error);
    res.status(500).json({ success: false, message: 'Failed to reject appraisal' });
  }
};

/* ── STATS ──────────────────────────────────────────────────────────────── */

/**
 * GET /api/hr/performance/stats
 */
export const getPerformanceStats = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    const roleName = (req as any).userRole;

    const isAdmin = await isHRAdmin(userId, roleName);
    const isMgr = await isManager(roleName);
    const employee = await getEmployeeByUserId(userId);

    let query = `
      SELECT
        COUNT(CASE WHEN status IN ('draft', 'self_review', 'manager_review') THEN 1 END) as active,
        COUNT(CASE WHEN status IN ('draft', 'self_review') THEN 1 END) as self_pending,
        COUNT(CASE WHEN status = 'manager_review' THEN 1 END) as manager_pending,
        COUNT(CASE WHEN status = 'completed' THEN 1 END) as completed
      FROM performance_appraisals
    `;

    let statsRows: any[] = [];

    if (isAdmin) {
      statsRows = await prisma.$queryRawUnsafe<any[]>(query);
    } else if (isMgr) {
      if (!employee) {
        return res.status(200).json({
          success: true,
          data: { active: 0, self_pending: 0, manager_pending: 0, completed: 0 },
        });
      }
      query += ` WHERE employee_id = $1 OR evaluator_id = $1;`;
      statsRows = await prisma.$queryRawUnsafe<any[]>(query, employee.id);
    } else {
      if (!employee) {
        return res.status(200).json({
          success: true,
          data: { active: 0, self_pending: 0, manager_pending: 0, completed: 0 },
        });
      }
      query += ` WHERE employee_id = $1;`;
      statsRows = await prisma.$queryRawUnsafe<any[]>(query, employee.id);
    }

    const stats = statsRows[0] || { active: 0, self_pending: 0, manager_pending: 0, completed: 0 };

    res.status(200).json({
      success: true,
      data: {
        active: Number(stats.active ?? 0),
        self_pending: Number(stats.self_pending ?? 0),
        manager_pending: Number(stats.manager_pending ?? 0),
        completed: Number(stats.completed ?? 0),
      },
    });
  } catch (error) {
    console.error('[Performance Stats Get Error]', error);
    res.status(500).json({ success: false, message: 'Failed to fetch performance stats' });
  }
};

/* ── GOALS ──────────────────────────────────────────────────────────────── */

/**
 * GET /api/hr/performance/goals
 */
export const getGoals = async (req: Request, res: Response) => {
  try {
    const { employee_id, appraisal_id } = req.query;
    const userId = (req as any).userId;
    const roleName = (req as any).userRole;

    const isAdmin = await isHRAdmin(userId, roleName);
    const employee = await getEmployeeByUserId(userId);

    let query = `
      SELECT pg.*, e.employee_code, u.name as employee_name
      FROM performance_goals pg
      JOIN employees e ON pg.employee_id = e.id
      LEFT JOIN users u ON e.user_id = u.id
      WHERE 1=1
    `;

    const params: any[] = [];
    let paramCounter = 1;

    if (employee_id) {
      query += ` AND pg.employee_id = $${paramCounter++}`;
      params.push(Number(employee_id));
    }
    if (appraisal_id) {
      query += ` AND pg.appraisal_id = $${paramCounter++}`;
      params.push(Number(appraisal_id));
    }

    // Strict security checks
    if (!isAdmin) {
      if (!employee) {
        return res.status(200).json({ success: true, data: [] });
      }
      // If employee_id is filter, ensure it is their own
      if (employee_id && Number(employee_id) !== employee.id) {
        return res.status(403).json({ success: false, message: 'Forbidden: access denied' });
      }
      // If no employee_id filter, force scoping to manager or own
      if (!employee_id) {
        query += ` AND (pg.employee_id = $${paramCounter++} OR pg.appraisal_id IN (
          SELECT id FROM performance_appraisals WHERE evaluator_id = $${paramCounter - 1}
        ))`;
        params.push(employee.id);
      }
    }

    query += ` ORDER BY pg.created_at DESC;`;

    const goals = await prisma.$queryRawUnsafe<any[]>(query, ...params);
    res.status(200).json({ success: true, data: goals });
  } catch (error) {
    console.error('[Performance Goals Get Error]', error);
    res.status(500).json({ success: false, message: 'Failed to fetch goals' });
  }
};

/**
 * POST /api/hr/performance/goals
 */
export const createGoal = async (req: Request, res: Response) => {
  try {
    const { employee_id, appraisal_id, title, description, weight = 0, progress_pct = 0, score = 0, target_date } = req.body;

    if (!employee_id || !title) {
      return res.status(400).json({
        success: false,
        message: 'employee_id and title are required',
      });
    }

    const result = await prisma.$queryRawUnsafe<any[]>(
      `INSERT INTO performance_goals (employee_id, appraisal_id, title, description, weight, progress_pct, score, target_date)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::timestamp)
       RETURNING id;`,
      Number(employee_id),
      appraisal_id ? Number(appraisal_id) : null,
      title,
      description || null,
      Number(weight),
      Number(progress_pct),
      Number(score),
      target_date || null
    );

    const newGoalId = result[0]?.id;

    if (appraisal_id && newGoalId) {
      await recalculateAppraisalFinalRating(Number(appraisal_id));
    }

    res.status(201).json({ success: true, message: 'Goal created successfully', data: { id: newGoalId } });
  } catch (error) {
    console.error('[Performance Goal Create Error]', error);
    res.status(500).json({ success: false, message: 'Failed to create goal' });
  }
};

/**
 * PUT /api/hr/performance/goals/:id
 */
export const updateGoal = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { title, description, weight, progress_pct, score, target_date } = req.body;

    if (!title) {
      return res.status(400).json({ success: false, message: 'title is required' });
    }

    // Get current goal appraisal link
    const goals = await prisma.$queryRawUnsafe<any[]>(
      `SELECT appraisal_id FROM performance_goals WHERE id = $1 LIMIT 1;`,
      Number(id)
    );

    if (goals.length === 0) {
      return res.status(404).json({ success: false, message: 'Goal not found' });
    }

    const appraisalId = goals[0].appraisal_id;

    await prisma.$executeRawUnsafe(
      `UPDATE performance_goals
       SET
         title = $1,
         description = $2,
         weight = $3,
         progress_pct = $4,
         score = $5,
         target_date = $6::timestamp,
         updated_at = NOW()
       WHERE id = $7;`,
      title,
      description || null,
      weight != null ? Number(weight) : 0,
      progress_pct != null ? Number(progress_pct) : 0,
      score != null ? Number(score) : 0,
      target_date || null,
      Number(id)
    );

    if (appraisalId) {
      await recalculateAppraisalFinalRating(appraisalId);
    }

    res.status(200).json({ success: true, message: 'Goal updated successfully' });
  } catch (error) {
    console.error('[Performance Goal Update Error]', error);
    res.status(500).json({ success: false, message: 'Failed to update goal' });
  }
};

/**
 * DELETE /api/hr/performance/goals/:id
 */
export const deleteGoal = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    // Get current goal appraisal link
    const goals = await prisma.$queryRawUnsafe<any[]>(
      `SELECT appraisal_id FROM performance_goals WHERE id = $1 LIMIT 1;`,
      Number(id)
    );

    if (goals.length === 0) {
      return res.status(404).json({ success: false, message: 'Goal not found' });
    }

    const appraisalId = goals[0].appraisal_id;

    await prisma.$executeRawUnsafe(
      `DELETE FROM performance_goals WHERE id = $1;`,
      Number(id)
    );

    if (appraisalId) {
      await recalculateAppraisalFinalRating(appraisalId);
    }

    res.status(200).json({ success: true, message: 'Goal deleted successfully' });
  } catch (error) {
    console.error('[Performance Goal Delete Error]', error);
    res.status(500).json({ success: false, message: 'Failed to delete goal' });
  }
};
