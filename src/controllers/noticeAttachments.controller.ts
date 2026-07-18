import { Request, Response } from 'express';
import multer from 'multer';
import { v2 as cloudinary } from 'cloudinary';
import prisma from '../config/db.js';
import { isNoticeOwnerOrAdmin } from './notice.controller.js';

/** Attach/remove is owner-scoped: the publisher, or a Founder/SuperAdmin. */
function canAttachTo(req: Request, publishedBy: number | null): boolean {
  return isNoticeOwnerOrAdmin(req, publishedBy);
}

/**
 * Notice attachments — files (Cloudinary) + external links. Reuses the exact
 * shared multer + Cloudinary infra the rest of the app uses (myTaskAttachments,
 * bug/ticket/blocker attachments); writes ONLY to notice_attachments.
 *
 * NOTE (known infra caveat): PDF delivery from Cloudinary requires the account's
 * "Allow delivery of PDF and ZIP files" setting to be ON, else the delivery URL
 * returns 401. That is an account toggle, not a code bug — the stored URL is
 * correct and preview/download work once it is enabled.
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

/** POST /notices/:id/attachments — upload one or more files to a notice. */
export const uploadNoticeAttachment = async (req: Request, res: Response) => {
  try {
    const noticeId = Number(req.params.id);
    const userId = uid(req);
    const files = req.files as Express.Multer.File[];
    if (Number.isNaN(noticeId)) return res.status(400).json({ error: 'Invalid notice id' });
    if (!files || files.length === 0) return res.status(400).json({ error: 'No files uploaded' });

    const notice = await prisma.notices.findUnique({ where: { id: noticeId }, select: { published_by: true } });
    if (!notice) return res.status(404).json({ error: 'Notice not found' });
    if (!(await canAttachTo(req, notice.published_by))) {
      return res.status(403).json({ error: 'You can only attach to notices you published.' });
    }

    const uploaded = [];
    for (const file of files) {
      const result: any = await new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
          {
            resource_type: 'auto',
            folder: 'erp_notice_attachments',
            public_id: `${Date.now()}-${file.originalname.replace(/[^a-zA-Z0-9-_.]/g, '')}`,
          },
          (error, r) => (error ? reject(error) : resolve(r)),
        );
        stream.end(file.buffer);
      });
      const attachment = await prisma.notice_attachments.create({
        data: {
          notice_id: noticeId,
          file_name: file.originalname,
          file_url: result.secure_url,
          file_size: file.size,
          file_type: file.mimetype || null,
          is_link: false,
          uploaded_by: userId,
        },
      });
      uploaded.push(attachment);
    }
    return res.status(201).json({ success: true, attachments: uploaded });
  } catch (error) {
    console.error('Error uploading notice attachment:', error);
    return res.status(500).json({ error: 'Failed to upload attachments' });
  }
};

/** POST /notices/:id/links — attach an external link (no file upload). */
export const addNoticeLink = async (req: Request, res: Response) => {
  try {
    const noticeId = Number(req.params.id);
    const userId = uid(req);
    if (Number.isNaN(noticeId)) return res.status(400).json({ error: 'Invalid notice id' });

    const url = String(req.body?.url ?? '').trim();
    if (!/^https?:\/\/.+/i.test(url)) return res.status(400).json({ error: 'A valid http(s) URL is required.' });
    const label = String(req.body?.label ?? '').trim().slice(0, 255) || url;

    const notice = await prisma.notices.findUnique({ where: { id: noticeId }, select: { published_by: true } });
    if (!notice) return res.status(404).json({ error: 'Notice not found' });
    if (!(await canAttachTo(req, notice.published_by))) {
      return res.status(403).json({ error: 'You can only attach to notices you published.' });
    }

    const attachment = await prisma.notice_attachments.create({
      data: {
        notice_id: noticeId,
        file_name: label,
        file_url: url,
        file_size: null,
        file_type: 'link',
        is_link: true,
        uploaded_by: userId,
      },
    });
    return res.status(201).json({ success: true, attachment });
  } catch (error) {
    console.error('Error adding notice link:', error);
    return res.status(500).json({ error: 'Failed to add link' });
  }
};

/** DELETE /notices/:id/attachments/:attachmentId — remove a file or link. */
export const deleteNoticeAttachment = async (req: Request, res: Response) => {
  try {
    const noticeId = Number(req.params.id);
    const attachmentId = Number(req.params.attachmentId);
    if (Number.isNaN(attachmentId)) return res.status(404).json({ error: 'Attachment not found' });

    const attachment = await prisma.notice_attachments.findUnique({ where: { id: attachmentId } });
    if (!attachment || attachment.notice_id !== noticeId) return res.status(404).json({ error: 'Attachment not found' });

    const notice = await prisma.notices.findUnique({ where: { id: noticeId }, select: { published_by: true } });
    if (!canAttachTo(req, notice?.published_by ?? null)) {
      return res.status(403).json({ error: 'You can only manage attachments on notices you published.' });
    }

    // Best-effort Cloudinary cleanup for uploaded files (skip external links).
    if (!attachment.is_link) {
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
    }

    await prisma.notice_attachments.delete({ where: { id: attachmentId } });
    return res.status(200).json({ success: true });
  } catch (error) {
    console.error('Error deleting notice attachment:', error);
    return res.status(500).json({ error: 'Failed to delete attachment' });
  }
};
