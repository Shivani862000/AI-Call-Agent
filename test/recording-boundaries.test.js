'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { servePrivacyApp } = require('./support/privacy-app');

function pipelineModule(fetch, recording, transcribe = async () => '', fileSystem = fs) {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../services/post-call-pipeline.js'), 'utf8'), {
    module, exports: module.exports, fetch, Buffer, process, console,
    require(name) {
      if (name === 'fs') return fileSystem;
      if (['path', 'node:os', 'node:stream/promises'].includes(name)) return require(name);
      if (name === './recording-fetch') return recording || require('../services/recording-fetch');
      if (name === './system-logger') return { info() {}, warn() {} };
      if (name === './supabase-storage') return { isStorageConfigured: () => false };
      if (name === './gemini') return { transcribeAudioFile: transcribe };
      return {};
    }
  });
  return module.exports;
}

test('pipeline refuses arbitrary stored recording URLs before any network access', async () => {
  const requests = [];
  const mod = pipelineModule(async url => { requests.push(url); throw Error('synthetic stop'); });
  await assert.rejects(mod.processCompletedCallPipeline({ callId: 1,
    dbGet: async () => ({ id: 1, recording_url: 'https://evil.invalid/a', provider_call_id: 'synthetic' }),
    dbRun: async () => ({ changes: 1 }) }));
  assert.deepEqual(requests, []);
});

test('authenticated playback refuses arbitrary stored URLs before network access', async t => {
  const requests = [];
  const app = await servePrivacyApp(t, { dbGet: () => ({ id: 1, recording_url: 'https://evil.invalid/a' }),
    fetch: async url => { requests.push(url); throw Error('synthetic stop'); }, console: { ...console, error() {} } });
  const response = await app.request('GET', '/api/calls/1/recording', app.auth.createAuthToken('operator', 'ADMIN'));
  assert.equal(response.status, 502);
  assert.equal(response.headers['cache-control'], 'private, no-store');
  assert.deepEqual(requests, []);
});

test('authenticated callbacks reject structured identifiers and invalid times before effects', async t => {
  const app = await servePrivacyApp(t, { env: { ICALLMATE_WEBHOOK_SECRET: 'synthetic', ENABLE_LEGACY_CALL_WEBHOOKS: 'true' }, console: { ...console, log() {}, error() {} } });
  for (const payload of [{ ref_no: ['abc'] }, { call_status: {} }, { call_end_time: 'yesterday-ish' }, { recording_filename: ['https://evil.invalid'] }]) {
    const response = await app.request('POST', '/api/icallmate/callback?secret=synthetic', null, payload);
    assert.equal(response.status, 400);
  }
  assert.equal((await app.request('GET', '/call/status?secret=synthetic&CallSid[]=abc')).status, 400);
  assert.deepEqual(app.effects, []);
  assert.equal(app.config.incomingCallState.size, 0);
});

module.exports = { pipelineModule };

const { fixture, storageFixture } = require('./support/recording-fixtures');
const { PassThrough } = require('node:stream');

test('ADMIN playback streams through the real policy and signing; AGENT and anonymous requests have no effects', async t => {
  const f = fixture();
  const storage = storageFixture();
  let stored = false;
  const app = await servePrivacyApp(t, { recording: f, storage: storage.storage,
    dbGet: () => stored ? { id: 1, recording_object_key: 'calls/1/audio one.mp3', recording_status: 'stored' } : { id: 1, recording_url: 'https://media.example/a' } });
  const token = app.auth.createAuthToken('operator', 'ADMIN');
  let response = await app.request('GET', '/api/calls/1/recording', token);
  assert.equal(response.status, 200);
  assert.equal(response.body, 'audio');
  assert.equal(response.headers['cache-control'], 'private, no-store');
  assert.equal(f.requests.length, 1);
  stored = true;
  response = await app.request('GET', '/api/calls/1/recording', token);
  assert.equal(response.status, 302);
  assert.equal(response.headers.location, 'https://storage.example/storage/v1/object/sign/call-recordings/calls/1/audio%20one.mp3?token=synthetic');
  assert.equal(response.headers['cache-control'], 'private, no-store');
  assert.equal(storage.effects.length, 1);
  app.effects.length = 0;
  app.account.role = 'AGENT';
  app.auth.invalidateAccountCache('operator');
  for (const auth of [undefined, app.auth.createAuthToken('operator', 'AGENT')]) {
    response = await app.request('GET', '/api/calls/1/recording', auth);
    assert.ok([401, 403].includes(response.status));
    assert.equal(response.headers['cache-control'], 'private, no-store');
  }
  assert.deepEqual(app.effects, []);
  assert.equal(f.requests.length, 1);
  assert.equal(storage.effects.length, 1);
});

