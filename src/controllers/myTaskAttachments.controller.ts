import { Request, Response } from 'express';
import multer from 'multer';
import { v2 as cloudinary } from 'cloudinary';
import prisma from '../config/db.js';
import { io } from '../socket.js';
import { canAccessMyTask, getMyTaskAudience } from '../utils/myTaskAccess.js';
import { bumpMyTaskActivity, logMyTaskActivity } from './myTasks.controller.js';

/**
 * Attachment upload/delete for the standalone My Tasks module. Uses the same
 * generic Cloudinary/multer infra as the rest of the app (that is shared file
 * infrastructure, not task logic) but writes ONLY to my_task_attachments and
 * enforces My Task membership. Independent of kanban task_attachments.
 */
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

export const uploadMiddleware = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
});

const uid = (req: Request) => Number((req as any).userId);
const urole = (req: Request) => String((req as any).userRole || '');

export const uploadMyTaskAttachment = async (req: Request, res: Response) => {
  try {
    const taskId = Number(req.params.id);
    const userId = uid(req);
    const files = req.files as Express.Multer.File[];
    if (!files || files.length === 0) return res.status(400).json({ error: 'No files uploaded' });

    const access = await canAccessMyTask(taskId, userId, urole(req));
    if (!access.task) return res.status(404).json({ error: 'Task not found' });
    if (!access.allowed) return res.status(403).json({ error: 'You do not have access to this task' });

    const uploaded = [];
    for (const file of files) {
      const result: any = await new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
          {
            resource_type: 'auto',
            folder: 'erp_my_task_attachments',
            public_id: `${Date.now()}-${file.originalname.replace(/[^a-zA-Z0-9-_.]/g, '')}`,
          },
          (error, r) => (error ? reject(error) : resolve(r)),
        );
        stream.end(file.buffer);
      });
      const attachment = await prisma.my_task_attachments.create({
        data: {
          task_id: taskId,
          file_name: file.originalname,
          file_url: result.secure_url,
          file_size: file.size,
          uploaded_by: userId,
        },
      });
      uploaded.push(attachment);
      console.log(result);
    }

    // Log each uploaded file in the timeline
    for (const file of files) {
      await logMyTaskActivity(taskId, userId, `Added attachment: ${file.originalname}`);
    }

    // Bump activity (flags the task unread for other members) + notify audience.
    await bumpMyTaskActivity(taskId, userId);
    const audience = await getMyTaskAudience(taskId);
    for (const u of audience) io.to(`user_${u}`).emit('mytask_changed', { taskId, action: 'attachment' });

    return res.status(201).json({ success: true, attachments: uploaded });
  } catch (error) {
    console.error('Error uploading my-task attachment:', error);
    return res.status(500).json({ error: 'Failed to upload attachments' });
  }
};

export const deleteMyTaskAttachment = async (req: Request, res: Response) => {
  try {
    const taskId = Number(req.params.id);
    const attachmentId = Number(req.params.attachmentId);
    const userId = uid(req);
    if (Number.isNaN(attachmentId)) return res.status(404).json({ error: 'Attachment not found' });

    const access = await canAccessMyTask(taskId, userId, urole(req));
    if (!access.task) return res.status(404).json({ error: 'Task not found' });
    if (!access.allowed) return res.status(403).json({ error: 'You do not have access to this task' });

    const attachment = await prisma.my_task_attachments.findUnique({ where: { id: attachmentId } });
    if (!attachment || attachment.task_id !== taskId) return res.status(404).json({ error: 'Attachment not found' });

    // Best-effort Cloudinary cleanup.
    try {
      if (attachment.file_url.includes('cloudinary.com')) {
        const parts = attachment.file_url.split('/');
        const upIdx = parts.findIndex((p) => p === 'upload');
        if (upIdx !== -1) {
          const resourceType = parts[upIdx - 1];
          const publicIdWithExt = parts.slice(upIdx + 2).join('/');
          let publicId = publicIdWithExt;
          if (resourceType === 'image' || resourceType === 'video') publicId = publicIdWithExt.substring(0, publicIdWithExt.lastIndexOf('.'));
          await cloudinary.uploader.destroy(publicId, { resource_type: resourceType });
        }
      }
    } catch (err) {
      console.error('Cloudinary delete failed (proceeding):', err);
    }

    await prisma.my_task_attachments.delete({ where: { id: attachmentId } });
    await logMyTaskActivity(taskId, userId, `Deleted attachment: ${attachment.file_name}`);
    await bumpMyTaskActivity(taskId, userId);
    const audience = await getMyTaskAudience(taskId);
    for (const u of audience) io.to(`user_${u}`).emit('mytask_changed', { taskId, action: 'attachment' });

    return res.status(200).json({ success: true });
  } catch (error) {
    console.error('Error deleting my-task attachment:', error);
    return res.status(500).json({ error: 'Failed to delete attachment' });
  }
};
