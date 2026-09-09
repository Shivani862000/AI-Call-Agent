'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough, Readable, Writable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { EventEmitter } = require('node:events');
const { createRecordingFetcher } = require('../services/recording-fetch');

const { fixture, consume } = require('./support/recording-fixtures');

test('streams allowed audio through a pinned isolated TLS request', async () => {
  let lookups = 0;
  const f = fixture({ lookup: async () => { lookups++; return [{ address: lookups === 1 ? '93.184.216.34' : '127.0.0.1', family: 4 }]; } });
  assert.equal(await consume(await f.fetchRecording('https://media.example/a?token=secret')), 'audio');
  const opts = f.requests[0].options;
  assert.equal(opts.hostname, 'media.example');
  assert.equal(opts.servername, 'media.example');
  assert.equal(opts.rejectUnauthorized, true);
  assert.equal(opts.agent, false);
  const answer = await new Promise((resolve, reject) => opts.lookup('media.example', {}, (err, address, family) => err ? reject(err) : resolve({ address, family })));
  assert.deepEqual(answer, { address: '93.184.216.34', family: 4 });
  assert.equal(lookups, 1);
  assert.equal(opts.headers.Authorization, undefined);
});

test('rejects malformed, credential-bearing, literal and non-exact origins before DNS/network', async () => {
  let dnsCalls = 0;
  const f = fixture({ lookup: async () => { dnsCalls++; return [{ address: '93.184.216.34', family: 4 }]; } });
  for (const url of ['https:media.example/a', 'https:///media.example/a', 'https://@media.example/a', 'http://media.example/a', 'https://evil.example/a', 'https://media.example:444/a', 'https://media.example.evil/a', 'https://u:p@media.example/a', 'https://127.0.0.1/a', 'https://[::1]/a', 'file:///tmp/a', 'https://media.example/a#x', ' https://media.example/a']) {
    await assert.rejects(f.fetchRecording(url), /Recording unavailable/);
  }
  assert.equal(f.requests.length, 0);
  assert.equal(dnsCalls, 0);
  await assert.rejects(fixture({ env: { RECORDING_ALLOWED_ORIGINS: '' } }).fetchRecording('https://media.example/a'));
});

test('rejects all special addresses and mixed DNS answers before connecting', async () => {
  for (const address of ['0.1.2.3', '10.0.0.1', '100.64.0.1', '127.0.0.2', '169.254.169.254', '172.16.0.1', '192.168.0.1', '192.0.0.9', '192.0.2.1', '192.88.99.1', '198.18.0.1', '198.51.100.1', '203.0.113.1', '224.0.0.1', '255.255.255.255', '::', '::1', '::ffff:127.0.0.1', '::ffff:8.8.8.8', '::ffff:808:808', '64:ff9b::808:808', '64:ff9b:1::1', '100::1', '2001::1', '2001:db8::1', '2002:0808:0808::1', '3fff::1', 'fc00::1', 'fe80::1', 'ff02::1']) {
    const f = fixture({ addresses: ['93.184.216.34', address] });
    await assert.rejects(f.fetchRecording('https://media.example/a'), /Recording unavailable/, address);
    assert.equal(f.requests.length, 0, address);
  }
  assert.equal(await consume(await fixture({ addresses: ['2606:4700:4700::1111'] }).fetchRecording('https://media.example/a')), 'audio');
});

test('redirects default deny; opt-in validates every hop and caps loops at three', async () => {
  const responses = [{ status: 302, headers: { location: '/next' } }, {}];
  const deny = fixture({ responses });
  await assert.rejects(deny.fetchRecording('https://media.example/a'));
  assert.equal(deny.requests.length, 1);
  assert.ok(deny.bodies[0].destroyed);
  const allow = fixture({ responses, env: { RECORDING_ALLOW_REDIRECTS: 'true' } });
  assert.equal(await consume(await allow.fetchRecording('https://media.example/a')), 'audio');
  const evil = fixture({ responses: [{ status: 302, headers: { location: 'https://evil.example/x' } }], env: { RECORDING_ALLOW_REDIRECTS: 'true' } });
  await assert.rejects(evil.fetchRecording('https://media.example/a'));
  assert.equal(evil.requests.length, 1);
  const loop = fixture({ responses: [responses[0]], env: { RECORDING_ALLOW_REDIRECTS: 'true' } });
  await assert.rejects(loop.fetchRecording('https://media.example/a'));
  assert.equal(loop.requests.length, 4);
});