test('HEAD does no retrieval/signing and browser disconnect destroys the real upstream', async t => {
  const body = new PassThrough();
  const f = fixture({ responses: [{ body }] });
  let stored = false;
  const storage = storageFixture();
  const app = await servePrivacyApp(t, { recording: f, storage: storage.storage,
    dbGet: () => stored ? { recording_object_key: 'calls/1/audio one.mp3', recording_status: 'stored' } : { recording_url: 'https://media.example/a' }, console: { ...console, error() {} } });
  const token = app.auth.createAuthToken('operator', 'ADMIN');
  for (stored of [false, true]) assert.equal((await app.request('HEAD', '/api/calls/1/recording', token)).status, 200);
  assert.equal(f.requests.length, 0);
  assert.equal(storage.effects.length, 0);
  stored = false;
  const closed = new Promise(resolve => body.once('close', resolve));
  body.write('first audio');
  assert.equal((await app.request('GET', '/api/calls/1/recording', token, null, { disconnectOnData: true })).body, 'first audio');
  await closed;
  assert.ok(body.destroyed);
  assert.ok(f.requests[0].req.destroyed);
});

test('pipeline streams into unique owned files independent of provider ID and removes partial failures', async t => {
  const paths = [];
  t.after(async () => { for (const file of paths) await fs.promises.rm(path.dirname(file), { recursive: true, force: true }); });
  const f = fixture();
  const mod = pipelineModule(() => { throw Error('unbounded fetch'); }, f, async file => {
    paths.push(file);
    assert.equal(await fs.promises.readFile(file, 'utf8'), 'audio');
    assert.equal((await fs.promises.stat(file)).mode & 0o777, 0o600);
    return '';
  });
  const run = mod => mod.processCompletedCallPipeline({ callId: 1,
    dbGet: async () => ({ id: 1, recording_url: 'https://media.example/a', provider_call_id: '../../same-identifier' }), dbRun: async () => ({ changes: 1 }) });
  await run(mod); await run(mod);
  assert.equal(paths.length, 2);
  assert.notEqual(paths[0], paths[1]);
  assert.ok(paths.every(file => path.basename(file) === 'audio.mp3' && !file.includes('same-identifier')));
  const dirs = [];
  const fileSystem = { ...fs, promises: { ...fs.promises, async mkdtemp(prefix) { const dir = await fs.promises.mkdtemp(prefix); dirs.push(dir); return dir; } } };
  const oversized = fixture({ responses: [{ chunks: [Buffer.alloc(20)] }], env: { RECORDING_MAX_BYTES: '10' } });
  await assert.rejects(run(pipelineModule(undefined, oversized, undefined, fileSystem)), /Recording unavailable/);
  assert.equal(dirs.length, 1);
  assert.ok(!fs.existsSync(dirs[0]));
});

test('authenticated legacy metadata preserves complete URL query and invalid URLs have no effects', async t => {
  const writes = [];
  const app = await servePrivacyApp(t, { env: { ICALLMATE_WEBHOOK_SECRET: 'synthetic', ENABLE_LEGACY_CALL_WEBHOOKS: 'true', RECORDING_ALLOWED_ORIGINS: 'https://media.example' },
    dbGet: sql => sql.includes('FROM calls') ? { id: 1 } : null, dbRun: async (sql, params) => { writes.push(params); }, console: { ...console, log() {}, error() {} } });
  const full = 'https://media.example/recording.mp3?token=keep-this';
  assert.equal((await app.request('POST', '/call/recording-status?secret=synthetic', null, { CallSid: 'abc', RecordingUrl: full, RecordingStatus: 'pending' })).status, 200);
  assert.equal(writes[0][1], full);
  app.effects.length = 0;
  for (const payload of [{ RecordingUrl: 'http://127.0.0.1/a' }, { RecordingUrl: {} }, { RecordingSid: ['a'] }, { call_end_time: '2026-02-30T12:00:00Z' }, { CallSid: 'a'.repeat(257) }, { extra: 'x'.repeat(17000) }]) {
    assert.equal((await app.request('POST', '/call/recording-status?secret=synthetic', null, payload)).status, 400);
  }
  assert.deepEqual(app.effects, []);
  assert.equal(writes.length, 1);
  assert.equal((await app.request('POST', '/api/icallmate/callback', null, { ref_no: {} })).status, 401);
});
