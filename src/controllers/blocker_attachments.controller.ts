import { Request, Response } from 'express';
import multer from 'multer';
import { v2 as cloudinary } from 'cloudinary';
import prisma from '../config/db.js';
import { activityService } from '../services/activity.service.js';
import { notificationService } from '../services/notification.service.js';
import path from 'path';

// Configure Cloudinary using environment variables
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Use memory storage for multer since we upload to Cloudinary directly via streams
const storage = multer.memoryStorage();

export const uploadMiddleware = multer({ 
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit for chat images
});

export const uploadBlockerAttachment = async (req: Request, res: Response) => {
  try {
    const blockerId = Number(req.params.id);
    const files = req.files as Express.Multer.File[];
    
    if (!files || files.length === 0) {
      return res.status(400).json({ error: 'No files uploaded' });
    }

    const userId = Number((req as any).userId);
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Check if blocker exists
    const blocker = await prisma.blocker.findUnique({
      where: { id: blockerId }
    });

    if (!blocker) {
      return res.status(404).json({ error: 'Blocker not found' });
    }

    // Parse descriptions (could be a string or array of strings)
    let descriptions: string[] = [];
    if (req.body.descriptions) {
      if (Array.isArray(req.body.descriptions)) {
        descriptions = req.body.descriptions;
      } else {
        descriptions = [req.body.descriptions];
      }
    }

    // Validation: Prevent dangerous file types
    const blockedExtensions = ['.exe', '.bat', '.msi', '.sh', '.cmd', '.js', '.vbs'];
    for (const file of files) {
      const ext = path.extname(file.originalname).toLowerCase();
      if (blockedExtensions.includes(ext)) {
        return res.status(400).json({ error: `File type ${ext} is not allowed.` });
      }
    }

    const uploadedAttachments = [];

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const description = descriptions[i] || null;

      // Use "auto" resource type to support both images and raw files
      const uploadPromise = new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
          {
            resource_type: 'auto',
            folder: 'erp_blocker_attachments',
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
      
      const attachment = await prisma.blocker_attachments.create({
        data: {
          blocker_id: blockerId,
          file_name: file.originalname,
          file_url: fileUrl, // Save Cloudinary absolute URL
          file_size: file.size,
          description: description,
          uploaded_by: userId
        }
      });
      
      uploadedAttachments.push(attachment);

      await activityService.logActivity({
        actorUserId: userId,
        projectId: blocker.projectId,
        type: 'attachment_uploaded',
        description: `Uploaded attachment: ${file.originalname} to Blocker #${blockerId}`
      });
      
      const notifyUsers = new Set<number>();
      if (blocker.loggedById !== userId) notifyUsers.add(blocker.loggedById);
      if (blocker.helpNeededFromId && blocker.helpNeededFromId !== userId) notifyUsers.add(blocker.helpNeededFromId);

      await notificationService.createNotifications(Array.from(notifyUsers), {
        type: 'attachment',
        title: 'New Blocker Attachment',
        message: `An attachment "${file.originalname}" was added to blocker: "${blocker.title}"`,
        entityType: 'blocker',
        entityId: blocker.id
      });
    }

    res.status(201).json({
      success: true,
      message: 'Files uploaded successfully',
      attachments: uploadedAttachments
    });
  } catch (error: any) {
    console.error('Error uploading blocker attachments:', error);
    res.status(500).json({ error: 'Failed to upload attachments' });
  }
};

export const getBlockerAttachments = async (req: Request, res: Response) => {
  try {
    const blockerId = Number(req.params.id);
    if (isNaN(blockerId)) return res.status(400).json({ error: 'Invalid blocker ID' });

    const attachments = await prisma.blocker_attachments.findMany({
      where: { blocker_id: blockerId },
      include: {
        uploader: {
          select: { id: true, name: true, email: true }
        }
      },
      orderBy: { uploaded_at: 'desc' }
    });

    res.status(200).json({ success: true, attachments });
  } catch (error) {
    console.error('Error fetching blocker attachments:', error);
    res.status(500).json({ error: 'Failed to fetch attachments' });
  }
};

export const deleteBlockerAttachment = async (req: Request, res: Response) => {
  try {
    const attachmentId = Number(req.params.attachmentId);
    if (isNaN(attachmentId)) return res.status(400).json({ error: 'Invalid attachment ID' });
    
    const attachment = await prisma.blocker_attachments.findUnique({
      where: { id: attachmentId }
    });

    if (!attachment) {
      return res.status(404).json({ error: 'Attachment not found' });
    }

    const userId = Number((req as any).userId);
    const userRole = String((req as any).userRole || '').toLowerCase();
    const isGlobalAdmin = userRole === 'admin' || userRole === 'super admin';

    if (attachment.uploaded_by !== userId && !isGlobalAdmin) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    // Delete from Cloudinary
    try {
      if (attachment.file_url.includes('cloudinary.com')) {
        const urlParts = attachment.file_url.split('/');
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

    await prisma.blocker_attachments.delete({
      where: { id: attachmentId }
    });

    if (userId) {
      await activityService.logActivity({
        actorUserId: userId,
        projectId: undefined,
        type: 'attachment_removed',
        description: `Removed attachment: ${attachment.file_name} from Blocker #${attachment.blocker_id}`
      });
    }

    res.status(200).json({ success: true, message: 'Attachment removed successfully' });
  } catch (error: any) {
    console.error('Error deleting blocker attachment:', error);
    res.status(500).json({ error: 'Failed to delete attachment', details: error.message, stack: error.stack });
  }
};