test('rejects unsupported MIME, compression, duplicate/conflicting and oversized lengths', async () => {
  for (const spec of [{ headers: { 'content-type': 'text/html' } }, { headers: { 'content-encoding': 'gzip' } }, { headers: { 'content-length': '20' } }, { headers: { 'content-length': '5', 'transfer-encoding': 'chunked' } }, { rawHeaders: ['Content-Length', '5', 'Content-Length', '6'] }, { headers: { 'content-length': '1, 2' } }]) {
    const f = fixture({ responses: [spec], env: { RECORDING_MAX_BYTES: '10' } });
    await assert.rejects(f.fetchRecording('https://media.example/a'));
    assert.ok(f.bodies[0].destroyed);
  }
});

test('bounds streaming bytes without Content-Length and rejects truncated bodies', async () => {
  for (const spec of [{ chunks: [Buffer.alloc(6), Buffer.alloc(6)] }, { headers: { 'content-length': '8' }, chunks: [Buffer.from('short')] }]) {
    const f = fixture({ responses: [spec], env: { RECORDING_MAX_BYTES: '10' } });
    await assert.rejects(consume(await f.fetchRecording('https://media.example/a')), /Recording unavailable/);
    assert.ok(f.bodies[0].destroyed);
  }
});

test('deadline includes DNS, prevents late DNS connection, and destroys slow body', async () => {
  let resolveDns;
  const f = fixture({ lookup: () => new Promise(resolve => { resolveDns = resolve; }), env: { RECORDING_TIMEOUT_MS: '20' } });
  await assert.rejects(f.fetchRecording('https://media.example/a'));
  resolveDns([{ address: '93.184.216.34', family: 4 }]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.requests.length, 0);
  const body = new PassThrough();
  const slow = fixture({ responses: [{ body }], env: { RECORDING_TIMEOUT_MS: '20' } });
  await assert.rejects(consume(await slow.fetchRecording('https://media.example/a')));
  assert.ok(body.destroyed);
});

test('caller cancellation destroys body and request; invalid lower-limit settings fail closed', async () => {
  const controller = new AbortController();
  const body = new PassThrough();
  const f = fixture({ responses: [{ body }] });
  const result = await f.fetchRecording('https://media.example/a', { signal: controller.signal });
  controller.abort();
  await assert.rejects(consume(result));
  assert.ok(body.destroyed);
  assert.ok(f.requests[0].req.destroyed);
  for (const env of [{ RECORDING_MAX_BYTES: '0' }, { RECORDING_MAX_BYTES: '26214401' }, { RECORDING_TIMEOUT_MS: '30001' }, { RECORDING_TIMEOUT_MS: 'oops' }, { RECORDING_ALLOW_REDIRECTS: 'yes' }, { RECORDING_ALLOWED_ORIGINS: 'https://media.example/path' }]) {
    const invalid = fixture({ env });
    await assert.rejects(invalid.fetchRecording('https://media.example/a'));
    assert.equal(invalid.requests.length, 0);
  }
});


test('upstream driver errors are sanitized and downstream backpressure stops reads', async () => {
  const body = new PassThrough();
  const f = fixture({ responses: [{ body }] });
  const recording = await f.fetchRecording('https://media.example/a');
  const completed = consume(recording);
  body.destroy(new Error('driver leaked https://media.example/a?token=secret'));
  await assert.rejects(completed, error => error.message === 'Recording unavailable');

  let produced = 0;
  const source = new Readable({ read() { produced++; this.push(Buffer.alloc(16384)); } });
  const backpressure = fixture({ responses: [{ body: source }] });
  const unconsumed = await backpressure.fetchRecording('https://media.example/a');
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(produced < 100, 'an unconsumed playback must not buffer the whole recording');
  unconsumed.cancel();
});

test('redirect hop revalidates DNS and timeout destroys a pending connector', async () => {
  let lookups = 0;
  const redirected = fixture({ env: { RECORDING_ALLOW_REDIRECTS: 'true' },
    lookup: async () => [{ address: ++lookups === 1 ? '93.184.216.34' : '127.0.0.1', family: 4 }], responses: [{ status: 302, headers: { location: '/next' } }] });
  await assert.rejects(redirected.fetchRecording('https://media.example/a'));
  assert.equal(redirected.requests.length, 1);
  let destroyed = false;
  const waiting = createRecordingFetcher({ env: { RECORDING_ALLOWED_ORIGINS: 'https://media.example', RECORDING_TIMEOUT_MS: '20' }, lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    request() { const req = new EventEmitter(); req.end = () => {}; req.destroy = () => { destroyed = true; }; return req; } });
  await assert.rejects(waiting('https://media.example/a'));
  assert.ok(destroyed);
});
