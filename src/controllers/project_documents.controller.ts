import { Request, Response } from 'express';
import multer from 'multer';
import { v2 as cloudinary } from 'cloudinary';
import prisma from '../config/db.js';
import { activityService } from '../services/activity.service.js';
import { notificationService } from '../services/notification.service.js';
import https from 'https';

// Configure Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const storage = multer.memoryStorage();
export const uploadMiddleware = multer({ 
  storage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB limit
});

export const getDocuments = async (req: Request, res: Response) => {
  try {
    const projectId = String(req.params.id);

    const documents = await prisma.project_documents.findMany({
      where: { project_id: projectId },
      include: {
        uploader: {
          select: { id: true, name: true, email: true }
        }
      },
      orderBy: { created_at: 'desc' }
    });

    res.status(200).json(documents);
  } catch (error) {
    console.error('Error fetching documents:', error);
    res.status(500).json({ error: 'Failed to fetch project documents' });
  }
};

export const uploadDocument = async (req: Request, res: Response) => {
  try {
    const projectId = String(req.params.id);
    const userId = Number((req as any).userId);
    const { title, description } = req.body;
    const file = req.file as Express.Multer.File;

    if (!file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    // Check project exists
    const project = await prisma.projects.findUnique({
      where: { id: projectId }
    });

    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    const uploadPromise = new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        {
          resource_type: 'raw',
          folder: 'erp_project_documents',
          public_id: `${Date.now()}-${file.originalname.replace(/[^a-zA-Z0-9-_\.]/g, '')}`,
          format: 'txt',
          type: 'upload',
          attachment: true,
          flags: 'attachment'
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

    const cloudinaryResult = await uploadPromise as any;
    const fileUrl = cloudinaryResult.secure_url;
    const mimeType = file.mimetype || 'application/octet-stream';

    const document = await prisma.project_documents.create({
      data: {
        project_id: projectId,
        title: title || file.originalname,
        description: description || null,
        file_name: file.originalname,
        file_url: fileUrl,
        mime_type: mimeType,
        file_size: file.size,
        uploaded_by: userId
      },
      include: {
        uploader: {
          select: { id: true, name: true, email: true }
        }
      }
    });

    // Log activity
    await activityService.logActivity({
      actorUserId: userId,
      projectId: projectId,
      type: 'document_uploaded',
      description: `Uploaded project document: ${document.title}`
    });

    // Notify other project members
    const members = await prisma.project_members.findMany({
      where: { project_id: projectId }
    });

    const memberIds = members
      .map(m => m.user_id)
      .filter(id => id !== userId);

    if (memberIds.length > 0) {
      const uploader = await prisma.users.findUnique({ where: { id: userId } });
      await notificationService.createNotifications(memberIds, {
        type: 'document',
        title: 'New Project Document',
        message: `${uploader?.name || 'A team member'} uploaded a new document: ${document.title} in ${project.name}`,
        entityType: 'project',
        entityId: projectId
      });
    }

    res.status(201).json({
      success: true,
      message: 'Document uploaded successfully',
      document
    });
  } catch (error) {
    console.error('Error uploading document:', error);
    res.status(500).json({ error: 'Failed to upload document' });
  }
};

export const updateDocument = async (req: Request, res: Response) => {
  try {
    const documentId = Number(req.params.documentId);
    const projectId = String(req.params.id);
    const userId = Number((req as any).userId);
    const { title, description } = req.body;

    const existingDoc = await prisma.project_documents.findFirst({
      where: { id: documentId, project_id: projectId }
    });

    if (!existingDoc) {
      return res.status(404).json({ error: 'Document not found' });
    }

    const updatedDoc = await prisma.project_documents.update({
      where: { id: documentId },
      data: {
        title: title !== undefined ? title : existingDoc.title,
        description: description !== undefined ? description : existingDoc.description
      },
      include: {
        uploader: {
          select: { id: true, name: true, email: true }
        }
      }
    });

    await activityService.logActivity({
      actorUserId: userId,
      projectId: projectId,
      type: 'document_updated',
      description: `Updated document metadata: ${updatedDoc.title}`
    });

    res.status(200).json({ success: true, document: updatedDoc });
  } catch (error) {
    console.error('Error updating document:', error);
    res.status(500).json({ error: 'Failed to update document' });
  }
};

export const deleteDocument = async (req: Request, res: Response) => {
  try {
    const documentId = Number(req.params.documentId);
    const projectId = String(req.params.id);
    const userId = Number((req as any).userId);
    const userRole = (req as any).userRole; // Set by checkProjectRole middleware

    const document = await prisma.project_documents.findFirst({
      where: { id: documentId, project_id: projectId }
    });

    if (!document) {
      return res.status(404).json({ error: 'Document not found' });
    }

    // Role check: Editor can only delete their own document
    if (userRole === 'editor' && document.uploaded_by !== userId) {
      return res.status(403).json({ error: 'Editors can only delete their own documents' });
    }

    // Try to delete from Cloudinary
    try {
      if (document.file_url.includes('cloudinary.com')) {
        const urlParts = document.file_url.split('/');
        const uploadIndex = urlParts.findIndex(p => p === 'upload');
        if (uploadIndex !== -1) {
          const resourceType = urlParts[uploadIndex - 1];
          const publicIdWithExtension = urlParts.slice(uploadIndex + 2).join('/');
          let publicId = publicIdWithExtension;
          if (resourceType === 'image' || resourceType === 'video') {
            publicId = publicIdWithExtension.substring(0, publicIdWithExtension.lastIndexOf('.'));
          }
          await cloudinary.uploader.destroy(publicId, { resource_type: resourceType });
        }
      }
    } catch (cloudinaryErr) {
      console.error('Failed to delete file from Cloudinary:', cloudinaryErr);
    }

    // Delete record from DB
    await prisma.project_documents.delete({
      where: { id: documentId }
    });

    await activityService.logActivity({
      actorUserId: userId,
      projectId: projectId,
      type: 'document_removed',
      description: `Deleted document: ${document.title}`
    });

    res.status(200).json({ success: true, message: 'Document removed successfully' });
  } catch (error) {
    console.error('Error deleting document:', error);
    res.status(500).json({ error: 'Failed to delete document' });
  }
};

export const downloadDocument = async (req: Request, res: Response) => {
  try {
    const documentId = Number(req.params.documentId);
    const projectId = String(req.params.id);

    const document = await prisma.project_documents.findFirst({
      where: { id: documentId, project_id: projectId }
    });

    if (!document) {
      return res.status(404).json({ error: 'Document not found' });
    }

    https.get(document.file_url, (stream) => {
      if (stream.statusCode !== 200) {
        console.error(`Cloudinary returned ${stream.statusCode} for URL: ${document.file_url}`);
        return res.status(404).json({ error: `File not found or blocked by Cloudinary` });
      }

      res.setHeader('Content-Disposition', `attachment; filename="${document.file_name}"`);
      res.setHeader('Content-Type', document.mime_type || 'application/octet-stream');
      stream.pipe(res);
    }).on('error', (e) => {
      console.error('HTTPS get error:', e);
      res.status(500).json({ error: 'Failed to download document' });
    });
  } catch (error) {
    console.error('Error in downloadDocument:', error);
    res.status(500).json({ error: 'Failed to process download request' });
  }
};
