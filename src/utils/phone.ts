/**
 * PHONE IDENTITY — the ONE place a phone number becomes its stored form.
 *
 * Phase 2 matches device contacts against ERP users by phone, which only works
 * if every number is stored in exactly one shape. Everything that writes
 * `users.phone` MUST go through normalizePhone() — never trim/store a raw value.
 *
 * Stored shape is E.164: '+' + country code + national number, digits only
 * (e.g. +919876543210).
 *
 * DEFAULT COUNTRY: the default is applied ONLY to a bare national number of the
 * expected length (and to its 0-trunk-prefixed form). Anything else without a
 * country code is REJECTED rather than guessed — an 8- or 12-digit foreign
 * number must never be silently turned into an Indian one. Both values are
 * env-configurable so a second country never means editing call sites.
 *
 * Self-check: npx tsx src/utils/phone.selfcheck.ts
 */

/** Country code assumed for bare national numbers. Default +91 (India). */
export const DEFAULT_COUNTRY_CODE = (process.env.DEFAULT_PHONE_COUNTRY_CODE || '+91').trim();

/** Digit count of a national number in the default country. India = 10. */
export const DEFAULT_NATIONAL_LENGTH = Number(process.env.DEFAULT_PHONE_NATIONAL_LENGTH || 10);

/** E.164: leading '+', non-zero country digit, 8–15 digits total. */
const E164 = /^\+[1-9]\d{7,14}$/;

/**
 * Separators humans type: spaces, ( ), dots, ASCII and unicode dashes \u2014 PLUS the
 * invisible formatting characters real address books carry. iOS/Android store
 * bidi marks around numbers in RTL locales and vCard imports pick up zero-width
 * spaces; without these, one such contact rejects an entire lookup batch.
 * `\s` already covers BOM/NBSP/thin-space, so stripping these too just makes the
 * rule consistent. Strictly additive: every character here previously caused a
 * REJECT, so no value that already normalized can change.
 */
const SEPARATORS = /[\s().\u2010-\u2015\u200b-\u200f\u202a-\u202e\u2066-\u2069-]/g;

export type PhoneResult =
  | { ok: true; e164: string }
  | { ok: false; error: string };

/**
 * Normalize a user-supplied phone number to E.164, or explain why it can't be.
 * The `error` string is safe to return to the client as-is (no raw input echoed).
 */
export function normalizePhone(input: unknown): PhoneResult {
  const raw = String(input ?? '').trim();
  if (!raw) return { ok: false, error: 'Phone number is required' };

  let s = raw.replace(SEPARATORS, '');

  // International access prefix (00 / +) → canonical '+'.
  if (s.startsWith('00')) s = '+' + s.slice(2);

  if (!/^\+?\d+$/.test(s)) {
    return { ok: false, error: 'Phone number may only contain digits, spaces and + ( ) -' };
  }

  if (!s.startsWith('+')) {
    const ccDigits = DEFAULT_COUNTRY_CODE.replace(/\D/g, '');

    if (s.length === ccDigits.length + DEFAULT_NATIONAL_LENGTH && s.startsWith(ccDigits)) {
      // Already carries the default country code, just missing the '+'.
      s = '+' + s;
    } else if (s.length === DEFAULT_NATIONAL_LENGTH) {
      // Bare national number — the ONLY case where the default country is assumed.
      s = DEFAULT_COUNTRY_CODE + s;
    } else if (s.length === DEFAULT_NATIONAL_LENGTH + 1 && s.startsWith('0')) {
      // National trunk prefix (e.g. 09876543210).
      s = DEFAULT_COUNTRY_CODE + s.slice(1);
    } else {
      return { ok: false, error: `Please include the country code (e.g. ${DEFAULT_COUNTRY_CODE}9876543210)` };
    }
  }

  if (!E164.test(s)) return { ok: false, error: 'Please enter a valid phone number' };
  return { ok: true, e164: s };
}
