import { Request, Response } from 'express';
import multer from 'multer';
import { v2 as cloudinary } from 'cloudinary';
import prisma from '../config/db.js';
import { activityService } from '../services/activity.service.js';

// Configure Cloudinary using environment variables
// It expects CLOUDINARY_URL or CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET to be present in .env
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Use memory storage for multer since we upload to Cloudinary directly via streams
const storage = multer.memoryStorage();

export const uploadMiddleware = multer({ 
  storage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB limit
});

export const uploadTaskAttachment = async (req: Request, res: Response) => {
  try {
    const taskId = String(req.params.id);
    const files = req.files as Express.Multer.File[];
    
    if (!files || files.length === 0) {
      return res.status(400).json({ error: 'No files uploaded' });
    }

    const userId = Number((req as any).userId);
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Check if task exists
    const task = await prisma.kanban_tasks.findUnique({
      where: { id: taskId }
    });

    if (!task) {
      return res.status(404).json({ error: 'Task not found' });
    }

    const uploadedAttachments = [];

    for (const file of files) {
      // Use "auto" resource type to support both images and raw files (PDFs, docs)
      const uploadPromise = new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
          {
            resource_type: 'auto',
            folder: 'erp_task_attachments',
            // Keep original filename if possible (Cloudinary strips extensions for raw files though)
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

      const cloudinaryResult = await uploadPromise as any;
      const fileUrl = cloudinaryResult.secure_url;
      
      const attachment = await prisma.task_attachments.create({
        data: {
          task_id: taskId,
          file_name: file.originalname,
          file_url: fileUrl, // Save Cloudinary absolute URL
          file_size: file.size,
          uploaded_by: userId
        }
      });
      
      uploadedAttachments.push(attachment);

      await activityService.logActivity({
        actorUserId: userId,
        projectId: undefined,
        taskId: taskId,
        type: 'attachment_uploaded',
        description: `Uploaded attachment: ${file.originalname}`
      });
    }

    res.status(201).json({
      success: true,
      message: 'Files uploaded successfully',
      attachments: uploadedAttachments
    });
  } catch (error: any) {
    console.error('Error uploading task attachments:', error);
    res.status(500).json({ error: 'Failed to upload attachments' });
  }
};

export const deleteTaskAttachment = async (req: Request, res: Response) => {
  try {
    const attachmentId = Number(req.params.attachmentId);
    
    const attachment = await prisma.task_attachments.findUnique({
      where: { id: attachmentId }
    });

    if (!attachment) {
      return res.status(404).json({ error: 'Attachment not found' });
    }

    // Try to delete from Cloudinary
    // Extract public_id and resource_type from URL
    try {
      if (attachment.file_url.includes('cloudinary.com')) {
        const urlParts = attachment.file_url.split('/');
        const uploadIndex = urlParts.findIndex(p => p === 'upload');
        if (uploadIndex !== -1) {
          // urlParts[uploadIndex - 1] is resource_type (image, raw, video)
          const resourceType = urlParts[uploadIndex - 1];
          // after upload, there's version (v1234), then public_id with extension
          const publicIdWithExtension = urlParts.slice(uploadIndex + 2).join('/');
          // For raw files, extension is part of public_id. For images, extension is ignored by destroy if we strip it, 
          // but destroy needs public_id without extension for images.
          let publicId = publicIdWithExtension;
          if (resourceType === 'image' || resourceType === 'video') {
            publicId = publicIdWithExtension.substring(0, publicIdWithExtension.lastIndexOf('.'));
          }
          
          await cloudinary.uploader.destroy(publicId, { resource_type: resourceType });
        }
      }
    } catch (cloudinaryErr) {
      console.error('Failed to delete file from Cloudinary:', cloudinaryErr);
      // We still proceed to delete DB record
    }

    // Delete record from DB
    await prisma.task_attachments.delete({
      where: { id: attachmentId }
    });

    const userId = Number((req as any).userId);
    if (userId) {
      await activityService.logActivity({
        actorUserId: userId,
        projectId: undefined,
        taskId: attachment.task_id,
        type: 'attachment_removed',
        description: `Removed attachment: ${attachment.file_name}`
      });
    }

    res.status(200).json({ success: true, message: 'Attachment removed successfully' });
  } catch (error: any) {
    console.error('Error deleting task attachment:', error);
    res.status(500).json({ error: 'Failed to delete attachment' });
  }
};
