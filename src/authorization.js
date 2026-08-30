/**
 * src/authorization.js
 * Phase 1 role policy for the single-tenant admin and agent accounts.
 */

'use strict';

const ADMIN_ONLY_PREFIXES = [
  '/api/support-tickets',
  '/api/agents',
  '/api/users',
  '/api/feedback',
  '/api/reports',
  '/api/logs',
  '/api/test-call',
  '/api/test-ai-call',
  '/api/icallmate'
];

const ADMIN_ONLY_HTML = new Set([
  '/support-tickets.html',
  '/users.html',
  '/feedback.html',
  '/feedback-analysis.html',
  '/reports.html'
]);

function isAdminOnlyRequest(req) {
  const method = String(req.method || 'GET').toUpperCase();
  const requestPath = String(req.path || '');
  if (method === 'POST' && requestPath === '/api/support-tickets') return false;

  if (requestPath === '/api/icallmate/callback') {
    return false;
  }

  if (ADMIN_ONLY_HTML.has(requestPath)) {
    return true;
  }

  if (requestPath === '/call/start' || requestPath === '/icallmate/health') {
    return true;
  }

  if (ADMIN_ONLY_PREFIXES.some((prefix) => requestPath === prefix || requestPath.startsWith(`${prefix}/`))) {
    return true;
  }

  if (method === 'DELETE' && requestPath.startsWith('/api/')) {
    return true;
  }

  if (requestPath === '/api/customers/csv') {
    return true;
  }

  if (requestPath.startsWith('/api/campaigns') && method !== 'GET') {
    return true;
  }

  if (method === 'POST' && /^\/api\/calls\/initiate\/\d+$/.test(requestPath)) {
    return true;
  }

  if (method === 'POST' && /^\/api\/calls\/\d+\/(analyze|escalate)$/.test(requestPath)) {
    return true;
  }

  return false;
}

module.exports = {
  isAdminOnlyRequest
};
