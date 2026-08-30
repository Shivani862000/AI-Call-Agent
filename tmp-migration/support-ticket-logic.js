'use strict';

const TICKET_TYPES = Object.freeze({ BUG: 'BUG', IDEA: 'IDEA', QUESTION: 'QUESTION' });
const TICKET_STATUS = Object.freeze({ NEW: 'NEW', IN_PROGRESS: 'IN_PROGRESS', RESOLVED: 'RESOLVED' });
const PREFIX = Object.freeze({ BUG: 'BUG', IDEA: 'IDEA', QUESTION: 'QUES' });

function createTicketId(type, sequence) {
  if (!PREFIX[type] || !Number.isInteger(Number(sequence)) || Number(sequence) < 1) throw new Error('Invalid ticket ID');
  return `${PREFIX[type]}-${Number(sequence)}`;
}

function routeTitle(pathname) {
  const titles = { '/admin.html': 'Overview', '/customers.html': 'Outbound Calls', '/feedback.html': 'Feedback', '/support-tickets.html': 'Support Tickets' };
  return titles[pathname] || 'Application page';
}

function sanitizeSupportContext(input = {}) {
  let url;
  try { url = new URL(String(input.pageUrl || ''), 'http://localhost'); } catch { url = new URL('http://localhost/'); }
  const width = Math.min(10000, Math.max(320, Number(input.viewport?.width) || 320));
  const height = Math.min(10000, Math.max(320, Number(input.viewport?.height) || 320));
  return {
    pageUrl: `${url.origin}${url.pathname}`,
    pageTitle: routeTitle(url.pathname),
    browser: String(input.browser || '').slice(0, 80),
    os: String(input.os || '').slice(0, 80),
    device: ['desktop', 'mobile', 'tablet'].includes(input.device) ? input.device : 'desktop',
    viewport: { width, height },
    submittedAt: new Date().toISOString(),
    screenshotAllowed: input.screenshotAllowed === true
  };
}

function validateSubmission(body = {}) {
  const type = String(body.type || 'BUG').toUpperCase();
  const description = redactSensitiveText(String(body.description || '').trim());
  if (!Object.values(TICKET_TYPES).includes(type)) throw new Error('Invalid ticket type');
  if (!description || description.length > 4000) throw new Error('Description must be between 1 and 4000 characters');
  return { type, description, context: sanitizeSupportContext(body.context) };
}

function redactSensitiveText(value) {
  return String(value || '')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[redacted email]')
    .replace(/\b(?:\+?91[-\s]?)?[6-9]\d{9}\b/g, '[redacted phone]')
    .replace(/\b(?:patient|customer|name|dob|date of birth|mrn|medical record|diagnosis|condition)\s*[:=-]\s*[^\n,.]{1,120}/gi, '$1: [redacted]')
    .replace(/\b(?:api[_ -]?key|token|password|authorization)\s*[:=-]\s*[^\s,]{1,200}/gi, '$1: [redacted]');
}

module.exports = { TICKET_TYPES, TICKET_STATUS, createTicketId, sanitizeSupportContext, validateSubmission, redactSensitiveText };
