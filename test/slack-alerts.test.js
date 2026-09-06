'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createSlackAlerter } = require('../services/slack-alerts');
const { sanitizeLogDetails } = require('../services/system-logger');

function recorder({ ok = true } = {}) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, text: JSON.parse(options.body).text });
    return { ok, status: ok ? 200 : 500 };
  };
  return { calls, fetchImpl };
}

const clock = (start = 0) => { let t = start; return { now: () => t, advance: (ms) => { t += ms; } }; };

test('nothing is sent when no webhook is configured', async () => {
  const alert = createSlackAlerter({ webhookUrl: '' });
  assert.deepEqual(await alert({ event: 'BOOM' }), { delivered: false, skipped: true });
});

test('an alert reaches the webhook with its level and event', async () => {
  const { calls, fetchImpl } = recorder();
  const alert = createSlackAlerter({ webhookUrl: 'https://hooks.example/x', fetchImpl });

  await alert({ level: 'ERROR', event: 'CALL_FAILED', details: { callId: 7 } });

  assert.equal(calls.length, 1);
  assert.match(calls[0].text, /\*ERROR\* CALL_FAILED/);
  assert.match(calls[0].text, /callId=7/);
});

// Slack is a third party and a chat history is permanent, so patient data must
// never reach it. The alerter reuses the sanitiser the system log already uses.
test('patient data never reaches Slack', async () => {
  const { calls, fetchImpl } = recorder();
  const alert = createSlackAlerter({
    webhookUrl: 'https://hooks.example/x', fetchImpl, sanitize: sanitizeLogDetails
  });

  await alert({
    event: 'PIPELINE_FAILED',
    details: {
      patient: 'Ankita Sharma',
      phone: '+919876543210',
      transcript: 'CUSTOMER: bahut achha tha',
      apiKey: 'sk-live-secret',
      callId: 12
    }
  });

  const { text } = calls[0];
  assert.doesNotMatch(text, /Ankita/);
  assert.doesNotMatch(text, /9876543210/);
  assert.doesNotMatch(text, /bahut achha/);
  assert.doesNotMatch(text, /sk-live-secret/);
  assert.match(text, /callId=12/, 'the useful, non-identifying detail should survive');
});

// A failure loop must not become a Slack flood.
test('a repeated event is alerted once per cooldown', async () => {
  const { calls, fetchImpl } = recorder();
  const time = clock();
  const alert = createSlackAlerter({
    webhookUrl: 'https://hooks.example/x', fetchImpl, now: time.now, repeatCooldownMs: 1000
  });

  for (let i = 0; i < 5; i += 1) await alert({ event: 'DB_DOWN' });
  assert.equal(calls.length, 1);

  time.advance(1001);
  await alert({ event: 'DB_DOWN' });
  assert.equal(calls.length, 2);
  assert.match(calls[1].text, /4 further occurrences suppressed/);
});

test('different events are not suppressed by each other', async () => {
  const { calls, fetchImpl } = recorder();
  const alert = createSlackAlerter({ webhookUrl: 'https://hooks.example/x', fetchImpl });

  await alert({ event: 'ONE' });
  await alert({ event: 'TWO' });
  assert.equal(calls.length, 2);
});

test('a hard ceiling stops a flood even from varied events', async () => {
  const { calls, fetchImpl } = recorder();
  const time = clock();
  const alert = createSlackAlerter({
    webhookUrl: 'https://hooks.example/x', fetchImpl, now: time.now, maxPerWindow: 3, windowMs: 1000
  });

  for (let i = 0; i < 10; i += 1) await alert({ event: `EVENT_${i}` });
  assert.equal(calls.length, 3);

  time.advance(1001);
  await alert({ event: 'AFTER_WINDOW' });
  assert.equal(calls.length, 4);
});

// This is called from the logger. An alerting failure that threw would take out
// the code path it was reporting on.
test('a Slack outage never throws', async () => {
  const warnings = [];
  const alert = createSlackAlerter({
    webhookUrl: 'https://hooks.example/x',
    fetchImpl: async () => { throw new Error('network down'); },
    logger: { warn: (...args) => warnings.push(args) }
  });

  const result = await alert({ event: 'ANY' });
  assert.equal(result.delivered, false);
  assert.match(result.error, /network down/);
  assert.equal(warnings.length, 1);
});

test('a non-2xx response is treated as a failure, not a success', async () => {
  const { fetchImpl } = recorder({ ok: false });
  const alert = createSlackAlerter({
    webhookUrl: 'https://hooks.example/x', fetchImpl, logger: { warn() {} }
  });

  const result = await alert({ event: 'ANY' });
  assert.equal(result.delivered, false);
  assert.match(result.error, /500/);
});
