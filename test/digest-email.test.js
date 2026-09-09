'use strict';
const test = require('node:test');
const assert = require('node:assert');

const { renderDigest } = require('../services/digest-email');

const BASE = 'https://uat.kcpathlab.in';

const call = (over = {}) => ({
  id: 252,
  patient_name: 'Ramesh Kumar',
  customer_phone: '+919812345210',
  outcome: 'completed',
  called_at: '2026-09-08T13:12:00.000Z',
  answered_at: '2026-09-08T13:12:04.000Z',
  ended_at: '2026-09-08T13:15:16.000Z',
  summary: 'Happy with collection, report was late.',
  has_transcript: true,
  has_recording: true,
  ...over
});

const feedback = (over = {}) => ({
  id: 85,
  call_id: 252,
  patient_name: 'Ramesh Kumar',
  category: 'good',
  stars: 4,
  review_text: 'Staff was polite.',
  source: 'call',
  submitted_at: '2026-09-08T13:20:00.000Z',
  ...over
});

const base = (over = {}) => ({
  windowHours: 24,
  timezone: 'Asia/Kolkata',
  generatedAt: '2026-09-09T02:30:00.000Z',
  baseUrl: BASE,
  calls: [],
  feedback: [],
  alerts: [],
  expectedVisitors: [],
  roi: {},
  ...over
});

test('an answered call is listed with its name, outcome and summary', () => {
  const { html, text } = renderDigest(base({ calls: [call()] }));
  for (const out of [html, text]) {
    assert.match(out, /Ramesh Kumar/);
    assert.match(out, /Happy with collection/);
  }
});

test('transcript and recording links point at the call, one per section anchor', () => {
  const { html } = renderDigest(base({ calls: [call()] }));
  assert.match(html, new RegExp(`${BASE}/feedback-analysis\\.html\\?callId=252#transcriptSection`));
  assert.match(html, new RegExp(`${BASE}/feedback-analysis\\.html\\?callId=252#recordingSection`));
});

test('a missing recording says so instead of linking to a 404', () => {
  const { html, text } = renderDigest(base({ calls: [call({ has_recording: false })] }));
  assert.doesNotMatch(html, /#recordingSection/);
  assert.match(html, /Recording not captured/);
  assert.match(text, /Recording not captured/);
});

test('without a configured base url no links are emitted at all', () => {
  // Better no link than a localhost link that dies in the owner's inbox.
  const { html, text } = renderDigest(base({ baseUrl: '', calls: [call()] }));
  assert.doesNotMatch(html, /href="http/);
  assert.doesNotMatch(html, /localhost/);
  assert.doesNotMatch(text, /localhost/);
  assert.match(html, /Ramesh Kumar/);
});

test('patient text is escaped, not injected', () => {
  const nasty = '<script>alert(1)</script> & "quoted"';
  const { html } = renderDigest(base({
    calls: [call({ patient_name: nasty })],
    feedback: [feedback({ review_text: nasty })]
  }));
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&amp;/);
});

test('phone numbers are masked', () => {
  const { html, text } = renderDigest(base({ calls: [call()] }));
  assert.doesNotMatch(html, /9812345210/);
  assert.doesNotMatch(text, /9812345210/);
});

test('unanswered calls are rolled up rather than given a card each', () => {
  const calls = [
    call(),
    call({ id: 330, patient_name: 'Anjali Mehta', outcome: 'no-answer', answered_at: null, ended_at: null, summary: '', has_transcript: false, has_recording: false }),
    call({ id: 331, patient_name: 'Vikas Rathi', outcome: 'failed', answered_at: null, ended_at: null, summary: '', has_transcript: false, has_recording: false })
  ];
  const { html } = renderDigest(base({ calls }));
  assert.match(html, /1 not answered, 1 failed/);
  assert.doesNotMatch(html, /callId=330/);
});

test('feedback shows stars when it has them and a category when it does not', () => {
  const { html } = renderDigest(base({
    feedback: [feedback(), feedback({ id: 73, call_id: 143, stars: null, category: 'average', review_text: 'ठीक है' })]
  }));
  assert.match(html, /★{4}/);
  assert.match(html, /Average/i);
  assert.match(html, /ठीक है/);
});

test('feedback with no call carries no link', () => {
  const { html } = renderDigest(base({ feedback: [feedback({ id: 94, call_id: null, source: 'web' })] }));
  assert.doesNotMatch(html, /callId=null/);
  assert.match(html, /Not linked to a call/);
});

test('a day with no calls says so plainly', () => {
  const { html, text } = renderDigest(base());
  assert.match(html, /No calls were placed in the last 24 hours/);
  assert.match(text, /No calls were placed in the last 24 hours/);
  // An empty digest must not read as a broken one.
  assert.doesNotMatch(html, /Rs 0.*Rs 0.*Rs 0/s);
});

test('times are rendered in the configured timezone, not UTC', () => {
  // 13:12 UTC is 18:42 IST.
  const { html } = renderDigest(base({ calls: [call()] }));
  assert.match(html, /18:42/);
});

test('the text alternative is plain text, not markup', () => {
  const { text } = renderDigest(base({ calls: [call()], feedback: [feedback()] }));
  assert.doesNotMatch(text, /<[a-z]/i);
});

test('the settings preview sends the text alternative, not the whole object', () => {
  // buildDigestBody returns { text, html }; the screen assigns the response to
  // textContent, so handing it the object renders "[object Object]".
  const route = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'routes', 'settings.js'), 'utf8'
  );
  assert.match(route, /const \{ text \} = await buildDigestBody\(\)/);
  assert.match(route, /res\.json\(\{ body: text \}\)/);
});
