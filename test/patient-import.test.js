'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { canonicalizeHeader, mapHeaders, toIsoDate, buildImportPlan } = require('../src/patient-import');

test('header spellings all reduce to the same key', () => {
  ['First Name', 'first_name', 'FirstName', 'FIRST  NAME', 'first-name']
    .forEach((h) => assert.strictEqual(canonicalizeHeader(h), 'first name', h));
});

test('headers map to fields and missing required columns are reported', () => {
  const ok = mapHeaders(['Patient ID', 'First Name', 'Surname', 'Mobile Number', 'Email ID']);
  assert.deepStrictEqual(ok.missing, []);
  assert.deepStrictEqual(Object.values(ok.map), ['reference_id', 'first_name', 'last_name', 'phone', 'email']);

  const bad = mapHeaders(['Nickname', 'Email']);
  assert.deepStrictEqual(bad.missing.sort(), ['first_name', 'phone']);
});

test('unrecognised columns are ignored rather than breaking the import', () => {
  const { map, missing } = mapHeaders(['First Name', 'Mobile', 'Astrological Sign']);
  assert.deepStrictEqual(missing, []);
  assert.strictEqual(Object.keys(map).length, 2);
});

test('the first matching column wins when a sheet has both Name and First Name', () => {
  const { map } = mapHeaders(['Name', 'First Name', 'Mobile']);
  assert.strictEqual(map[0], 'first_name');
  assert.strictEqual(map[1], undefined);
});

test('dates arrive in several shapes and normalise to ISO', () => {
  assert.strictEqual(toIsoDate('2026-01-15'), '2026-01-15');
  assert.strictEqual(toIsoDate('15/01/2026'), '2026-01-15');
  assert.strictEqual(toIsoDate('5-1-2026'), '2026-01-05');
  assert.strictEqual(toIsoDate(new Date('2026-01-15T00:00:00Z')), '2026-01-15');
  assert.strictEqual(toIsoDate(''), null);
});

const HEADERS = ['First Name', 'Last Name', 'Mobile Number', 'Email', 'Last Blood Donation'];
const plan = (rows, findExisting) => buildImportPlan({
  rows, headerMap: mapHeaders(HEADERS).map, findExisting: findExisting || (() => null)
});

test('valid rows become creates', () => {
  const p = plan([['Aarti', 'Gupta', '9876543210', 'a@b.in', '15/01/2026']]);
  assert.strictEqual(p.creates.length, 1);
  assert.strictEqual(p.creates[0].payload.normalized_phone, '9876543210');
  assert.strictEqual(p.creates[0].payload.last_donation_date, '2026-01-15');
});

test('a matching patient becomes an update, not a duplicate', () => {
  const p = plan([['Aarti', 'Gupta', '9876543210', '', '']], () => ({ id: 7 }));
  assert.strictEqual(p.creates.length, 0);
  assert.deepStrictEqual(p.updates.map((u) => u.id), [7]);
});

test('bad rows are reported with the sheet row number and readable messages', () => {
  const p = plan([['', '', '123', 'nope', '']]);
  assert.strictEqual(p.problems.length, 1);
  assert.strictEqual(p.problems[0].row, 2, 'row 1 is the header');
  assert.ok(p.problems[0].messages.some((m) => /required/.test(m)));
  assert.ok(p.problems[0].messages.some((m) => /10-digit/.test(m)));
});

test('the same number twice in one file is caught before it hits the unique index', () => {
  const p = plan([
    ['Aarti', 'G', '9876543210', '', ''],
    ['Aarti', 'G', '+91 98765 43210', '', '']
  ]);
  assert.strictEqual(p.creates.length, 1);
  assert.strictEqual(p.problems.length, 1);
  assert.match(p.problems[0].messages[0], /more than once/);
});

test('blank rows are skipped silently', () => {
  const p = plan([['', '', '', '', ''], ['Aarti', '', '9876543210', '', '']]);
  assert.strictEqual(p.creates.length, 1);
  assert.strictEqual(p.problems.length, 0);
});

test('a phone read by Excel as a number keeps its digits', () => {
  const p = buildImportPlan({
    rows: [['Aarti', '', 9876543210, '', '']],
    headerMap: mapHeaders(HEADERS).map
  });
  assert.strictEqual(p.creates[0].payload.normalized_phone, '9876543210');
});

