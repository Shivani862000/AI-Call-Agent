/**
 * src/helpers.js
 * Pure utility functions used across the application.
 */

'use strict';

const {
  PUBLIC_BASE_URL,
  HAS_CONFIGURED_PUBLIC_BASE_URL,
  CALL_TYPES,
  CALL_DIAGNOSTIC_WARN_MS,
  liveCallState,
  incomingCallState,
  pendingCallDiagnostics,
  LIVE_CALL_RETENTION_MS,
  LIVE_CALL_ACTIVE_STALE_MS,
  INCOMING_CALL_RETENTION_MS
} = require('./config');

// ── Generic helpers ────────────────────────────────────────────────────────────

function runInBackground(label, work) {
  Promise.resolve()
    .then(() => work())
    .catch((error) => {
      console.error(`[${label}]`, error.message);
    });
}

function pickRequestValue(req, keys = []) {
  for (const key of keys) {
    const bodyValue = req.body?.[key];
    if (bodyValue !== undefined && bodyValue !== null && bodyValue !== '') {
      return bodyValue;
    }

    const queryValue = req.query?.[key];
    if (queryValue !== undefined && queryValue !== null && queryValue !== '') {
      return queryValue;
    }
  }

  return null;
}

function safeJsonParse(value, fallback = null) {
  if (value === null || value === undefined || value === '') {
    return fallback;
  }

  if (typeof value !== 'string') {
    return value;
  }

  try {
    return JSON.parse(value);
  } catch (error) {
    return fallback;
  }
}

// ── Phone normalization ────────────────────────────────────────────────────────

function normalizePhoneLookupValue(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.length === 10) return digits;
  if (digits.length > 10) return digits.slice(-10);
  return digits;
}

// ── XML helpers ────────────────────────────────────────────────────────────────

function xmlEscape(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function buildXmlResponse(innerXml) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n${innerXml}\n</Response>`;
}

// ── URL helpers ────────────────────────────────────────────────────────────────

function toWssUrl(baseUrl, pathName) {
  const url = new URL(baseUrl);
  const pathUrl = new URL(pathName, url.origin);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = pathUrl.pathname;
  url.search = pathUrl.search;
  url.hash = '';
  return url.toString();
}

function getRequestPublicBaseUrl(req) {
  const configuredBaseUrl = String(PUBLIC_BASE_URL || '').trim();
  if (HAS_CONFIGURED_PUBLIC_BASE_URL && /^https?:\/\//i.test(configuredBaseUrl)) {
    return configuredBaseUrl.replace(/\/+$/, '');
  }

  const forwardedHost = String(req.headers['x-forwarded-host'] || '')
    .split(',')[0]
    .trim();
  const host = forwardedHost || String(req.headers.host || '').trim();
  if (!host) {
    return PUBLIC_BASE_URL;
  }

  const forwardedProto = String(req.headers['x-forwarded-proto'] || '')
    .split(',')[0]
    .trim()
    .toLowerCase();
  const proto = forwardedProto || (req.secure ? 'https' : 'http');
  return `${proto}://${host}`.replace(/\/$/, '');
}

function getSecurePublicBaseUrl() {
  const baseUrl = String(PUBLIC_BASE_URL || '').trim();
  if (!baseUrl) {
    return '';
  }

  return baseUrl.replace(/^http:\/\//i, 'https://');
}

// ── Date / time helpers ────────────────────────────────────────────────────────

function getLocalDateKey(now = new Date()) {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function shouldTriggerOwnerDigest(now = new Date()) {
  const hour = now.getHours();
  const minute = now.getMinutes();
  return hour === 8 && minute < 10;
}

function normalizeIcallTimestamp(value) {
  const text = String(value || '').trim();
  if (!text) {
    return new Date().toISOString();
  }

  const normalized = text.includes('T') ? text : text.replace(' ', 'T');
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) {
    return new Date().toISOString();
  }

  return date.toISOString();
}

// ── Call type normalization ────────────────────────────────────────────────────

function normalizeOutboundCallType(value) {
  const normalized = String(value || CALL_TYPES.REVIEW_CALL).trim().toUpperCase();
  if (['REVIEW', 'REVIEW_CALLING'].includes(normalized)) return CALL_TYPES.REVIEW_CALL;
  if (['THREE_MONTH', 'THREE_MONTH_FOLLOW_UP', '3_MONTH_FOLLOWUP', '3_MONTH_FOLLOW_UP'].includes(normalized)) {
    return CALL_TYPES.THREE_MONTH_FOLLOWUP;
  }
  return Object.values(CALL_TYPES).includes(normalized) ? normalized : CALL_TYPES.REVIEW_CALL;
}

function formatOutboundCallTypeLabel(value) {
  return normalizeOutboundCallType(value) === CALL_TYPES.THREE_MONTH_FOLLOWUP
    ? '3 Month Follow-up'
    : 'Review Calling';
}

function normalizeCallDirection(value, fallback = 'incoming') {
  const normalized = String(value || '').trim().toLowerCase();
  if (['outbound', 'outgoing', 'obd'].includes(normalized)) {
    return 'outbound';
  }
  if (['inbound', 'incoming', 'ibd'].includes(normalized)) {
    return 'incoming';
  }
  return fallback;
}

// ── iCallMate extra params parsing ─────────────────────────────────────────────

function parseIcallMateExtraParams(value) {
  const text = String(value || '').trim();
  if (!text) {
    return {};
  }

  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (error) {
    return {};
  }
}

function getIncomingCallKey(message = {}) {
  return String(message.streamId || message.ChKey || message.callerId || `${Date.now()}`).trim();
}

// ── Agent template ─────────────────────────────────────────────────────────────

function applyAgentTemplate(template, replacements = {}) {
  return String(template || '').replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi, (_, key) => {
    return replacements[key] ?? '';
  });
}

