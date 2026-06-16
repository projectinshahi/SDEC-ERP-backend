/**
 * Lead Source tracking constants.
 *
 * Every lead must record where it originated. The primary sources are the
 * channels a lead can be captured through. `manual` is the system fallback used
 * when a source cannot be determined; leads created with it are flagged for review.
 */

// Channels a lead can explicitly originate from.
export const PRIMARY_LEAD_SOURCES = ['website', 'phone', 'email', 'import'] as const;

// Fallback used when no source can be determined. Leads with this source are flagged for review.
export const FALLBACK_LEAD_SOURCE = 'manual';

// The complete controlled list of accepted source values (stored lower-cased).
export const LEAD_SOURCES = [...PRIMARY_LEAD_SOURCES, FALLBACK_LEAD_SOURCE] as const;

export type LeadSource = (typeof LEAD_SOURCES)[number];

/**
 * Returns true if the given value is one of the accepted source values.
 */
export const isValidLeadSource = (value: unknown): value is LeadSource =>
  typeof value === 'string' && (LEAD_SOURCES as readonly string[]).includes(value.trim().toLowerCase());

/**
 * Normalizes an arbitrary input (e.g. a CSV cell or API payload) into a valid
 * lead source. Returns `null` when the value is present but not recognised so
 * callers can decide whether to reject or fall back.
 */
export const normalizeLeadSource = (value: unknown): LeadSource | null => {
  if (typeof value !== 'string') return null;
  const cleaned = value.trim().toLowerCase();
  if (!cleaned) return null;
  return (LEAD_SOURCES as readonly string[]).includes(cleaned) ? (cleaned as LeadSource) : null;
};
