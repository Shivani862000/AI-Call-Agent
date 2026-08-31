'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { validateSetting, CALL_TYPES } = require('../src/app-settings');
const { createSettingsStore } = require('../src/app-settings');

const rule = (overrides = {}) => ({
  id: 'r', enabled: true, service: 'donation', min_days_since: 90,
  call_type: 'THREE_MONTH_FOLLOWUP', slot: '10:00', ...overrides
});

/** The defaults, read the way the app reads them. */
async function defaults(key) {
  const store = createSettingsStore({ dbGet: async () => null, dbRun: async () => {} });
  return store.get(key);
}

// The rule that fires 90 days after a donation placed a REVIEW_CALL, which opens
// "aapne kal blood donate kiya tha, aapka experience kaisa raha?" -- a question
// about yesterday, asked of someone who last donated three months ago.
test('the 90-day donation rule places the three-month follow-up', async () => {
  const config = await defaults('auto_queue');
  const followUp = config.rules.find((r) => r.id === 'donation-followup');

  assert.equal(followUp.call_type, 'THREE_MONTH_FOLLOWUP');
  assert.equal(followUp.min_days_since, 90);
  assert.equal(followUp.service, 'donation');
});

// There is no yearly script; the rule would place the three-month call, which
// opens by saying three months have passed.
test('the yearly reminder is off until a script exists for it', async () => {
  const config = await defaults('auto_queue');
  assert.equal(config.rules.find((r) => r.id === 'annual-reminder').enabled, false);
});

// Automatic calling stays off until someone switches it on deliberately.
test('automatic queueing is off by default', async () => {
  assert.equal((await defaults('auto_queue')).enabled, false);
});

// An unrecognised call type falls through to REVIEW_CALL, so a rule would
// quietly place a different call from the one it names.
test('a rule cannot name a call that does not exist', () => {
  assert.equal(validateSetting('auto_queue', { rules: [rule()] }), null);

  for (const bad of ['REVIEW_CAL', 'FOLLOWUP', '', undefined]) {
    const problem = validateSetting('auto_queue', { rules: [rule({ call_type: bad })] });
    assert.match(String(problem), /call type must be one of/, `accepted call type: ${bad}`);
  }
});

test('both real call types are accepted', () => {
  for (const type of CALL_TYPES) {
    assert.equal(validateSetting('auto_queue', { rules: [rule({ call_type: type })] }), null);
  }
});
