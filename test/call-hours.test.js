'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { hourInCallTimezone } = require('../src/helpers');

// The containers run UTC. Every getHours() check was therefore five and a half
// hours out: "no calls before 7am" blocked calls until 12:30 IST and allowed
// them until 2:30 in the morning. This is read explicitly so the rule cannot
// depend on an ambient TZ being set correctly.
const isBlocked = (iso) => {
  const hour = hourInCallTimezone(new Date(iso));
  return hour < 7 || hour >= 21;
};

test('the hour is read where the patients are, not where the server is', () => {
  assert.equal(hourInCallTimezone(new Date('2026-09-07T04:05:00Z')), 9);
  assert.equal(hourInCallTimezone(new Date('2026-09-07T18:30:00Z')), 0);
  assert.equal(hourInCallTimezone(new Date('2026-09-07T18:29:00Z')), 23);
});

test('calling is allowed through the Indian working day', () => {
  assert.equal(isBlocked('2026-09-07T01:30:00Z'), false, '07:00 IST');
  assert.equal(isBlocked('2026-09-07T04:05:00Z'), false, '09:35 IST');
  assert.equal(isBlocked('2026-09-07T12:00:00Z'), false, '17:30 IST');
  assert.equal(isBlocked('2026-09-07T15:29:00Z'), false, '20:59 IST');
});

// The old behaviour would have phoned donors at one in the morning.
test('calling is blocked overnight in India', () => {
  assert.equal(isBlocked('2026-09-07T15:30:00Z'), true, '21:00 IST');
  assert.equal(isBlocked('2026-09-07T18:30:00Z'), true, '00:00 IST');
  assert.equal(isBlocked('2026-09-07T20:00:00Z'), true, '01:30 IST');
  assert.equal(isBlocked('2026-09-07T01:29:00Z'), true, '06:59 IST');
});

// A UTC server would read 09:35 IST as 04:05 and refuse to call.
test('the result does not depend on the server timezone', () => {
  const morningInIndia = new Date('2026-09-07T04:05:00Z');
  assert.equal(hourInCallTimezone(morningInIndia, 'Asia/Kolkata'), 9);
  assert.equal(hourInCallTimezone(morningInIndia, 'UTC'), 4);
  assert.equal(isBlocked('2026-09-07T04:05:00Z'), false);
});
