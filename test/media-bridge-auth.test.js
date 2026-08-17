'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require('ws');

process.env.ICALLMATE_REQUIRE_MEDIA_TOKEN = 'true';
process.env.SYSTEM_LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-call-agent-logs-'));

const setupWebSocketBridge = require('../src/websocket-bridge');

test('media bridge rejects a tokenless WebSocket upgrade', async (t) => {
  const server = http.createServer();
  setupWebSocketBridge(server);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(process.env.SYSTEM_LOG_DIR, { recursive: true, force: true });
  });

  const address = server.address();
  await new Promise((resolve, reject) => {
    const client = new WebSocket(`ws://127.0.0.1:${address.port}/icallmate/media`);
    client.once('unexpected-response', (request, response) => {
      try {
        assert.equal(response.statusCode, 401);
        response.resume();
        resolve();
      } catch (error) {
        reject(error);
      }
    });
    client.once('open', () => reject(new Error('Tokenless media connection unexpectedly opened')));
    client.once('error', (error) => {
      if (!/Unexpected server response: 401/.test(error.message)) reject(error);
    });
  });
});
