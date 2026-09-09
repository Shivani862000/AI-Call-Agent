'use strict';

const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const tls = require('node:tls');

function isLoopback(host) {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost';
}

function hostFromArgs(args) {
  const first = args[0];
  if (typeof first === 'object' && first) return first.hostname || first.host || 'localhost';
  if (typeof first === 'number') return typeof args[1] === 'string' ? args[1] : 'localhost';
  return first;
}

function denyUnlessLoopback(original, label) {
  return function guardedConnection(...args) {
    const host = hostFromArgs(args);
    if (!isLoopback(host)) throw new Error(`Test provider egress blocked (${label}): ${host}`);
    return original.apply(this, args);
  };
}

net.connect = denyUnlessLoopback(net.connect, 'net');
net.createConnection = net.connect;
tls.connect = denyUnlessLoopback(tls.connect, 'tls');
http.request = denyUnlessLoopback(http.request, 'http');
https.request = denyUnlessLoopback(https.request, 'https');

const originalFetch = globalThis.fetch;
if (originalFetch) {
  globalThis.fetch = function guardedFetch(input, init) {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (!isLoopback(url.hostname)) throw new Error(`Test provider egress blocked (fetch): ${url.hostname}`);
    return originalFetch(input, init);
  };
}

function createProviderFakes() {
  const calls = [];
  return {
    calls,
    fetch: async (url, options = {}) => {
      calls.push({ url: String(url), options });
      return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
    }
  };
}

module.exports = { createProviderFakes, isLoopback };
