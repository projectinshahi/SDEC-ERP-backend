import { createHmac, timingSafeEqual } from 'crypto';

/**
 * SESSION TOKENS — the one place a token is minted or trusted.
 *
 * Replaces `user-token-<id>`, which embedded the user id in plaintext with no
 * signature: anyone could send `Bearer user-token-43` and be user 43. Both the
 * REST middleware and the Socket.IO handshake now verify through here, so the
 * two can never drift apart.
 *
 * Format (opaque to the client, which only stores and replays it):
 *
 *     v1.<userId>.<issuedAt>.<expiresAt>.<signature>
 *
 * where signature = base64url(HMAC-SHA256(secret, "v1.<userId>.<iat>.<exp>")).
 *
 * Deliberately NOT JWT: this needs exactly one algorithm and three claims, and
 * Node's crypto is built in. A JWT library would add a dependency, plus an `alg`
 * header field whose most famous failure mode ("alg":"none") this format cannot
 * express. Deliberately NOT a server-side session table: logout is client-side
 * today (see AuthRepository.logout), so a sessions table would add a row and a
 * per-request lookup to buy revocation the product does not currently use. See
 * `issuedAt` below for the cheap upgrade path if that changes.
 */

const VERSION = 'v1';

/**
 * 30 days. The old token never expired at all, so any finite window is an
 * improvement; 30 days keeps the "stay logged in" behaviour users have now
 * while bounding how long a leaked token is useful.
 */
export const TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

/** Minimum secret length. 32 chars ≈ 128 bits when generated randomly. */
const MIN_SECRET_LENGTH = 32;

function secret(): string {
  const value = process.env.AUTH_TOKEN_SECRET;
  if (!value || value.length < MIN_SECRET_LENGTH) {
    // Fail CLOSED. A built-in default would be public knowledge and therefore
    // exactly as forgeable as the format this replaces.
    throw new Error(
      `AUTH_TOKEN_SECRET is missing or shorter than ${MIN_SECRET_LENGTH} characters. ` +
        'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'base64url\'))"',
    );
  }
  return value;
}

/**
 * Call once at startup so a misconfigured server refuses to boot instead of
 * 500ing on every request — or worse, being "fixed" later by someone adding a
 * default secret.
 */
export function assertAuthSecretConfigured(): void {
  secret();
}

function signatureFor(body: string): string {
  return createHmac('sha256', secret()).update(body).digest('base64url');
}

/** Mint a token for an ALREADY-AUTHENTICATED user. Never call this on unverified input. */
export function issueToken(userId: number, now: number = Date.now()): string {
  const issuedAt = Math.floor(now / 1000);
  const expiresAt = issuedAt + TOKEN_TTL_SECONDS;
  const body = `${VERSION}.${userId}.${issuedAt}.${expiresAt}`;
  return `${body}.${signatureFor(body)}`;
}

export interface VerifiedToken {
  userId: number;
  /** Unix seconds. Present so a future `users.tokens_valid_from` column can
   *  invalidate everything issued before a password change — one comparison,
   *  no new table, and the claim is already signed. */
  issuedAt: number;
  expiresAt: number;
}

/**
 * Verify a token and return its claims, or null if it is not trustworthy for
 * ANY reason — bad version, wrong shape, non-numeric claims, bad signature, or
 * expired.
 *
 * Callers must treat null as 401 and must not distinguish the causes to the
 * client: "expired" vs "bad signature" tells an attacker which half to work on.
 */
export function verifyToken(token: unknown, now: number = Date.now()): VerifiedToken | null {
  if (typeof token !== 'string' || token.length === 0 || token.length > 512) return null;

  const parts = token.split('.');
  if (parts.length !== 5) return null;

  const [version, userIdRaw, issuedAtRaw, expiresAtRaw, signature] = parts;
  if (version !== VERSION) return null;

  // Strict digits only: parseInt would happily accept '43abc' and ' 43'.
  // No leading zeros either, so one user has exactly one encoding — 'v1.0237…'
  // and 'v1.237…' must not both be valid tokens for user 237. Nothing today
  // keys on the token string, but a denylist or per-token limiter later would
  // silently be defeated by the duplicate encoding.
  const canonicalNumber = /^(0|[1-9]\d*)$/;
  if (
    !canonicalNumber.test(userIdRaw) ||
    !canonicalNumber.test(issuedAtRaw) ||
    !canonicalNumber.test(expiresAtRaw)
  ) {
    return null;
  }

  const body = `${version}.${userIdRaw}.${issuedAtRaw}.${expiresAtRaw}`;

  let expected: string;
  try {
    expected = signatureFor(body);
  } catch {
    // Secret missing at runtime — refuse to authenticate anyone rather than
    // fall back to trusting the payload.
    return null;
  }

  // Constant-time compare. timingSafeEqual throws on length mismatch, so the
  // length check has to come first — and a wrong length is a wrong signature.
  const given = Buffer.from(signature, 'utf8');
  const want = Buffer.from(expected, 'utf8');
  if (given.length !== want.length || !timingSafeEqual(given, want)) return null;

  const userId = Number(userIdRaw);
  const issuedAt = Number(issuedAtRaw);
  const expiresAt = Number(expiresAtRaw);
  if (!Number.isSafeInteger(userId) || userId <= 0) return null;
  if (!Number.isSafeInteger(issuedAt) || !Number.isSafeInteger(expiresAt)) return null;

  // The signature proves WE minted these, but not that they are sane. Enforcing
  // the window here makes the TTL an invariant of verification rather than a
  // convention of the minter — so a bug (or a future code path) that issued a
  // 100-year token still could not produce one that verifies.
  if (expiresAt <= issuedAt || expiresAt - issuedAt > TOKEN_TTL_SECONDS) return null;

  // Written as "not (still valid)" rather than "expired", so a NaN clock fails
  // CLOSED. `expiresAt <= Math.floor(NaN)` is false, which would have accepted
  // the token; `!(expiresAt > NaN)` is true, which rejects it.
  const nowSeconds = Math.floor(now / 1000);
  if (!(expiresAt > nowSeconds)) return null;

  return { userId, issuedAt, expiresAt };
}
