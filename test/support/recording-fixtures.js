'use strict';
const { PassThrough, Readable, Writable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { EventEmitter } = require('node:events');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { createRecordingFetcher } = require('../../services/recording-fetch');
function fixture({ addresses = ['93.184.216.34'], responses = [{}], env = {}, lookup } = {}) {
  const requests = [], bodies = [];
  const fetchRecording = createRecordingFetcher({
    env: { RECORDING_ALLOWED_ORIGINS: 'https://media.example', ...env },
    lookup: lookup || (async () => addresses.map(address => ({ address, family: address.includes(':') ? 6 : 4 }))),
    request(options, cb) {
      const req = new EventEmitter();
      req.destroy = () => { req.destroyed = true; };
      req.end = () => {
        const spec = responses[Math.min(requests.length - 1, responses.length - 1)];
        const body = spec.body || Readable.from(spec.chunks || [Buffer.from('audio')]);
        Object.assign(body, { statusCode: spec.status || 200, headers: { 'content-type': 'audio/mpeg', ...spec.headers }, rawHeaders: spec.rawHeaders || [] });
        bodies.push(body);
        queueMicrotask(() => cb(body));
      };
      requests.push({ options, req });
      return req;
    }
  });
  return { fetchRecording, requests, bodies };
}
async function consume(recording) {
  let result = '';
  await pipeline(recording.stream, new Writable({ write(c, enc, cb) { result += c; cb(); } }));
  return result;
}

function storageFixture({ signedURL = '/object/sign/call-recordings/calls/1/audio%20one.mp3?token=synthetic', body, status = 200, base = 'https://storage.example/storage/v1', fetchResponse, schedule = setTimeout } = {}) {
  const effects = [], module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../services/supabase-storage.js'), 'utf8'), {
    module, exports: module.exports, URL, Buffer, AbortController, setTimeout: schedule, clearTimeout,
    process: { env: {} },
    require: name => name === 'node:fs'
      ? require('node:fs')
      : ({ resolveStorageUrl: () => base, resolveServiceRoleKey: () => 'synthetic-secret' }),
    fetch: async (url, options) => { effects.push({ url, options }); if (fetchResponse) return fetchResponse(url, options); return new Response(body || JSON.stringify({ signedURL }), { status, headers: { 'content-type': 'application/json' } }); }
  });
  return { storage: module.exports, effects };
}

module.exports = { fixture, consume, storageFixture };
