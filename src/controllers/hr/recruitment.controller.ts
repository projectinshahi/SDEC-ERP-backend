import { Request, Response } from 'express';
import prisma from '../../config/db.js';

const VALID_STAGES = [
  'Applied',
  'Screening',
  'Interview',
  'Offer',
  'Hired',
  'Rejected',
];

/**
 * GET /api/hr/recruitment
 */
export const getCandidates = async (_req: Request, res: Response) => {
  try {
    const candidates = await prisma.$queryRawUnsafe<any[]>(`
      SELECT *
      FROM candidates
      ORDER BY created_at DESC;
    `);

    res.status(200).json({
      success: true,
      data: candidates,
    });
  } catch (error) {
    console.error('[Recruitment Fetch]', error);

    res.status(500).json({
      success: false,
      message: 'Failed to fetch candidates',
    });
  }
};

/**
 * POST /api/hr/recruitment
 */
export const createCandidate = async (req: Request, res: Response) => {
  try {
    const {
      full_name,
      email,
      phone,
      position,
      experience,
      expected_ctc,
      resume_url,
      interview_date,
      notes,
    } = req.body;

    if (!full_name || !position) {
      return res.status(400).json({
        success: false,
        message: 'full_name and position required',
      });
    }

    if (expected_ctc && isNaN(Number(expected_ctc))) {
      return res.status(400).json({
        success: false,
        message: 'Invalid expected_ctc value',
      });
    }

    if (email) {
      const existing = await prisma.$queryRawUnsafe<any[]>(
        `SELECT id FROM candidates WHERE LOWER(email)=LOWER($1) LIMIT 1`,
        email
      );

      if (existing.length) {
        return res.status(400).json({
          success: false,
          message: 'Candidate email already exists',
        });
      }
    }

    await prisma.$executeRawUnsafe(
      `
      INSERT INTO candidates (
        full_name,
        email,
        phone,
        position,
        stage,
        experience,
        expected_ctc,
        resume_url,
        interview_date,
        notes
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      `,
      full_name,
      email || null,
      phone || null,
      position,
      'Applied',
      experience || null,
      expected_ctc ? Number(expected_ctc) : null,
      resume_url || null,
      interview_date ? new Date(interview_date) : null,
      notes || null
    );

    res.status(201).json({
      success: true,
      message: 'Candidate created',
    });
  } catch (error) {
    console.error('[Recruitment Create]', error);

    res.status(500).json({
      success: false,
      message: 'Failed to create candidate',
    });
  }
};

/**
 * GET /api/hr/recruitment/:id
 */
export const getCandidateById = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const candidates = await prisma.$queryRawUnsafe<any[]>(
      `
      SELECT *
      FROM candidates
      WHERE id=$1
      LIMIT 1;
      `,
      Number(id)
    );

    if (!candidates.length) {
      return res.status(404).json({
        success: false,
        message: 'Candidate not found',
      });
    }

    res.status(200).json({
      success: true,
      data: candidates[0],
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      success: false,
      message: 'Failed to fetch candidate',
    });
  }
};

/**
 * PUT /api/hr/recruitment/:id
 */
export const updateCandidate = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const {
      full_name,
      email,
      phone,
      position,
      experience,
      expected_ctc,
      resume_url,
      interview_date,
      notes,
    } = req.body;


    const existing = await prisma.$queryRawUnsafe<any[]>(
  `SELECT id FROM candidates WHERE id=$1 LIMIT 1`,
  Number(id)
);

if (!existing.length) {
  return res.status(404).json({
    success: false,
    message: 'Candidate not found',
  });
}
    await prisma.$executeRawUnsafe(
   
      `
      UPDATE candidates
      SET
        full_name=$1,
        email=$2,
        phone=$3,
        position=$4,
        experience=$5,
        expected_ctc=$6,
        resume_url=$7,
        interview_date=$8,
        notes=$9
      WHERE id=$10
      `,
      full_name,
      email,
      phone,
      position,
      experience,
      expected_ctc,
      resume_url,
      interview_date ? new Date(interview_date) : null,
      notes,
      Number(id)
    );

    res.status(200).json({
      success: true,
      message: 'Candidate updated',
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      success: false,
      message: 'Failed to update candidate',
    });
  }
};

/**
 * PATCH /api/hr/recruitment/:id/stage
 */
export const updateCandidateStage = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { stage } = req.body;

    if (!VALID_STAGES.includes(stage)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid stage',
      });
    }

    const existing = await prisma.$queryRawUnsafe<any[]>(
      `SELECT id FROM candidates WHERE id=$1 LIMIT 1`,
      Number(id)
    );

    if (!existing.length) {
      return res.status(404).json({
        success: false,
        message: 'Candidate not found',
      });
    }

    await prisma.$executeRawUnsafe(
      `
      UPDATE candidates
      SET stage=$1
      WHERE id=$2
      `,
      stage,
      Number(id)
    );

    res.status(200).json({
      success: true,
      message: 'Candidate stage updated',
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      success: false,
      message: 'Stage update failed',
    });
  }
};

/**
 * DELETE /api/hr/recruitment/:id
 */
export const deleteCandidate = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const existing = await prisma.$queryRawUnsafe<any[]>(
      `SELECT id FROM candidates WHERE id=$1 LIMIT 1`,
      Number(id)
    );

    if (!existing.length) {
      return res.status(404).json({
        success: false,
        message: 'Candidate not found',
      });
    }

    await prisma.$executeRawUnsafe(
      `
      DELETE FROM candidates
      WHERE id=$1
      `,
      Number(id)
    );

    res.status(200).json({
      success: true,
      message: 'Candidate deleted',
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      success: false,
      message: 'Delete failed',
    });
  }
};
/**
 * GET /api/hr/recruitment/stats
 */
export const getRecruitmentStats = async (_req: Request, res: Response) => {
  try {
    const rows = await prisma.$queryRawUnsafe<any[]>(`
      SELECT stage, COUNT(*) as count
      FROM candidates
      GROUP BY stage;
    `);

    const stats = {
      Applied: 0,
      Screening: 0,
      Interview: 0,
      Offer: 0,
      Hired: 0,
      Rejected: 0,
    };

    rows.forEach((row) => {
      stats[row.stage as keyof typeof stats] = Number(row.count);
    });

    res.status(200).json({
      success: true,
      data: stats,
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      success: false,
      message: 'Stats fetch failed',
    });
  }
};