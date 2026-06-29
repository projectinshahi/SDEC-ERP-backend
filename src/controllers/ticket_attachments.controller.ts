import { Request, Response } from 'express';
import multer from 'multer';
import { v2 as cloudinary } from 'cloudinary';
import prisma from '../config/db.js';
import path from 'path';
import { isGlobalAdmin } from '../utils/roles.js';
import { activityService } from '../services/activity.service.js';
import { notificationService } from '../services/notification.service.js';
import { canAccessSalesTicket } from './ticket.controller.js';

// Cloudinary config (mirrors blocker_attachments).
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const storage = multer.memoryStorage();
export const uploadMiddleware = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } });

/** Notify ticket creator + assignee (excluding the actor). */
async function notifyTicketParticipants(ticket: { id: number; title: string; createdBy: number; assignedTo: number | null }, actorId: number, type: string, message: string) {
  const recipients = new Set<number>();
  if (ticket.createdBy !== actorId) recipients.add(ticket.createdBy);
  if (ticket.assignedTo && ticket.assignedTo !== actorId) recipients.add(ticket.assignedTo);
  await notificationService.createNotifications(Array.from(recipients), {
    type,
    title: 'Ticket Attachment',
    message,
    entityType: 'ticket',
    entityId: ticket.id,
  });
}

export const uploadTicketAttachment = async (req: Request, res: Response) => {
  try {
    const ticketId = Number(req.params.id);
    const files = req.files as Express.Multer.File[];
    if (!files || files.length === 0) return res.status(400).json({ error: 'No files uploaded' });

    const userId = Number((req as any).userId);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const ticket = await prisma.ticket.findUnique({ where: { id: ticketId } });
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
    if (!canAccessSalesTicket(ticket, userId, isGlobalAdmin((req as any).userRole || ''))) {
      return res.status(403).json({ error: 'Forbidden: you do not have access to this ticket' });
    }

    let descriptions: string[] = [];
    if (req.body.descriptions) {
      descriptions = Array.isArray(req.body.descriptions) ? req.body.descriptions : [req.body.descriptions];
    }

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

      const cloudinaryResult = await new Promise<any>((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
          {
            resource_type: 'auto',
            folder: 'erp_ticket_attachments',
            public_id: `${Date.now()}-${file.originalname.replace(/[^a-zA-Z0-9-_\.]/g, '')}`,
          },
          (error, result) => (error ? reject(error) : resolve(result)),
        );
        stream.end(file.buffer);
      });

      const attachment = await prisma.ticket_attachments.create({
        data: {
          ticket_id: ticketId,
          file_name: file.originalname,
          file_url: cloudinaryResult.secure_url,
          file_size: file.size,
          description,
          uploaded_by: userId,
        },
      });
      uploadedAttachments.push(attachment);

      await activityService.logActivity({
        actorUserId: userId,
        ticketId,
        projectId: ticket.projectId || undefined,
        leadId: ticket.leadId || undefined,
        dealId: ticket.dealId || undefined,
        type: 'attachment_uploaded',
        description: `Uploaded attachment: ${file.originalname} to Ticket #${ticketId}`,
      });
      await notifyTicketParticipants(ticket, userId, 'attachment', `An attachment "${file.originalname}" was added to ticket: "${ticket.title}"`);
    }

    res.status(201).json({ success: true, message: 'Files uploaded successfully', data: uploadedAttachments, attachments: uploadedAttachments });
  } catch (error: any) {
    console.error('Error uploading ticket attachments:', error);
    res.status(500).json({ error: 'Failed to upload attachments' });
  }
};

export const getTicketAttachments = async (req: Request, res: Response) => {
  try {
    const ticketId = Number(req.params.id);
    if (isNaN(ticketId)) return res.status(400).json({ error: 'Invalid ticket ID' });

    const ticket = await prisma.ticket.findUnique({ where: { id: ticketId } });
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
    if (!canAccessSalesTicket(ticket, Number((req as any).userId), isGlobalAdmin((req as any).userRole || ''))) {
      return res.status(403).json({ error: 'Forbidden: you do not have access to this ticket' });
    }

    const attachments = await prisma.ticket_attachments.findMany({
      where: { ticket_id: ticketId },
      include: { uploader: { select: { id: true, name: true, email: true } } },
      orderBy: { uploaded_at: 'desc' },
    });

    res.status(200).json({ success: true, data: attachments, attachments });
  } catch (error) {
    console.error('Error fetching ticket attachments:', error);
    res.status(500).json({ error: 'Failed to fetch attachments' });
  }
};

export const deleteTicketAttachment = async (req: Request, res: Response) => {
  try {
    const attachmentId = Number(req.params.attachmentId);
    if (isNaN(attachmentId)) return res.status(400).json({ error: 'Invalid attachment ID' });

    const attachment = await prisma.ticket_attachments.findUnique({ where: { id: attachmentId } });
    if (!attachment) return res.status(404).json({ error: 'Attachment not found' });

    const userId = Number((req as any).userId);
    const isAdmin = isGlobalAdmin((req as any).userRole || '');
    if (attachment.uploaded_by !== userId && !isAdmin) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    // Best-effort Cloudinary cleanup.
    try {
      if (attachment.file_url.includes('cloudinary.com')) {
        const urlParts = attachment.file_url.split('/');
        const uploadIndex = urlParts.findIndex((p) => p === 'upload');
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

    await prisma.ticket_attachments.delete({ where: { id: attachmentId } });

    await activityService.logActivity({
      actorUserId: userId,
      ticketId: attachment.ticket_id,
      type: 'attachment_removed',
      description: `Removed attachment: ${attachment.file_name} from Ticket #${attachment.ticket_id}`,
    });

    res.status(200).json({ success: true, message: 'Attachment removed successfully' });
  } catch (error: any) {
    console.error('Error deleting ticket attachment:', error);
    res.status(500).json({ error: 'Failed to delete attachment' });
  }
};
