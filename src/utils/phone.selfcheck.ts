/**
 * Runnable self-check for phone normalization (no test framework).
 *   npx tsx src/utils/phone.selfcheck.ts
 * Fails loudly if normalizePhone drifts — this is the single gate every stored
 * users.phone passes through, so a regression silently breaks contact matching.
 */
import { normalizePhone, DEFAULT_COUNTRY_CODE } from './phone.js';

let failed = 0;

const ok = (input: string, want: string) => {
  const r = normalizePhone(input);
  if (r.ok && r.e164 === want) console.log(`✓ "${input}" → ${want}`);
  else { console.error(`✗ "${input}": got ${JSON.stringify(r)}, want ${want}`); failed++; }
};

const rejects = (input: unknown, why: string) => {
  const r = normalizePhone(input);
  if (!r.ok) console.log(`✓ rejects ${JSON.stringify(input)} (${why})`);
  else { console.error(`✗ ${JSON.stringify(input)} should be rejected (${why}) but became ${r.e164}`); failed++; }
};

if (DEFAULT_COUNTRY_CODE !== '+91') {
  console.error(`This self-check assumes DEFAULT_COUNTRY_CODE=+91, got ${DEFAULT_COUNTRY_CODE}`);
  process.exit(1);
}

// Already E.164 — unchanged.
ok('+919876543210', '+919876543210');

// Formatting characters stripped: spaces, parentheses, hyphens, dots.
ok('+91 98765 43210', '+919876543210');
ok('+91 (98765) 43210', '+919876543210');
ok('+91-98765-43210', '+919876543210');
ok('+91.98765.43210', '+919876543210');
ok('  +91 98765-43210  ', '+919876543210');

// Bare national number → default country applied.
ok('9876543210', '+919876543210');
ok('98765 43210', '+919876543210');
ok('(98765) 43210', '+919876543210');

// Trunk prefix and missing '+' variants of the SAME number all converge.
ok('09876543210', '+919876543210');
ok('919876543210', '+919876543210');
ok('0091 98765 43210', '+919876543210');

// Country code SUPPLIED is preserved — never rewritten to the default.
ok('+14155552671', '+14155552671');
ok('+44 20 7123 4567', '+442071234567');
ok('+971 50 123 4567', '+971501234567');

// A foreign number without '+' is NOT guessed into +91 — UNLESS it happens to be
// exactly the default country's national length, which is unknowable from digits
// alone. ponytail: length-only country inference; add a per-country national-prefix
// pattern (IN mobiles start 6-9) if non-Indian users ever type bare numbers.
ok('4155552671', '+914155552671'); // 10 digits — indistinguishable from an IN mobile
rejects('442071234567', '12 digits not starting with 91');
rejects('12345678', 'too short to be a +91 national number');

// Junk / empty.
rejects('', 'empty');
rejects(null, 'null');
rejects(undefined, 'undefined');
rejects('   ', 'blank');
rejects('abcdefghij', 'letters');
rejects('98765abcde', 'mixed letters');
rejects('+91987654321012345', 'longer than E.164 allows');
rejects('+0119876543210', 'country code cannot start with 0');

// Invisible formatting characters that real device address books carry. `\s`
// already covered BOM/NBSP/thin-space; bidi marks and zero-width spaces used to
// reject, which would 400 an entire contact-lookup batch over one contact.
// (Written as escapes so the characters survive editors and diffs.)
ok('‎' + '+919876543210', '+919876543210');                       // LRM prefix
ok('‏' + '+919876543210', '+919876543210');                       // RLM prefix
ok('‪' + '+919876543210' + '‬', '+919876543210');           // LRE ... PDF wrap
ok('⁦' + '+91 98765 43210' + '⁩', '+919876543210'); // LRI ... PDI wrap
ok('+9198765' + '​' + '43210', '+919876543210');       // zero-width space inside
ok('﻿' + '+919876543210', '+919876543210');                       // BOM prefix
ok('+91' + ' ' + '98765' + ' ' + '43210', '+919876543210'); // non-breaking spaces
// Stripping invisibles must NOT make junk pass.
rejects('‪abcdefghij‬', 'letters are still letters once marks are stripped');
rejects('‎‏‪', 'nothing but invisible marks');

// Normalization is idempotent — re-saving a stored value must not change it.
const once = normalizePhone('98765 43210');
if (once.ok) ok(once.e164, once.e164);

if (failed) {
  console.error(`\n${failed} phone self-check(s) FAILED`);
  process.exit(1);
}
console.log('\nAll phone self-checks passed.');
