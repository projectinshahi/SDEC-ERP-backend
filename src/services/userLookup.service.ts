import prisma from '../config/db.js';
import { normalizePhone } from '../utils/phone.js';

/**
 * PHONE → ERP USER LOOKUP (Phase 2.2).
 *
 * Backs POST /api/users/lookup-by-phone, which the My Task mobile app uses to
 * work out which of a device's contacts are ERP users.
 *
 * Two halves, deliberately split so the rules are testable without a database:
 *   • normalizeLookupPhones() — pure validation + normalization + de-duplication.
 *   • userLookupService.findUsersByPhones() — ONE parameterized query.
 *
 * Self-check: npx tsx src/services/userLookup.service.selfcheck.ts
 */

/**
 * Max phone numbers accepted per request. Bounds the query, and combined with the
 * route's rate limit caps how many numbers one account can test per window
 * (100 × 20 requests / 15 min), which is what makes bulk harvesting impractical.
 */
export const MAX_PHONES_PER_LOOKUP = 100;

/**
 * Max characters accepted for ONE phone entry. E.164 is at most 16 chars; 32
 * leaves generous room for separators. Without this the `requested` echo below
 * is an amplification vector: normalizePhone strips separators, so
 * '+919876543210' + '.'.repeat(200000) validates fine and would be reflected
 * verbatim — 100 of those turn a 29-byte reply into a ~20 MB one.
 */
export const MAX_PHONE_INPUT_LENGTH = 32;

/**
 * VISIBILITY SCOPE.
 *
 * Deliberately IDENTICAL to the predicate in `getUsersPicklist`
 * (controllers/user.controller.ts) — the existing, authenticate-only rule for
 * "which ERP users may a logged-in user discover". Any authenticated user can
 * already list every active user's id/name/email/role through that picker, so
 * matching it here adds no new exposure; narrowing it (e.g. to `user.read`)
 * would instead lock out the Developers/BDEs/Employees this feature is FOR.
 *
 * Static SQL — no caller input is ever interpolated. The phone list is bound
 * as a single $1 parameter.
 *
 * KEEP IN SYNC with user.controller.ts getUsersPicklist.
 *
 * Exported since Phase 2.6B: direct messaging decides "may I message this user"
 * with this same predicate, so the set of DM-able users is exactly the set of
 * discoverable users. Importing it is what stops a second visibility system
 * being invented — do not copy it again.
 */
export const VISIBLE_USER_PREDICATE =
  `LOWER(COALESCE(status, 'active')) NOT IN ('inactive','deleted','disabled','suspended','banned','archived')`;

/** A caller-supplied number paired with its normalized E.164 form. */
export interface PhonePair {
  /** Exactly what the caller sent, so the client can map a match back to its contact. */
  requested: string;
  e164: string;
}

export interface PhoneMatch {
  requested: string;
  phone: string;
  user: { id: number; name: string; email: string; role: string | null };
}

export type NormalizeResult =
  | { ok: true; pairs: PhonePair[] }
  | { ok: false; message: string };

/**
 * Validate and normalize the request's `phones` array.
 *
 * Every rejection is a 400 (§ the project uses no 422). Error messages NEVER echo
 * the offending number back — they identify it by array index, so a phone number
 * can't end up in a client log, an error tracker or a proxy access log.
 */
export function normalizeLookupPhones(input: unknown): NormalizeResult {
  if (input === undefined || input === null) {
    return { ok: false, message: 'phones is required and must be an array of phone numbers' };
  }
  if (!Array.isArray(input)) {
    return { ok: false, message: 'phones must be an array of phone numbers' };
  }
  if (input.length === 0) {
    return { ok: false, message: 'phones must contain at least one phone number' };
  }
  if (input.length > MAX_PHONES_PER_LOOKUP) {
    return {
      ok: false,
      message: `Too many phone numbers — a maximum of ${MAX_PHONES_PER_LOOKUP} may be looked up per request`,
    };
  }

  const seen = new Set<string>();
  const pairs: PhonePair[] = [];
  // Collect EVERY bad index, not just the first. The batch is still rejected
  // whole (product rule), but a client cleaning up a 100-contact batch would
  // otherwise need one round trip per bad entry — and it only gets 20 per window.
  const badIndexes: number[] = [];
  let firstError = '';

  for (let i = 0; i < input.length; i++) {
    const raw = input[i];
    if (typeof raw !== 'string' || raw.length > MAX_PHONE_INPUT_LENGTH) {
      badIndexes.push(i);
      if (!firstError) firstError = 'Not a valid phone number';
      continue;
    }
    // The ONE normalizer (utils/phone.ts) — same rules that wrote users.phone in
    // Phase 2.1, so a stored number and a looked-up number can never disagree.
    const result = normalizePhone(raw);
    if (!result.ok) {
      badIndexes.push(i);
      if (!firstError) firstError = result.error;
      continue;
    }
    // Two spellings of one number ("9876543210" / "+91 98765 43210") collapse to a
    // single query value, so one user is never reported twice.
    if (seen.has(result.e164)) continue;
    seen.add(result.e164);
    pairs.push({ requested: raw, e164: result.e164 });
  }

  if (badIndexes.length === 1) {
    return { ok: false, message: `Invalid phone number at index ${badIndexes[0]}: ${firstError}` };
  }
  if (badIndexes.length > 1) {
    return {
      ok: false,
      message: `Invalid phone numbers at indexes ${badIndexes.join(', ')} (first: ${firstError})`,
    };
  }

  return { ok: true, pairs };
}

interface UserRow {
  id: number;
  name: string;
  email: string;
  role: string | null;
  phone: string;
}

export const userLookupService = {
  /**
   * Resolve normalized phone numbers to visible ERP users in a SINGLE query.
   *
   * Returns ONLY matches. A number with no visible user simply has no entry —
   * the caller cannot tell "no such user" from "user exists but is deactivated"
   * from "user exists but you may not see them", which is what stops the
   * endpoint becoming an existence oracle.
   */
  async findUsersByPhones(pairs: PhonePair[]): Promise<PhoneMatch[]> {
    if (pairs.length === 0) return [];

    // `= ANY($1::text[])` (not `IN (...)`) — one bound parameter regardless of
    // list size, and it degrades safely on an empty array. users.phone is UNIQUE
    // + indexed from Phase 2.1, so this is an index scan.
    const rows = await prisma.$queryRawUnsafe<UserRow[]>(
      `SELECT id, name, email, role, phone FROM users
        WHERE phone = ANY($1::text[])
          AND ${VISIBLE_USER_PREDICATE};`,
      pairs.map((p) => p.e164),
    );

    const byPhone = new Map<string, UserRow>();
    for (const row of rows) {
      // Defensive: users.phone is unique among non-nulls, but never let a stray
      // duplicate row overwrite/duplicate a match.
      if (row.phone && !byPhone.has(row.phone)) byPhone.set(row.phone, row);
    }

    const matches: PhoneMatch[] = [];
    const emitted = new Set<number>();

    for (const pair of pairs) {
      const row = byPhone.get(pair.e164);
      if (!row || emitted.has(row.id)) continue;
      emitted.add(row.id);
      matches.push({
        requested: pair.requested,
        phone: pair.e164,
        // Explicit allow-list. Never spread `row` — that is how password hashes,
        // reset tokens and phone_verified leak into a response.
        user: { id: row.id, name: row.name, email: row.email, role: row.role ?? null },
      });
    }

    return matches;
  },
};
