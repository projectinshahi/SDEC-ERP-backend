import { v2 as cloudinary } from 'cloudinary';

// Shared file-storage cleanup. Configured here too (idempotent, singleton) so this
// util works regardless of module import order — the same credentials the rest of
// the app already uses.
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

/**
 * Best-effort deletion of a Cloudinary-hosted file by its secure URL. No-op for
 * non-Cloudinary URLs, and NEVER throws (logs + continues) so a storage hiccup can
 * never block the DB delete that called it. This is the single source of the
 * Cloudinary cleanup used by both attachment delete and chat-message delete, so an
 * attachment sent through the chat is cleaned up the same way a standalone one is.
 */
export async function destroyCloudinaryFile(fileUrl: string | null | undefined): Promise<void> {
  try {
    if (!fileUrl || !fileUrl.includes('cloudinary.com')) return;
    const parts = fileUrl.split('/');
    const upIdx = parts.findIndex((p) => p === 'upload');
    if (upIdx === -1) return;
    const resourceType = parts[upIdx - 1];
    const publicIdWithExt = parts.slice(upIdx + 2).join('/');
    let publicId = publicIdWithExt;
    if (resourceType === 'image' || resourceType === 'video') publicId = publicIdWithExt.substring(0, publicIdWithExt.lastIndexOf('.'));
    await cloudinary.uploader.destroy(publicId, { resource_type: resourceType });
  } catch (err) {
    console.error('Cloudinary delete failed (proceeding):', err);
  }
}
