'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { resolveStorageOrigin } = require('../src/config');

const SUPABASE_ENV = {
  NODE_ENV: 'production',
  SUPABASE_URL: 'postgresql://postgres.zedslcznathmuaetllgn:pw@aws-0-ap-south-1.pooler.supabase.com:5432/postgres'
};

test('resolveStorageOrigin derives the Storage host from the connection string', () => {
  assert.strictEqual(resolveStorageOrigin(SUPABASE_ENV), 'https://zedslcznathmuaetllgn.supabase.co');
});

test('resolveStorageOrigin honours an explicit API url', () => {
  assert.strictEqual(
    resolveStorageOrigin({ SUPABASE_API_URL: 'https://example.supabase.co/' }),
    'https://example.supabase.co'
  );
});

test('resolveStorageOrigin is empty when nothing is configured', () => {
  assert.strictEqual(resolveStorageOrigin({}), '');
});

test('CSP media-src allows the Storage host', () => {
  // /api/calls/:id/recording answers with a 302 to a signed Storage URL. CSP is
  // re-applied to the redirect target, so `media-src 'self'` alone blocks the
  // audio and the player fails with MEDIA_ELEMENT_ERROR (code 4).
  const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  const mediaSrc = /mediaSrc:\s*\[(.*?)\]/s.exec(source);
  assert.ok(mediaSrc, 'index.js should declare a mediaSrc directive');
  assert.match(mediaSrc[1], /STORAGE_ORIGIN/);
});

test('the analysis page only renders a player when a recording exists', () => {
  // Rendering an <audio> for every call points it at an endpoint that 404s, so
  // every call looks like a broken recording.
  const page = fs.readFileSync(path.join(__dirname, '..', 'public', 'feedback-analysis.html'), 'utf8');
  assert.doesNotMatch(page, /hasRecording\s*=\s*true/);
  assert.match(page, /recording_object_key|recording_status/);
});
