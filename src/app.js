'use strict';

const express = require('express');
const path = require('node:path');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { createAuthorizationRouter, ADMIN_ONLY_HTML } = require('./authorization');

// Construction does not load configuration, connect services or start jobs.
function createApp({ publicBaseUrl, auth, mountApiRoutes }) {
  const PUBLIC_BASE_URL = publicBaseUrl;
  const app = express();
  app.set('trust proxy', 1);

  app.disable('x-powered-by');
  // Helmet emits `upgrade-insecure-requests` by default, which tells the browser
  // to rewrite every subresource and fetch to https://. On a deployment served
  // over plain HTTP that upgrades requests to a port nothing listens on, so the
  // page loads but its scripts and API calls fail with "Failed to fetch".
  // Emitted only when we are actually served over TLS.
  const SERVES_OVER_HTTPS = /^https:/i.test(String(PUBLIC_BASE_URL || ''));

  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        scriptSrcAttr: ["'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:", "blob:"],
        connectSrc: ["'self'", "ws:", "wss:"],
        mediaSrc: ["'self'", "data:", "blob:"],
        ...(SERVES_OVER_HTTPS ? {} : { upgradeInsecureRequests: null })
      }
    },
    // HSTS on a plain-HTTP deployment would pin the browser to https for a year
    // against a host that cannot serve it.
    hsts: SERVES_OVER_HTTPS,
    crossOriginEmbedderPolicy: false
  }));

  const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, message: { error: 'Too many login attempts' } });
  const apiLimiter = rateLimit({ windowMs: 60 * 1000, max: 60, message: { error: 'Too many requests' } });
  const webhookLimiter = rateLimit({ windowMs: 60 * 1000, max: 300, message: { error: 'Too many webhook requests' } });

  app.use('/api/auth/login', loginLimiter);
  app.use('/api/auth/change-password', loginLimiter);
  app.use('/call/start', apiLimiter);
  app.use('/api/test-call', apiLimiter);
  app.use('/api/test-ai-call', apiLimiter);
  app.use('/api/customers/csv', apiLimiter);
  app.use('/api/icallmate/callback', webhookLimiter);

  // Basic Middleware
  app.use(express.json({ limit: '256kb' }));
  app.use(express.urlencoded({ extended: false, limit: '64kb' }));

  app.use(createAuthorizationRouter(auth));

  const publicRoot = path.join(__dirname, '..', 'public');
  const noStore = (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    next();
  };
  for (const page of auth.PROTECTED_HTML_PATHS) {
    const guards = [auth.requireAdminAuth];
    if (ADMIN_ONLY_HTML.has(page)) guards.push(auth.requireRole('ADMIN'));
    app.get(page, noStore, ...guards, (req, res) => {
      if (page === '/incoming-calls.html') return res.status(404).send('Incoming Calls page is disabled.');
      return res.sendFile(page.slice(1), { root: publicRoot });
    });
  }
  app.get('/login.html', (req, res) => res.sendFile('login.html', { root: publicRoot }));
  app.get('/components/new-call-modal.html', noStore, auth.requireAdminAuth,
    (req, res) => res.sendFile('components/new-call-modal.html', { root: publicRoot }));

  // sendFile above chooses a fixed authorized filename. Generic static serving
  // must not decode a different spelling into an otherwise protected HTML file.
  const assets = express.static(publicRoot, { index: false, redirect: false });
  app.use((req, res, next) => {
    let decoded;
    try { decoded = decodeURIComponent(req.path); }
    catch { return res.status(400).json({ error: 'Invalid request path' }); }
    if (!/\.(?:css|js|svg|png|jpe?g|gif|ico|webp|woff2?|ttf)$/i.test(decoded)) return next();
    return assets(req, res, next);
  });

  mountApiRoutes(app);
  app.use((req, res) => res.status(404).json({ error: 'Endpoint not found' }));
  app.use((err, req, res, next) => {
    const reqId = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    console.error(`[SERVER ERROR] reqId=${reqId}`, err);
    res.status(err.status || 500).json({ error: 'An internal server error occurred. Please try again later.', reqId });
  });
  return app;
}

module.exports = createApp;
