'use strict';

const express = require('express');

const ADMIN_ONLY_HTML = new Set([
  '/support-tickets.html', '/users.html', '/settings.html',
  '/feedback.html', '/feedback-analysis.html'
]);

function validateOperationId(req, res, next) {
  if (!/^[1-9][0-9]*$/.test(req.params.id) || !Number.isSafeInteger(Number(req.params.id))) {
    return res.status(400).json({ error: 'A valid positive ID is required' });
  }
  next();
}

function createAuthorizationRouter({ requireAdminAuth, requireRole, basicAuth }) {
  // Use Express's own route matching for permission boundaries, including
  // casing/trailing slashes and unconstrained parameter spellings.
  const router = express.Router({ caseSensitive: false, strict: false });
  const admin = requireRole('ADMIN');
  const publicRoute = (req, res, next) => next('router');

  router.use((req, res, next) => {
    // Nested mounts can consume an extra slash and disagree with outer guards.
    if (req.path.includes('//')) {
      return res.status(400).json({ error: 'Invalid request path' });
    }
    next();
  });

  router.use('/api', (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    next();
  });
  router.get('/api/auth/session', publicRoute);
  router.post(['/api/auth/login', '/api/auth/logout'], publicRoute);
  // The callback handler verifies its provider secret. Other methods and
  // neighboring paths still fall through the authenticated API boundary.
  router.post('/api/icallmate/callback', publicRoute);
  router.get(['/api/icallmate/config', '/icallmate/health'], basicAuth, admin, publicRoute);

  router.use('/api', requireAdminAuth);
  router.use('/call/start', requireAdminAuth, admin);

  // Agents may submit a support ticket, but may not browse/administer tickets.
  router.post('/api/support-tickets', publicRoute);
  router.use([
    '/api/support-tickets', '/api/agents', '/api/users', '/api/settings',
    '/api/feedback', '/api/logs', '/api/test-call', '/api/test-ai-call',
    '/api/icallmate', '/api/patients/import', '/api/customers/csv'
  ], admin);
  router.delete('/api/*', admin);
  router.use('/api/campaigns', (req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD') return next();
    return admin(req, res, next);
  });
  router.post([
    '/api/calls/initiate/:id', '/api/calls/:id/analyze', '/api/calls/:id/escalate'
  ], admin, validateOperationId);
  return router;
}

module.exports = { createAuthorizationRouter, ADMIN_ONLY_HTML };
