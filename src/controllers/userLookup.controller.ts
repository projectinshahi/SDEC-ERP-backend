import { Request, Response } from 'express';
import { normalizeLookupPhones, userLookupService } from '../services/userLookup.service.js';

/**
 * POST /api/users/lookup-by-phone
 *
 * Body:  { "phones": ["+919876543210", "98765 43210"] }
 * Reply: { "success": true, "matches": [ { requested, phone, user:{id,name,email,role} } ] }
 *
 * Authenticated (see user.routes.ts) and rate-limited per user. Returns ONLY
 * matched, visible users — unmatched numbers are absent from the response rather
 * than reported as negatives, so the endpoint never confirms non-existence.
 *
 * Kept in its own controller so the phone/privacy rules stay reviewable in one
 * place and the existing user-management handlers are untouched.
 */
export const lookupUsersByPhone = async (req: Request, res: Response) => {
  const requesterId = (req as any).userId;

  try {
    const normalized = normalizeLookupPhones((req.body ?? {}).phones);
    if (!normalized.ok) {
      return res.status(400).json({ success: false, message: normalized.message });
    }

    const matches = await userLookupService.findUsersByPhones(normalized.pairs);

    // PRIVACY: counts only. Phone numbers are personal data and must never reach
    // the logs. morgan logs the URL, not the body, so the numbers stay unlogged.
    console.log(
      `[UserLookup] requester=${requesterId} requested=${normalized.pairs.length} matched=${matches.length}`,
    );

    return res.status(200).json({ success: true, matches });
  } catch (error: any) {
    // Never surface the driver/Prisma error — it can quote the query and params.
    console.error('[UserLookup] Error looking up users by phone:', error?.message || error);
    return res.status(500).json({ success: false, message: 'Failed to look up users' });
  }
};
