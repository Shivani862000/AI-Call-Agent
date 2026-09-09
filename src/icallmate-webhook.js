/**
 * src/icallmate-webhook.js
 * Provider-compatible callback URL generation and request authentication.
 */

'use strict';

const crypto = require('crypto');

const CALLBACK_PATH = '/api/icallmate/callback';

function getIcallMateWebhookSecret(env = process.env) {
  return String(env.ICALLMATE_WEBHOOK_SECRET || env.WEBHOOK_SECRET || '').trim();
}

function buildIcallMateCallbackUrl(baseUrl, env = process.env) {
  const normalizedBaseUrl = String(baseUrl || '').trim();
  if (!normalizedBaseUrl) {
    throw new Error('A public base URL is required for the iCallMate callback');
  }

  const url = new URL(CALLBACK_PATH, `${normalizedBaseUrl.replace(/\/+$/, '')}/`);
  const secret = getIcallMateWebhookSecret(env);
  if (secret) {
    url.searchParams.set('secret', secret);
  }
  return url.toString();
}

function redactIcallMateCallbackUrl(value) {
  const rawUrl = String(value || '').trim();
  if (!rawUrl) {
    return rawUrl;
  }

  try {
    const url = new URL(rawUrl);
    if (url.searchParams.has('secret')) {
      url.searchParams.set('secret', '[redacted]');
    }
    return url.toString();
  } catch (error) {
    return '[invalid-callback-url]';
  }
}

function hasValidIcallMateWebhookSecret(req, env = process.env) {
  const expected = getIcallMateWebhookSecret(env);
  const value = req?.headers?.['x-webhook-secret'] || req?.query?.secret;
  const supplied = typeof value === 'string' ? value.trim() : '';
  if (!expected || !supplied) {
    return false;
  }

  const expectedBuffer = Buffer.from(expected, 'utf8');
  const suppliedBuffer = Buffer.from(supplied, 'utf8');
  return expectedBuffer.length === suppliedBuffer.length
    && crypto.timingSafeEqual(expectedBuffer, suppliedBuffer);
}

function requireLegacyCallWebhook(req, res, next) {
  // Enable only after confirming the provider can supply the configured secret.
  if (String(process.env.ENABLE_LEGACY_CALL_WEBHOOKS || '').toLowerCase() !== 'true') {
    return res.status(404).json({ error: 'Endpoint not found' });
  }
  if (!hasValidIcallMateWebhookSecret(req)) {
    return res.status(401).json({ error: 'Invalid webhook credentials' });
  }
  next();
}

// Reject before mutation, including authenticated callers. Unknown scalar fields
// remain ignored for compatibility; nested values and oversized bodies do not.
function validateCallback(req, res, next) {
  try {
    const { validateRecordingUrl } = require('../services/recording-fetch');
    const references = new Set(['RecordingUrl', 'recording_url', 'recording_filename']);
    const timestamps = new Set(['call_start_time', 'call_ansd_time', 'call_end_time', 'timestamp']);
    for (const input of [req.body, req.query]) {
      if (input === undefined) continue;
      if (!input || typeof input !== 'object' || Array.isArray(input)
          || Buffer.byteLength(JSON.stringify(input)) > 16384 || Object.keys(input).length > 64) throw new Error();
      for (const [key, value] of Object.entries(input)) {
        if (key.length > 64 || !(typeof value === 'string' || (typeof value === 'number' && Number.isSafeInteger(value)))) throw new Error();
        if (String(value).length > (references.has(key) ? 4096 : 256) || /[\x00-\x1f\x7f]/.test(String(value))) throw new Error();
        // Bracket-encoded duplicate/structured fields must not become ignored aliases.
        if (/[\[\]]/.test(key)) throw new Error();
        if (references.has(key) && value !== '') validateRecordingUrl(value);
        if (timestamps.has(key) && value !== '') {
          if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})?$/.test(value)) throw new Error();
          const date = new Date(value.replace(' ', 'T'));
          const [year, month, day] = value.slice(0, 10).split('-').map(Number);
          if (!Number.isFinite(date.getTime()) || month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()) throw new Error();
        }
      }
    }
    next();
  } catch {
    return res.status(400).json({ error: 'Invalid callback payload' });
  }
}

module.exports = {
  CALLBACK_PATH,
  getIcallMateWebhookSecret,
  buildIcallMateCallbackUrl,
  redactIcallMateCallbackUrl,
  hasValidIcallMateWebhookSecret,
  requireLegacyCallWebhook,
  validateCallback
};
