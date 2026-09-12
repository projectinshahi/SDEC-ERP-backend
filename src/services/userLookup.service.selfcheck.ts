/**
 * Runnable self-check for phone-lookup request validation (no test framework).
 *   npx tsx src/services/userLookup.service.selfcheck.ts
 *
 * Covers the PURE half — validation, normalization, de-duplication — with no
 * database. The DB half (scope filter, match shape, field allow-list) is covered
 * by the HTTP smoke suite, which needs real rows and a real session.
 */
import { normalizeLookupPhones, MAX_PHONES_PER_LOOKUP, MAX_PHONE_INPUT_LENGTH } from './userLookup.service.js';

let failed = 0;

const accepts = (label: string, input: unknown, wantE164: string[]) => {
  const r = normalizeLookupPhones(input);
  if (!r.ok) { console.error(`✗ ${label}: rejected with "${r.message}"`); failed++; return; }
  const got = r.pairs.map((p) => p.e164);
  if (JSON.stringify(got) !== JSON.stringify(wantE164)) {
    console.error(`✗ ${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(wantE164)}`); failed++; return;
  }
  console.log(`✓ ${label} → ${JSON.stringify(got)}`);
};

const rejects = (label: string, input: unknown, mustMention?: string) => {
  const r = normalizeLookupPhones(input);
  if (r.ok) { console.error(`✗ ${label}: should have been rejected, got ${JSON.stringify(r.pairs)}`); failed++; return; }
  if (mustMention && !r.message.toLowerCase().includes(mustMention.toLowerCase())) {
    console.error(`✗ ${label}: message "${r.message}" does not mention "${mustMention}"`); failed++; return;
  }
  console.log(`✓ ${label} → 400 "${r.message}"`);
};

// 1. Valid single phone.
accepts('single E.164', ['+919876543210'], ['+919876543210']);

// 2. Valid multiple phones.
accepts('multiple phones', ['+919876543210', '+919812345678'], ['+919876543210', '+919812345678']);

// 3. Formatting normalization — every spelling collapses to one stored form.
accepts('bare national', ['9876543210'], ['+919876543210']);
accepts('spaced national', ['98765 43210'], ['+919876543210']);
accepts('spaced international', ['+91 98765 43210'], ['+919876543210']);
accepts('parens + hyphens', ['+91 (98765) 43-210'], ['+919876543210']);
accepts('trunk prefix', ['09876543210'], ['+919876543210']);
accepts('foreign number keeps its country code', ['+14155552671'], ['+14155552671']);

// 4. Invalid phone → 400, and the number itself is NEVER echoed back.
rejects('letters', ['abcdefghij'], 'index 0');
rejects('too short, no country code', ['12345678'], 'index 0');
rejects('one bad entry in a good batch', ['+919876543210', 'nonsense'], 'index 1');
const leak = normalizeLookupPhones(['+919876543210', '5551234']);
if (!leak.ok && leak.message.includes('5551234')) {
  console.error('✗ error message ECHOES the rejected phone number'); failed++;
} else { console.log('✓ error message does not echo the rejected number'); }

// 5. Empty array.
rejects('empty array', [], 'at least one');

// 6. Missing / non-array phones.
rejects('undefined', undefined, 'required');
rejects('null', null, 'required');
rejects('string instead of array', '+919876543210', 'must be an array');
rejects('object instead of array', { '0': '+919876543210' }, 'must be an array');
rejects('number instead of array', 42, 'must be an array');

// 7. Too many phones — boundary exactly at the limit and one past it.
const many = (n: number) => Array.from({ length: n }, (_, i) => `+9198765${String(i).padStart(5, '0')}`);
accepts(`exactly ${MAX_PHONES_PER_LOOKUP} allowed`, many(MAX_PHONES_PER_LOOKUP), many(MAX_PHONES_PER_LOOKUP));
rejects(`${MAX_PHONES_PER_LOOKUP + 1} rejected`, many(MAX_PHONES_PER_LOOKUP + 1), 'maximum');

