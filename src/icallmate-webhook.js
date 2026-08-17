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
  const supplied = String(req?.headers?.['x-webhook-secret'] || req?.query?.secret || '').trim();
  if (!expected || !supplied) {
    return false;
  }

  const expectedBuffer = Buffer.from(expected, 'utf8');
  const suppliedBuffer = Buffer.from(supplied, 'utf8');
  return expectedBuffer.length === suppliedBuffer.length
    && crypto.timingSafeEqual(expectedBuffer, suppliedBuffer);
}

module.exports = {
  CALLBACK_PATH,
  getIcallMateWebhookSecret,
  buildIcallMateCallbackUrl,
  redactIcallMateCallbackUrl,
  hasValidIcallMateWebhookSecret
};
