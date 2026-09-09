'use strict';

// Copied into the disposable container after image build, never shipped.
// Keep the real media bridge and real local ws transport; redirect only the
// provider boundary to an in-container fake with no external connection.
const fs = require('node:fs');
const { assertOwnedTestDatabase } = require('./database');
assertOwnedTestDatabase(process.env.DATABASE_URL, { ...process.env, NODE_ENV: 'test' }, 'application');
const RealWebSocket = require('ws');
const trace = (event) => fs.appendFileSync('/tmp/runtime-provider-events', `${event}\n`);
const fake = new RealWebSocket.Server({ host: '127.0.0.1', port: 18081 });
fake.on('connection', (socket, request) => {
  trace(request.url);
  socket.on('message', (data) => {
    if (request.url === '/listen') { trace('caller-audio'); return; }
    const message = JSON.parse(data.toString());
    if (message.type === 'Speak') trace('tts-speak');
    if (message.type === 'Flush') {
      trace('tts-audio');
      socket.send(Buffer.alloc(6400, 1));
    }
  });
});
class ProviderWebSocket extends RealWebSocket {
  constructor(url, options) {
    const parsed = new URL(url);
    if (parsed.hostname === 'api.deepgram.com') {
      super(`ws://127.0.0.1:18081/${parsed.pathname.includes('speak') ? 'speak' : 'listen'}`);
    } else {
      if (!['localhost', '127.0.0.1'].includes(parsed.hostname)) throw new Error('unexpected provider WebSocket');
      super(url, options);
    }
  }
}
require.cache[require.resolve('ws')].exports = ProviderWebSocket;
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (url.hostname === 'generativelanguage.googleapis.com') {
    trace('gemini-reply');
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Hello synthetic runtime caller.' }] } }] }),
      { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (!['localhost', '127.0.0.1'].includes(url.hostname)) throw new Error('unexpected provider HTTP request');
  return originalFetch(input, init);
};