// 8. Non-string entries are invalid values.
rejects('numeric entry', [919876543210], 'index 0');
rejects('null entry', ['+919876543210', null], 'index 1');
rejects('nested array entry', [['+919876543210']], 'index 0');

// 9. Duplicate safety — same number in different spellings collapses to ONE
//    query value, so one user can never appear twice in the response.
accepts('exact duplicates collapse', ['+919876543210', '+919876543210'], ['+919876543210']);
accepts('spelling duplicates collapse', ['9876543210', '+91 98765 43210', '09876543210'], ['+919876543210']);

// 10. `requested` preserves the caller's original string so the client can map a
//     match back to the contact it sent, without re-implementing normalization.
const mapped = normalizeLookupPhones(['98765 43210', '+14155552671']);
if (mapped.ok && mapped.pairs[0].requested === '98765 43210' && mapped.pairs[0].e164 === '+919876543210'
    && mapped.pairs[1].requested === '+14155552671') {
  console.log('✓ requested echoes the caller\'s original input');
} else { console.error(`✗ requested not preserved: ${JSON.stringify(mapped)}`); failed++; }

// 11. First spelling wins as `requested` when duplicates collapse.
const dup = normalizeLookupPhones(['98765 43210', '+919876543210']);
if (dup.ok && dup.pairs.length === 1 && dup.pairs[0].requested === '98765 43210') {
  console.log('✓ first spelling wins when duplicates collapse');
} else { console.error(`✗ duplicate collapse kept the wrong requested: ${JSON.stringify(dup)}`); failed++; }

// 12. Over-long entries are rejected. normalizePhone strips separators, so a
//     padded-but-valid number would otherwise pass validation and be echoed back
//     verbatim in `requested` — a response-amplification vector.
const padded = '+919876543210' + '.'.repeat(200000);
rejects('200KB padded (but normalizable) entry', [padded], 'index 0');
accepts(`exactly ${MAX_PHONE_INPUT_LENGTH} chars allowed`,
  ['+91 (98765) 43210' + ' '.repeat(MAX_PHONE_INPUT_LENGTH - 17)],
  ['+919876543210']);
rejects(`${MAX_PHONE_INPUT_LENGTH + 1} chars rejected`, ['+' + '9'.repeat(MAX_PHONE_INPUT_LENGTH)], 'index 0');
const padLeak = normalizeLookupPhones([padded]);
if (!padLeak.ok && padLeak.message.length < 200) {
  console.log('✓ over-long entry does not echo its content into the error');
} else { console.error(`✗ error message ballooned to ${!padLeak.ok ? padLeak.message.length : '?'} chars`); failed++; }

// 13. EVERY bad index is reported, not just the first — the batch is rejected
//     whole, so a client must be able to fix all of them in one round trip.
const multi = normalizeLookupPhones(['+919876543210', '1800 123 4567', '+919812345678', '112', '+919898989898', '*99#']);
if (!multi.ok && multi.message.includes('1') && multi.message.includes('3') && multi.message.includes('5')) {
  console.log(`✓ all bad indexes reported → "${multi.message}"`);
} else { console.error(`✗ not all bad indexes reported: ${JSON.stringify(multi)}`); failed++; }
const multiLeak = normalizeLookupPhones(['1800 123 4567', '*99#']);
if (!multiLeak.ok && !multiLeak.message.includes('1800') && !multiLeak.message.includes('99#')) {
  console.log('✓ multi-index error still echoes no numbers');
} else { console.error(`✗ multi-index error echoes input: ${JSON.stringify(multiLeak)}`); failed++; }

if (failed) {
  console.error(`\n${failed} user-lookup self-check(s) FAILED`);
  process.exit(1);
}
console.log('\nAll user-lookup self-checks passed.');