test('row matching stays aligned when earlier rows are invalid', () => {
  // A cursor that advances only on valid rows drifts out of step with a
  // per-row lookup, so a later row is matched against the wrong record.
  const existing = { 2: { id: 42 } };            // only the third row exists
  const p = buildImportPlan({
    rows: [
      ['Aarti', '', '9876543210', '', ''],       // 0 valid, not existing
      ['', '', '123', '', ''],                   // 1 invalid, skipped
      ['Ravi', '', '9000000011', '', '']         // 2 valid, exists
    ],
    headerMap: mapHeaders(HEADERS).map,
    findExisting: (_payload, index) => existing[index] || null
  });
  assert.strictEqual(p.updates.length, 1, 'the existing patient must be an update');
  assert.strictEqual(p.updates[0].id, 42);
  assert.strictEqual(p.creates.length, 1);
  assert.strictEqual(p.creates[0].payload.first_name, 'Aarti');
});

test('missing optional headers are omitted from an update patch', () => {
  const headers = ['First Name', 'Mobile Number'];
  const p = buildImportPlan({
    rows: [['Aarti', '9876543210']],
    headerMap: mapHeaders(headers).map,
    findExisting: () => ({ byReference: null, byPhone: { id: 7, version: '12' } })
  });
  assert.deepStrictEqual(p.updates[0].patch, {
    first_name: 'Aarti', phone: '9876543210', normalized_phone: '9876543210'
  });
});

test('present blank nullable fields clear while blank required update fields fail', () => {
  const nullable = buildImportPlan({
    rows: [['Aarti', '9876543210', '', '', '']],
    headerMap: mapHeaders(['First Name', 'Mobile Number', 'Email', 'Gender', 'Notes']).map,
    findExisting: () => ({ byReference: null, byPhone: { id: 7, version: '12' } })
  });
  assert.deepStrictEqual(nullable.updates[0].patch, {
    first_name: 'Aarti', phone: '9876543210', normalized_phone: '9876543210',
    email: null, gender: null, notes: null
  });
  const explicitUnknown = buildImportPlan({
    rows: [['Aarti', '9876543210', 'unknown']],
    headerMap: mapHeaders(['First Name', 'Mobile Number', 'Gender']).map,
    findExisting: () => ({ byReference: null, byPhone: { id: 7, version: '12' } })
  });
  assert.equal(explicitUnknown.updates[0].patch.gender, 'unknown');

  const language = buildImportPlan({
    rows: [['Aarti', '9876543210', '']],
    headerMap: mapHeaders(['First Name', 'Mobile Number', 'Preferred Language']).map,
    findExisting: () => ({ byReference: null, byPhone: { id: 7, version: '12' } })
  });
  assert.equal(language.updates.length, 0);
  assert.match(language.problems[0].messages.join(' '), /Preferred language is required/);
});

test('different reference and phone matches are a row conflict', () => {
  const p = buildImportPlan({
    rows: [['REF-1', 'Aarti', '9876543210']],
    headerMap: mapHeaders(['Reference ID', 'First Name', 'Mobile Number']).map,
    findExisting: () => ({
      byReference: { id: 7, version: '12' },
      byPhone: { id: 8, version: '4' }
    })
  });
  assert.equal(p.updates.length, 0);
  assert.match(p.problems[0].messages.join(' '), /different patients/i);
});

test('duplicate update targets and duplicate create references are rejected', () => {
  const updates = buildImportPlan({
    rows: [['One', '9876543210'], ['Two', '9876543210']],
    headerMap: mapHeaders(['First Name', 'Mobile Number']).map,
    findExisting: () => ({ byReference: null, byPhone: { id: 7, version: '12' } })
  });
  assert.equal(updates.updates.length, 1);
  assert.match(updates.problems[0].messages.join(' '), /patient appears more than once/i);

  const creates = buildImportPlan({
    rows: [['REF-1', 'One', '9876543210'], ['ref-1', 'Two', '9876543211']],
    headerMap: mapHeaders(['Reference ID', 'First Name', 'Mobile Number']).map
  });
  assert.equal(creates.creates.length, 1);
  assert.match(creates.problems[0].messages.join(' '), /reference.*more than once/i);
});

test('protected fields are ignored even in a directly supplied internal header map', () => {
  const p = buildImportPlan({
    rows: [['Aarti', '9876543210', 'active', 'granted', 0]],
    headerMap: { 0: 'first_name', 1: 'phone', 2: 'status', 3: 'consent_status', 4: 'do_not_call' },
    findExisting: () => ({ byReference: null, byPhone: { id: 7, version: '12' } })
  });
  assert.deepStrictEqual(Object.keys(p.updates[0].patch).sort(), ['first_name', 'normalized_phone', 'phone']);
});
