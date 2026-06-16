import { Request, Response } from 'express';
import prisma from '../config/db.js';
import { activityService } from '../services/activity.service.js';
import { notificationService } from '../services/notification.service.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Strip HTML tags and collapse whitespace. */
const sanitize = (value: unknown): string => {
  if (typeof value !== 'string') return '';
  return value
    .replace(/<[^>]*>/g, '')   // strip HTML tags
    .replace(/\s+/g, ' ')     // collapse whitespace
    .trim();
};

/** Basic email-format check. */
const isValidEmail = (email: string): boolean =>
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

const titleCase = (v: string) => v.charAt(0).toUpperCase() + v.slice(1);

/**
 * Find a system admin user to act as lead owner for automated website leads.
 * Prefers "Super Admin", then "Admin". Falls back to the first user if none.
 */
const findSystemOwnerId = async (): Promise<number> => {
  // Try admin roles first
  const admins = await prisma.users.findMany({
    where: {
      OR: [
        { role: { contains: 'admin', mode: 'insensitive' } },
        { role: { contains: 'super admin', mode: 'insensitive' } },
      ],
      status: 'active',
    },
    select: { id: true, role: true },
    orderBy: { id: 'asc' },
    take: 1,
  });

  if (admins.length > 0) return admins[0].id;

  // Absolute fallback — first active user
  const fallback = await prisma.users.findFirst({
    where: { status: 'active' },
    select: { id: true },
    orderBy: { id: 'asc' },
  });

  if (!fallback) throw new Error('No active users found in the system');
  return fallback.id;
};

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

/**
 * POST /api/leads/website-capture
 *
 * Public endpoint — no authentication required.
 * Accepts website enquiry form submissions and creates a Lead + Customer.
 */
export const captureWebsiteLead = async (req: Request, res: Response) => {
  try {
    // 1. Sanitize inputs
    const name     = sanitize(req.body.name);
    const company  = sanitize(req.body.company);
    const email    = sanitize(req.body.email).toLowerCase();
    const phone    = sanitize(req.body.phone);
    const message  = sanitize(req.body.message);
    const website  = sanitize(req.body.website);
    const industry = sanitize(req.body.industry);
    const honeypot = sanitize(req.body.honeypot);

    // 2. Honeypot — if filled, silently accept (fool bots into thinking it worked)
    if (honeypot) {
      return res.status(200).json({ success: true, message: 'Lead created successfully' });
    }

    // 3. Validate required fields
    if (!name) {
      return res.status(400).json({ success: false, message: 'Name is required' });
    }
    if (!email && !phone) {
      return res.status(400).json({ success: false, message: 'Email or Phone is required' });
    }
    if (email && !isValidEmail(email)) {
      return res.status(400).json({ success: false, message: 'Invalid email format' });
    }

    // 4. Payload size guard — reject suspiciously large payloads
    if (name.length > 200 || company.length > 300 || message.length > 5000) {
      return res.status(400).json({ success: false, message: 'Input exceeds allowed length' });
    }

    // 5. Duplicate detection — check existing Customers by email/phone
    let isDuplicate = false;
    let existingCustomer: { id: number } | null = null;

    const matchClauses: any[] = [];
    if (email) matchClauses.push({ email });
    if (phone) matchClauses.push({ phone });

    if (matchClauses.length > 0) {
      existingCustomer = await prisma.customer.findFirst({
        where: { OR: matchClauses },
        select: { id: true },
      });
      if (existingCustomer) isDuplicate = true;
    }

    // 6. Resolve system owner for auto-created leads
    const ownerId = await findSystemOwnerId();

    // 7. Create or reuse Customer
    let customerId: number;
    if (existingCustomer) {
      customerId = existingCustomer.id;
    } else {
      const customer = await prisma.customer.create({
        data: {
          name,
          email: email || null,
          phone: phone || null,
          company: company || null,
          industry: industry || null,
          website: website || null,
          ownerId,
        },
      });
      customerId = customer.id;
    }

    // 8. Build lead title
    const leadTitle = company ? `${name} — ${company}` : name;

    // 9. Create Lead (source is ALWAYS "website" — never from client)
    const lead = await prisma.lead.create({
      data: {
        title: leadTitle,
        description: message || null,
        source: 'website',
        status: 'new',
        priority: 'medium',
        flaggedForReview: isDuplicate,
        customerId,
        ownerId,
      },
    });

    // 10. Activity logging
    const actor = await prisma.users.findUnique({
      where: { id: ownerId },
      select: { name: true },
    });
    const actorName = actor?.name || 'System';

    await activityService.logActivity({
      actorUserId: ownerId,
      leadId: lead.id,
      type: 'lead_created',
      description: `Website lead "${lead.title}" created automatically. Source: Website.`,
    });

    await activityService.logActivity({
      actorUserId: ownerId,
      leadId: lead.id,
      type: 'source_assigned',
      description: `Source "Website" assigned to lead "${lead.title}".`,
    });

    await activityService.logActivity({
      actorUserId: ownerId,
      leadId: lead.id,
      type: 'website_enquiry_received',
      description: `Lead captured through website enquiry form. Contact: ${email || phone}.`,
    });

    if (isDuplicate) {
      await activityService.logActivity({
        actorUserId: ownerId,
        leadId: lead.id,
        type: 'duplicate_flagged',
        description: `Duplicate email/phone detected for lead "${lead.title}". Flagged for review.`,
      });
    }

    // 11. Notifications — notify the lead owner
    await notificationService.createNotification({
      userId: ownerId,
      type: 'assignment',
      title: 'New Website Lead Received',
      message: `${name}${company ? ` — ${company}` : ''} submitted an enquiry through the website.`,
      entityType: 'lead',
      entityId: lead.id,
    });

    // Also notify all other admin/super-admin users
    const adminUsers = await prisma.users.findMany({
      where: {
        OR: [
          { role: { contains: 'admin', mode: 'insensitive' } },
          { role: { contains: 'super admin', mode: 'insensitive' } },
        ],
        status: 'active',
        id: { not: ownerId },
      },
      select: { id: true },
    });

    if (adminUsers.length > 0) {
      await notificationService.createNotifications(
        adminUsers.map((u) => u.id),
        {
          type: 'assignment',
          title: 'New Website Lead Received',
          message: `${name}${company ? ` — ${company}` : ''} submitted an enquiry through the website.`,
          entityType: 'lead',
          entityId: lead.id,
        },
      );
    }

    // 12. Success response
    return res.status(201).json({
      success: true,
      message: 'Lead created successfully',
    });
  } catch (error) {
    console.error('[WebsiteCapture] Error creating lead:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error',
    });
  }
};