// ── Transcript helpers ─────────────────────────────────────────────────────────

function printTranscript(transcript) {
  console.log('\n════════════════════════════════════');
  console.log('         CALL TRANSCRIPT');
  console.log('════════════════════════════════════');

  transcript.forEach((turn) => {
    console.log(`[${turn.role}] (${turn.time})`);
    console.log(`  ${turn.text}\n`);
  });

  console.log('════════════════════════════════════\n');
}

function pushTranscriptTurn(transcript, role, text) {
  if (!text || !String(text).trim()) {
    return;
  }

  const nextText = String(text).trim();
  const nowIso = new Date().toISOString();
  const lastTurn = transcript[transcript.length - 1];

  if (lastTurn && lastTurn.role === role) {
    lastTurn.text = `${lastTurn.text} ${nextText}`.replace(/\s+/g, ' ').trim();
    lastTurn.time = nowIso;
    return;
  }

  transcript.push({
    role,
    text: nextText,
    time: nowIso
  });
}

function buildTranscriptPreviewText(text, maxLines = 4) {
  const lines = String(text || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.slice(-maxLines).join('\n');
}

// ── Call diagnostics ───────────────────────────────────────────────────────────

function schedulePendingCallDiagnostic(callSid, context = {}) {
  if (!callSid) {
    return;
  }

  const previous = pendingCallDiagnostics.get(callSid);
  if (previous?.timer) {
    clearTimeout(previous.timer);
  }

  const record = {
    ...previous,
    ...context,
    callSid,
    acceptedAt: new Date().toISOString(),
    voicebotHitAt: previous?.voicebotHitAt || null,
    statusHitAt: previous?.statusHitAt || null,
    streamHitAt: previous?.streamHitAt || null
  };

  record.timer = setTimeout(() => {
    const latest = pendingCallDiagnostics.get(callSid);
    if (!latest) {
      return;
    }

    console.warn(
      `[CALL DIAGNOSTIC WARNING] sid=${callSid} customerId=${latest.customerId || ''} ` +
      `phone=${latest.customerPhone || ''} voicebotHit=${latest.voicebotHitAt ? 'yes' : 'no'} ` +
      `streamHit=${latest.streamHitAt ? 'yes' : 'no'} statusHit=${latest.statusHitAt ? 'yes' : 'no'} ` +
      `publicBaseUrl=${PUBLIC_BASE_URL} icallmateMediaUrl=${toWssUrl(PUBLIC_BASE_URL, '/icallmate/media')}`
    );
  }, CALL_DIAGNOSTIC_WARN_MS);

  pendingCallDiagnostics.set(callSid, record);
}

function markPendingCallDiagnostic(callSid, patch = {}) {
  if (!callSid) {
    return;
  }

  const current = pendingCallDiagnostics.get(callSid) || { callSid };
  pendingCallDiagnostics.set(callSid, {
    ...current,
    ...patch,
    callSid
  });
}

// ── State pruning ──────────────────────────────────────────────────────────────

function pruneLiveCallState(now = Date.now()) {
  for (const [callSid, row] of liveCallState.entries()) {
    const startedAt = new Date(row?.started_at || 0).getTime();
    if (!startedAt || Number.isNaN(startedAt)) {
      liveCallState.delete(callSid);
      continue;
    }

    const ageMs = now - startedAt;
    if (row?.status === 'active' && ageMs > LIVE_CALL_ACTIVE_STALE_MS) {
      liveCallState.delete(callSid);
      continue;
    }

    if (row?.status !== 'active' && ageMs > LIVE_CALL_RETENTION_MS) {
      liveCallState.delete(callSid);
    }
  }
}

function pruneIncomingCallState(now = Date.now()) {
  for (const [key, row] of incomingCallState.entries()) {
    const updatedAt = new Date(row?.updated_at || row?.received_at || 0).getTime();
    if (!updatedAt || Number.isNaN(updatedAt) || (now - updatedAt) > INCOMING_CALL_RETENTION_MS) {
      incomingCallState.delete(key);
    }
  }
}

module.exports = {
  runInBackground,
  pickRequestValue,
  safeJsonParse,
  normalizePhoneLookupValue,
  xmlEscape,
  buildXmlResponse,
  toWssUrl,
  getRequestPublicBaseUrl,
  getSecurePublicBaseUrl,
  getLocalDateKey,
  shouldTriggerOwnerDigest,
  normalizeIcallTimestamp,
  normalizeOutboundCallType,
  formatOutboundCallTypeLabel,
  normalizeCallDirection,
  parseIcallMateExtraParams,
  getIncomingCallKey,
  applyAgentTemplate,
  printTranscript,
  pushTranscriptTurn,
  buildTranscriptPreviewText,
  schedulePendingCallDiagnostic,
  markPendingCallDiagnostic,
  pruneLiveCallState,
  pruneIncomingCallState
};
