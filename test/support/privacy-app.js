'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');
const express = require('express');
const createApp = require('../../src/app');

const root = path.resolve(__dirname, '../..');

// Run real authentication, registration and response shaping. The allowlist
// prevents application configuration/DB/provider imports from reaching UAT.
async function servePrivacyApp(t, options = {}) {
  let now = Date.parse('2026-09-08T10:00:00Z');
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const effects = [];
  const accounts = new Map();
  const account = { username: 'operator', role: 'ADMIN', is_active: 1, password_changed_at: null };
  accounts.set('operator', account);
  const fail = label => () => { effects.push(label); throw new Error(`Forbidden test effect: ${label}`); };
  const config = {
    PUBLIC_BASE_URL: 'http://localhost', CALL_TYPES: {},
    liveCallState: new Map(), incomingCallState: new Map(), pendingCallDiagnostics: new Map(),
    LIVE_CALL_RETENTION_MS: 3600000, LIVE_CALL_ACTIVE_STALE_MS: 3600000,
    INCOMING_CALL_RETENTION_MS: 3600000
  };
  const db = {
    async dbGet(sql, params) {
      if (sql.includes('FROM users WHERE lower(username)')) {
        if (options.accountError) throw new Error('Synthetic account lookup unavailable');
        return accounts.get(params[0]) || null;
      }
      effects.push('dbGet');
      return options.dbGet ? options.dbGet(sql, params) : null;
    },
    async dbAll(sql, params) {
      effects.push('dbAll');
      return options.dbAll ? options.dbAll(sql, params) : [];
    },
    dbRun: options.dbRun || fail('dbRun'), dbTx: fail('dbTx')
  };
  const stubs = {
    './config': config, '../db': db, fs: { existsSync: fail('filesystem') },
    '../services/slack-support': { createSlackSupportNotifier: () => fail('notification') },
    './call-management': {}, './scripted-ivr': {}, './prompt-builder': {},
    '../services/call-orchestration': { createSupervisorEvent: fail('supervisor mutation') },
    '../services/call-analysis': { buildCallAnalysis: options.buildCallAnalysis || (() => ({})) },
    '../services/icallmate': { initiateCall: fail('provider') },
    '../services/post-call-pipeline': { processCompletedCallPipeline: fail('pipeline') },
    '../services/system-logger': { info() {}, warn() {}, error() {} },
    '../services/pdf': { generateCallAnalysisPDF: fail('pdf') },
    '../services/supabase-storage': options.storage || { createSignedUrl: fail('signed URL') },
    '../services/recording-fetch': { ...require('../../services/recording-fetch'), validateRecordingUrl: value => require('../../services/recording-fetch').validateRecordingUrl(value, options.env || {}), ...options.recording }
  };
  const files = new Set(['src/auth.js', 'src/api-routes.js', 'src/helpers.js',
    'src/patient-rules.js', 'src/contact-policy.js', 'src/call-serialization.js', 'src/icallmate-webhook.js']);
  const modules = new Map();
  function load(relative) {
    if (modules.has(relative)) return modules.get(relative).exports;
    if (!files.has(relative)) throw new Error(`Unexpected test module: ${relative}`);
    const module = { exports: {} };
    modules.set(relative, module);
    vm.runInNewContext(fs.readFileSync(path.join(root, relative), 'utf8'), {
      module, exports: module.exports, Buffer, URL, Date: Clock, console: options.console || console,
      process: { env: { NODE_ENV: 'test', AUTH_SIGNING_SECRET: 'synthetic-privacy-test-signing-secret-at-least-32-bytes', ...options.env } },
      setTimeout: fail('timer'), AbortController, fetch: options.fetch || fail('network'),
      require(name) {
        if (name === 'crypto' || name === 'bcrypt' || name === 'node:stream/promises') return require(name);
        if (Object.hasOwn(stubs, name)) return stubs[name];
        if (name === '../routes/support-tickets') return () => express.Router();
        if (name.startsWith('../routes/')) return express.Router();
        return load(path.relative(root, path.resolve(root, path.dirname(relative), name + '.js')));
      }
    }, { filename: relative });
    return module.exports;
  }
  const auth = load('src/auth.js');
  const server = http.createServer(createApp({ publicBaseUrl: config.PUBLIC_BASE_URL, auth,
    mountApiRoutes: load('src/api-routes.js') }));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  function request(method, target, token, payload, { disconnectOnData = false } = {}) {
    return new Promise((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port: server.address().port,
        method, path: target, headers: { ...(token ? { cookie: `${auth.AUTH_COOKIE_NAME}=${token}` } : {}), ...(payload ? { 'content-type': 'application/json' } : {}) }
      }, res => {
        let text = '';
        res.on('data', chunk => { text += chunk; if (disconnectOnData) { req.destroy(); resolve({ status: res.statusCode, headers: res.headers, body: text }); } });
        res.on('end', () => {
          let body;
          try { body = JSON.parse(text); } catch { body = text; }
          resolve({ status: res.statusCode, headers: res.headers, body });
        });
      });
      req.setTimeout(3000, () => req.destroy(new Error('Synthetic request timed out')));
      req.on('error', reject);
      req.end(payload ? JSON.stringify(payload) : undefined);
    });
  }
  return { request, auth, account, accounts, effects, config, advance: ms => { now += ms; }, load };
}

module.exports = { servePrivacyApp };
