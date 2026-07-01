import { Request, Response } from 'express';
import prisma from '../../config/db.js';
import multer from 'multer';
import { v2 as cloudinary } from 'cloudinary';
import path from 'path';

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const storage = multer.memoryStorage();
export const documentUploadMiddleware = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
});

// Strict list of allowed types
const VALID_TYPES = [
  'Identity Proof',
  'Address Proof',
  'Employment Contract',
  'Degree Certificate',
  'Tax Form',
  'Other',
];

/**
 * GET /api/hr/documents
 * Fetch all documents with joined employee code, user name, and designation.
 */
export const getDocuments = async (_req: Request, res: Response) => {
  try {
    const docs = await prisma.$queryRawUnsafe<any[]>(`
      SELECT
        d.*,
        e.employee_code,
        u.name as employee_name,
        e.designation,
        vu.name as verified_by_name
      FROM documents d
      JOIN employees e ON d.employee_id = e.id
      LEFT JOIN users u ON e.user_id = u.id
      LEFT JOIN users vu ON d.verified_by = vu.id
      ORDER BY d.created_at DESC;
    `);

    res.status(200).json({
      success: true,
      data: docs,
    });
  } catch (error) {
    console.error('[Documents Fetch Error]', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch document records',
    });
  }
};

/**
 * GET /api/hr/documents/:id
 */
export const getDocumentById = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const doc = await prisma.$queryRawUnsafe<any[]>(
      `SELECT * FROM documents WHERE id = $1 LIMIT 1`,
      Number(id)
    );

    if (!doc.length) {
      return res.status(404).json({
        success: false,
        message: 'Document record not found',
      });
    }

    res.status(200).json({
      success: true,
      data: doc[0],
    });
  } catch (error) {
    console.error('[Document Fetch Single Error]', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch document record',
    });
  }
};

/**
 * POST /api/hr/documents
 * Create document record with employee_id + document_type uniqueness check.
 */
export const createDocument = async (req: Request, res: Response) => {
  try {
    const { employee_id, document_type, file_url, file_name, expiry_date, notes } = req.body;

    if (!employee_id || !document_type || !file_url || !file_name) {
      return res.status(400).json({
        success: false,
        message: 'employee_id, document_type, file_url, and file_name are required',
      });
    }

    if (!VALID_TYPES.includes(document_type)) {
      return res.status(400).json({
        success: false,
        message: `Invalid document type. Allowed types: ${VALID_TYPES.join(', ')}`,
      });
    }

    // Uniqueness validation: employee_id + document_type
    const duplicate = await prisma.$queryRawUnsafe<any[]>(
      `SELECT id FROM documents WHERE employee_id = $1 AND LOWER(document_type) = LOWER($2) LIMIT 1`,
      Number(employee_id),
      document_type.trim()
    );

    if (duplicate.length) {
      return res.status(400).json({
        success: false,
        message: `A document of type "${document_type}" has already been uploaded for this employee.`,
      });
    }

    const expiryVal = expiry_date ? new Date(expiry_date) : null;

    await prisma.$executeRawUnsafe(
      `
      INSERT INTO documents (
        employee_id,
        document_type,
        file_url,
        file_name,
        expiry_date,
        notes,
        status
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      `,
      Number(employee_id),
      document_type.trim(),
      file_url,
      file_name.trim(),
      expiryVal,
      notes || null,
      'Pending'
    );

    res.status(201).json({
      success: true,
      message: 'Document record registered successfully',
    });
  } catch (error) {
    console.error('[Document Create Error]', error);
    res.status(500).json({
      success: false,
      message: 'Failed to register document record',
    });
  }
};

/**
 * PATCH /api/hr/documents/:id/status
 * Verify or Reject a document. Records verifier ID and verification timestamp.
 */
export const updateDocumentStatus = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    const userId = (req as any).userId; // populated by authenticate middleware

    if (!status || !['Pending', 'Verified', 'Rejected'].includes(status)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid status. Allowed values: Pending, Verified, Rejected',
      });
    }

    const existing = await prisma.$queryRawUnsafe<any[]>(
      `SELECT id FROM documents WHERE id = $1 LIMIT 1`,
      Number(id)
    );

    if (!existing.length) {
      return res.status(404).json({
        success: false,
        message: 'Document record not found',
      });
    }

    console.log('[DEBUG PATCH STATUS] ID:', id, 'Status:', status, 'req.userId:', userId);

    const verifiedBy = status === 'Pending' ? null : (userId ? Number(userId) : null);
    const verifiedAt = status === 'Pending' ? null : new Date();

    console.log('[DEBUG PATCH STATUS] verifiedBy:', verifiedBy, 'verifiedAt:', verifiedAt);

    await prisma.$executeRawUnsafe(
      `
      UPDATE documents
      SET
        status = $1,
        verified_by = $2,
        verified_at = $3
      WHERE id = $4
      `,
      status,
      verifiedBy,
      verifiedAt,
      Number(id)
    );

    console.log('[DEBUG PATCH STATUS] Update query executed successfully');

    res.status(200).json({
      success: true,
      message: `Document status updated to "${status}" successfully`,
    });
  } catch (error) {
    console.error('[Document Status Update Error]', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update document status',
    });
  }
};

/**
 * DELETE /api/hr/documents/:id
 */
export const deleteDocument = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const existing = await prisma.$queryRawUnsafe<any[]>(
      `SELECT id FROM documents WHERE id = $1 LIMIT 1`,
      Number(id)
    );

    if (!existing.length) {
      return res.status(404).json({
        success: false,
        message: 'Document record not found',
      });
    }

    await prisma.$executeRawUnsafe(
      `DELETE FROM documents WHERE id = $1`,
      Number(id)
    );

    res.status(200).json({
      success: true,
      message: 'Document record deleted successfully',
    });
  } catch (error) {
    console.error('[Document Delete Error]', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete document record',
    });
  }
};

/**
 * POST /api/hr/documents/upload
 * Multer memory upload with streaming to Cloudinary. Restricts file types to PDF, JPG, JPEG, and PNG.
 */
export const uploadDocument = async (req: Request, res: Response) => {
  try {
    const file = req.file;
    if (!file) {
      return res.status(400).json({ success: false, message: 'No file uploaded' });
    }

    // Only allow PDF, JPG, JPEG, PNG
    const ext = path.extname(file.originalname).toLowerCase();
    const allowed = ['.pdf', '.jpg', '.jpeg', '.png'];
    if (!allowed.includes(ext)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid file format. Only PDF, JPG, JPEG, and PNG files are allowed.'
      });
    }

    // Size limit verification
    if (file.size > 5 * 1024 * 1024) {
      return res.status(400).json({
        success: false,
        message: 'File size must not exceed 5MB'
      });
    }

    const uploadPromise = new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        {
          resource_type: 'auto',
          folder: 'erp_employee_documents',
          public_id: `${Date.now()}-${file.originalname.replace(/[^a-zA-Z0-9-_\.]/g, '')}`
        },
        (error, result) => {
          if (error) {
            reject(error);
          } else {
            resolve(result);
          }
        }
      );
      stream.end(file.buffer);
    });

    const result = await uploadPromise as any;
    res.status(200).json({
      success: true,
      url: result.secure_url,
      fileName: file.originalname,
    });
  } catch (error) {
    console.error('[Document Upload Controller Error]', error);
    res.status(500).json({
      success: false,
      message: 'Failed to upload document file',
    });
  }
};
