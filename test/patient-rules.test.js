'use strict';
const test = require('node:test');
const assert = require('node:assert');
const {
  maskPhone, maskEmail, serializePatient, attemptedContactWrites,
  normalizePatientPayload, validatePatientPayload
} = require('../src/patient-rules');

const ROW = {
  id: 1, first_name: 'Aarti', last_name: 'Gupta',
  phone: '+91 98765 43210', normalized_phone: '9876543210',
  email: 'Aarti.Gupta@Example.IN', preferred_language: 'hi'
};

test('phone masking keeps only the last four digits, at constant width', () => {
  assert.strictEqual(maskPhone('9876543210'), '••••••3210');
  // Same person, three ways of writing the number: one mask.
  assert.strictEqual(maskPhone('+91 98765 43210'), '••••••3210');
  assert.strictEqual(maskPhone('09876543210'), '••••••3210');
  assert.strictEqual(maskPhone('+1 555 000 3210'), '••••••3210',
    'mask width must not reveal how many digits the number has');
});

test('short and empty numbers never leak', () => {
  assert.strictEqual(maskPhone('123'), '••••');
  assert.strictEqual(maskPhone(''), '');
  assert.strictEqual(maskPhone(null), '');
  assert.ok(!maskPhone('123').match(/\d/), 'a sub-4-digit number must be fully masked');
});

test('email masking reveals one letter and the tld', () => {
  assert.strictEqual(maskEmail('aarti.gupta@example.in'), 'a•••@•••.in');
  assert.strictEqual(maskEmail(''), '');
});

test('an agent response contains no recoverable contact data', () => {
  const out = serializePatient(ROW, 'AGENT');
  const serialized = JSON.stringify(out);
  assert.ok(!('phone' in out), 'phone must be absent, not blanked');
  assert.ok(!('email' in out), 'email must be absent, not blanked');
  assert.ok(!('normalized_phone' in out));
  assert.ok(!serialized.includes('98765'), 'no fragment of the number may survive');
  assert.ok(!serialized.includes('aarti.gupta@'), 'no fragment of the email may survive');
  assert.strictEqual(out.phone_masked, '••••••3210');
  assert.strictEqual(out.full_name, 'Aarti Gupta');
});

test('an admin response keeps the real values', () => {
  const out = serializePatient(ROW, 'ADMIN');
  assert.strictEqual(out.phone, '+91 98765 43210');
  assert.strictEqual(out.email, 'Aarti.Gupta@Example.IN');
  assert.strictEqual(out.phone_masked, '••••••3210');
});

test('contact writes are detectable so they can be rejected', () => {
  assert.deepStrictEqual(attemptedContactWrites({ first_name: 'X' }), []);
  assert.deepStrictEqual(attemptedContactWrites({ phone: '9' }), ['phone']);
  assert.deepStrictEqual(attemptedContactWrites({ phone: '9', email: 'a@b.co' }), ['phone', 'email']);
  assert.deepStrictEqual(attemptedContactWrites({ email: '' }), ['email'], 'clearing a contact is still a write');
});

test('payload normalisation lowercases email and canonicalises the phone', () => {
  const p = normalizePatientPayload({ first_name: ' Aarti ', phone: '+91 98765 43210', email: 'A@B.IN' });
  assert.strictEqual(p.first_name, 'Aarti');
  assert.strictEqual(p.normalized_phone, '9876543210');
  assert.strictEqual(p.email, 'a@b.in');
  assert.strictEqual(p.preferred_language, 'hi');
  assert.strictEqual(p.blood_group, 'unknown');
});

test('enums fall back rather than reaching the database invalid', () => {
  const p = normalizePatientPayload({ first_name: 'X', phone: '9876543210', preferred_language: 'fr', gender: 'yes', blood_group: 'Z+', status: 'deleted' });
  assert.strictEqual(p.preferred_language, 'hi');
  assert.strictEqual(p.gender, 'unknown');
  assert.strictEqual(p.blood_group, 'unknown');
  assert.strictEqual(p.status, 'active');
});

test('validation catches what a non-technical user gets wrong', () => {
  const bad = validatePatientPayload(normalizePatientPayload({ phone: '12345', email: 'not-an-email', preferred_call_slot: '25:00' }));
  assert.match(bad.first_name, /required/);
  assert.match(bad.phone, /valid 10-digit/);
  assert.match(bad.email, /valid email/);
  assert.match(bad.preferred_call_slot, /24-hour/);
});

test('future and impossible dates are rejected', () => {
  const bad = validatePatientPayload(normalizePatientPayload({
    first_name: 'X', phone: '9876543210',
    last_donation_date: '2099-01-01', date_of_birth: '2026-02-30'
  }));
  assert.match(bad.last_donation_date, /future/);
  assert.match(bad.date_of_birth, /real date/);
});

test('a valid record produces no errors', () => {
  const ok = validatePatientPayload(normalizePatientPayload({
    first_name: 'Aarti', phone: '+919876543210', email: 'a@b.in',
    preferred_call_slot: '10:00', last_donation_date: '2026-01-15'
  }));
  assert.deepStrictEqual(ok, {});
});
