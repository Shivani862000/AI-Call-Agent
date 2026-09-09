'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const { storageFixture } = require('./support/recording-fixtures');

test('storage treats keys as path segments and constrains returned signed URLs', async () => {
  const f = storageFixture();
  assert.equal(await f.storage.createSignedUrl('calls/1/audio one.mp3'), 'https://storage.example/storage/v1/object/sign/call-recordings/calls/1/audio%20one.mp3?token=synthetic');
  assert.equal(f.effects[0].url, 'https://storage.example/storage/v1/object/sign/call-recordings/calls/1/audio%20one.mp3');
  assert.equal(f.effects[0].options.redirect, 'error');
  assert.ok(f.effects[0].options.signal);
});

test('storage rejects key traversal, URL/query injection and wrong signed origins/paths', async () => {
  for (const key of ['../audio', 'calls/../audio', '/audio', 'https://evil/a', 'a?b', 'a#b', 'a%2fb', 'a\\b', 'a//b', {}, ['a']]) {
    const f = storageFixture();
    await assert.rejects(f.storage.createSignedUrl(key));
    await assert.rejects(f.storage.uploadObject(key, Buffer.from('a'), 'audio/mpeg'));
    await assert.rejects(f.storage.removeObject(key));
    assert.equal(f.effects.length, 0);
  }
  for (const signedURL of ['https://evil.example/storage/v1/object/sign/call-recordings/calls/1/audio%20one.mp3?token=secret', '//evil.example/a', '/object/sign/call-recordings/other?token=x', '/object/sign/call-recordings/calls/1/extra/%2e%2e/audio%20one.mp3?token=x', '/object/sign/call-recordings/calls/1/../audio%20one.mp3?token=x', '/object/sign/call-recordings/calls/1/audio%20one.mp3?token=x&download=evil', '/object/sign/call-recordings/calls/1/audio%20one.mp3?token=x#fragment']) {
    await assert.rejects(storageFixture({ signedURL }).storage.createSignedUrl('calls/1/audio one.mp3'), /Storage request failed/);
  }
});

test('storage response size/status/config errors have fixed diagnostics without provider content', async () => {
  for (const config of [{ body: 'secret-provider-body', status: 500 }, { body: 'x'.repeat(70000) }, { base: 'http://storage.example/storage/v1' }, { base: 'https://storage.example/storage/v1?injected=x' }]) {
    await assert.rejects(storageFixture(config).storage.createSignedUrl('calls/1/audio one.mp3'), /Storage request failed/);
  }
});


test('signing total deadline and caller disconnect cancel slow response bodies', async () => {
  let cancelled = 0;
  const streamResponse = () => new Response(new ReadableStream({ cancel() { cancelled++; } }));
  const f = storageFixture({ fetchResponse: streamResponse, schedule(fn, ms) { assert.equal(ms, 5000); return setTimeout(fn, 20); } });
  await assert.rejects(f.storage.createSignedUrl('calls/1/audio one.mp3'), /Storage request failed/);
  assert.equal(cancelled, 1);
  assert.ok(f.effects[0].options.signal.aborted);
  const controller = new AbortController();
  const disconnected = storageFixture({ fetchResponse: streamResponse });
  const result = disconnected.storage.createSignedUrl('calls/1/audio one.mp3', 60, { signal: controller.signal });
  await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  await assert.rejects(result, /Storage request failed/);
  assert.equal(cancelled, 2);
});
