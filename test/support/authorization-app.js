'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');
const express = require('express');
const auth = require('../../src/auth');

const root = path.join(__dirname, '../..');

// Execute real route registrations, replacing only handler bodies/external
// dependencies. A bypass is observable without executing calls or DB writes.
function createAuthorizationApp(publicBaseUrl = 'http://localhost:3000') {
  const reached = [];
  const hit = (label) => (req, res) => {
    reached.push(label);
    res.status(204).end();
  };
  const router = (name) => express.Router().use(hit(name));
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'src/api-routes.js'), 'utf8'), {
    module,
    process: { env: {} },
    require(name) {
      if (name === './icallmate-webhook') {
        const webhook = require('../../src/icallmate-webhook');
        return { ...webhook, hasValidIcallMateWebhookSecret: req => webhook.hasValidIcallMateWebhookSecret(req, { ICALLMATE_WEBHOOK_SECRET: 'synthetic-authorization-provider-secret' }) };
      }
      if (name === '../routes/support-tickets') return () => router(name);
      if (name.startsWith('../routes/')) return router(name);
      if (name === '../services/slack-support') return { createSlackSupportNotifier: () => () => {} };
      // The route handler bodies are not invoked. No transitive application
      // imports, dotenv reads, DB clients, provider clients or timers occur.
      return {};
    }
  }, { filename: 'src/api-routes.js' });
  const mountRoutes = (app) => {
    const registration = new Proxy(app, {
      get(target, key) {
        if (['get', 'post', 'put', 'patch', 'delete'].includes(key)) {
          return (route, ...handlers) => target[key](route, ...handlers.slice(0, -1), hit(`${key} ${route}`));
        }
        return typeof target[key] === 'function' ? target[key].bind(target) : target[key];
      }
    });
    module.exports(registration);
  };
  const authenticate = (req, res, next) => {
    const role = req.headers['x-test-role'];
    if (!['ADMIN', 'AGENT'].includes(role)) return res.status(401).json({ error: 'Authentication required' });
    req.adminSession = { username: 'synthetic-user', role };
    next();
  };
  let server;
  const dependencies = {
    dotenv: { config() {} },
    express,
    http,
    path,
    helmet: require('helmet'),
    'express-rate-limit': require('express-rate-limit'),
    './src/config': { PUBLIC_BASE_URL: publicBaseUrl },
    './src/auth': { ...auth, requireAdminAuth: authenticate, basicAuth: authenticate },
    './src/authorization': require('../../src/authorization'),
    './src/api-routes': mountRoutes,
    './src/websocket-bridge': () => {},
    './src/server': value => { server = value; }
  };
  // Bootstrap's dotenv call is inert; the real module is never loaded.
  vm.runInNewContext(fs.readFileSync(path.join(root, 'index.js'), 'utf8'), {
    __dirname: root,
    console,
    require(name) {
      if (name === './src/app') return require('../../src/app');
      if (!Object.hasOwn(dependencies, name)) throw new Error(`Unexpected bootstrap import: ${name}`);
      return dependencies[name];
    }
  }, { filename: 'index.js' });
  if (!server) throw new Error('Bootstrap did not construct its server');
  return { server, reached };
}

async function serveAuthorizationApp(t, publicBaseUrl) {
  const fixture = createAuthorizationApp(publicBaseUrl);
  await new Promise((resolve, reject) => {
    fixture.server.once('error', reject);
    fixture.server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise(resolve => fixture.server.close(resolve)));
  fixture.request = (method, requestPath, role) => new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port: fixture.server.address().port,
      method, path: requestPath,
      headers: { ...(role ? { 'x-test-role': role } : {}),
        ...(method === 'POST' && requestPath === '/api/icallmate/callback' ? { 'x-webhook-secret': 'synthetic-authorization-provider-secret' } : {}) }
    }, res => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.setTimeout(3000, () => req.destroy(new Error('Synthetic HTTP request timed out')));
    req.on('error', reject);
    req.end();
  });
  return fixture;
}

module.exports = { serveAuthorizationApp };
