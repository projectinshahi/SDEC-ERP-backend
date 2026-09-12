/**
 * Runnable self-check for session tokens (no test framework).
 *   npx tsx src/utils/authToken.selfcheck.ts
 *
 * These are the assertions that stop identity forgery. If any of them ever
 * fails, `Bearer <edited token>` becomes a login as somebody else.
 */
process.env.AUTH_TOKEN_SECRET ||= 'selfcheck-secret-that-is-long-enough-0123456789';

const { issueToken, verifyToken, TOKEN_TTL_SECONDS } = await import('./authToken.js');
const { createHmac } = await import('crypto');

let failed = 0;
const ok = (cond: boolean, label: string) => {
  if (cond) {
    console.log(`✓ ${label}`);
  } else {
    console.error(`✗ ${label}`);
    failed++;
  }
};

const NOW = 1_800_000_000_000; // fixed clock so expiry cases are deterministic
const token = issueToken(42, NOW);

// ── the happy path ────────────────────────────────────────────────────────
const claims = verifyToken(token, NOW);
ok(claims?.userId === 42, 'a freshly issued token verifies as its own user');
ok(claims?.expiresAt === Math.floor(NOW / 1000) + TOKEN_TTL_SECONDS, 'expiry is TTL from issue');
ok(issueToken(42, NOW) === token, 'issuing is deterministic for a fixed clock');
ok(issueToken(43, NOW) !== token, 'a different user gets a different token');

// ── THE attack this phase exists to stop ──────────────────────────────────
const parts = token.split('.');
const forged = ['v1', '43', parts[2], parts[3], parts[4]].join('.');
ok(verifyToken(forged, NOW) === null, 'user id swapped 42→43, original signature REUSED → rejected');
ok(verifyToken('user-token-43', NOW) === null, 'the old unsigned format is no longer accepted');
ok(verifyToken('user-token-42', NOW) === null, 'not even for the legitimate user');

// Every other field is equally covered by the signature.
ok(verifyToken(['v1', '42', parts[2], String(Number(parts[3]) + 99999), parts[4]].join('.'), NOW) === null,
  'expiry extended, signature reused → rejected');
ok(verifyToken(['v1', '42', String(Number(parts[2]) - 5), parts[3], parts[4]].join('.'), NOW) === null,
  'issued-at edited → rejected');
ok(verifyToken(['v2', '42', parts[2], parts[3], parts[4]].join('.'), NOW) === null,
  'version bumped → rejected');

// ── signature attacks ─────────────────────────────────────────────────────
ok(verifyToken(`${parts.slice(0, 4).join('.')}.`, NOW) === null, 'empty signature → rejected');
ok(verifyToken(parts.slice(0, 4).join('.'), NOW) === null, 'signature omitted entirely → rejected');
ok(verifyToken(`${parts.slice(0, 4).join('.')}.${'A'.repeat(parts[4].length)}`, NOW) === null,
  'random signature of the correct length → rejected');
const flipped = parts[4].slice(0, -1) + (parts[4].endsWith('A') ? 'B' : 'A');
ok(verifyToken(`${parts.slice(0, 4).join('.')}.${flipped}`, NOW) === null,
  'one character of the signature changed → rejected');

// ── wrong secret ──────────────────────────────────────────────────────────
{
  const original = process.env.AUTH_TOKEN_SECRET;
  process.env.AUTH_TOKEN_SECRET = 'a-completely-different-secret-0123456789abcd';
  ok(verifyToken(token, NOW) === null, 'a token signed with another secret → rejected');
  process.env.AUTH_TOKEN_SECRET = original;
  ok(verifyToken(token, NOW)?.userId === 42, 'and verifies again once the right secret is restored');
}

// ── expiry ────────────────────────────────────────────────────────────────
ok(verifyToken(token, NOW + (TOKEN_TTL_SECONDS - 60) * 1000)?.userId === 42, 'valid just before expiry');
ok(verifyToken(token, NOW + (TOKEN_TTL_SECONDS + 1) * 1000) === null, 'rejected just after expiry');

// ── malformed input must never throw ──────────────────────────────────────
for (const bad of [
  '', '.', '....', 'v1', 'v1.42', 'v1.42.1.2', 'Bearer v1.42.1.2.sig',
  'v1.-1.1.2.sig', 'v1.4 2.1.2.sig', 'v1.42abc.1.2.sig', 'v1.042x.1.2.sig',
  'v1..1.2.sig', 'v1.42.x.2.sig', 'v1.42.1.x.sig', 'v1.0.1.9999999999.sig',
  'a'.repeat(600),
]) {
  let threw = false;
  let result: unknown = 'not-null';
  try {
    result = verifyToken(bad, NOW);
  } catch {
    threw = true;
  }
  ok(!threw && result === null, `malformed input rejected without throwing: ${JSON.stringify(bad.slice(0, 24))}`);
}
for (const bad of [null, undefined, 42, {}, [], true]) {
  let threw = false;
  let result: unknown = 'not-null';
  try {
    result = verifyToken(bad as unknown, NOW);
  } catch {
    threw = true;
  }
  ok(!threw && result === null, `non-string input rejected without throwing: ${JSON.stringify(bad) ?? 'undefined'}`);
}

// ── a missing secret must fail closed, never open ─────────────────────────
{
  const original = process.env.AUTH_TOKEN_SECRET;
  delete process.env.AUTH_TOKEN_SECRET;
  ok(verifyToken(token, NOW) === null, 'no secret configured → verification refuses everyone');
  let threw = false;
  try {
    issueToken(1, NOW);
  } catch {
    threw = true;
  }
  ok(threw, 'no secret configured → issuing throws rather than minting an unsigned token');
  process.env.AUTH_TOKEN_SECRET = 'too-short';
  ok(verifyToken(token, NOW) === null, 'a too-short secret is treated as unconfigured');
  process.env.AUTH_TOKEN_SECRET = original;
}


// ── hardening added after adversarial review ──────────────────────────────
// A non-finite clock must fail CLOSED. Written the other way round
// (`expiresAt <= Math.floor(NaN)` === false) this ACCEPTED the token.
ok(verifyToken(token, Number.NaN) === null, 'NaN clock rejects rather than accepts');
ok(verifyToken(token, Number.POSITIVE_INFINITY) === null, 'infinite clock rejects');

// The signature proves we minted the claims; it does not prove they are sane.
{
  const iat = Math.floor(NOW / 1000);
  const sec = process.env.AUTH_TOKEN_SECRET as string;
  const forever = `v1.42.${iat}.${iat + TOKEN_TTL_SECONDS * 100}`;
  ok(verifyToken(forever + '.' + createHmac('sha256', sec).update(forever).digest('base64url'), NOW) === null,
    'a correctly signed token beyond the TTL is still rejected');

  const backwards = `v1.42.${iat}.${iat - 10}`;
  ok(verifyToken(backwards + '.' + createHmac('sha256', sec).update(backwards).digest('base64url'), NOW) === null,
    'expiry before issue is rejected');

  const padded = `v1.0042.${iat}.${iat + 3600}`;
  ok(verifyToken(padded + '.' + createHmac('sha256', sec).update(padded).digest('base64url'), NOW) === null,
    'leading-zero user id rejected even when correctly signed');
}

if (failed) {
  console.error(`\n${failed} auth-token self-check(s) FAILED`);
  process.exit(1);
}
console.log('\nAll auth-token self-checks passed.');
