/**
 * src/config.js
 * All configuration constants, environment variable parsing, validation,
 * and shared in-memory state maps.
 */

'use strict';

// ── Environment-derived constants ──────────────────────────────────────────────

const PORT = Number(process.env.PORT || 3000);
const AI_PROVIDER = String(process.env.AI_PROVIDER || process.env.LLM_PROVIDER || 'gemini').trim().toLowerCase();
const CALL_MODE = AI_PROVIDER;
const GEMINI_MODEL = process.env.GEMINI_MODEL || (AI_PROVIDER === 'gemini-live' ? 'gemini-3.1-flash-live-preview' : 'gemini-2.5-flash');
const GEMINI_VOICE = process.env.GEMINI_VOICE || 'Kore';
const GEMINI_LIVE_THINKING_LEVEL = process.env.GEMINI_LIVE_THINKING_LEVEL || 'minimal';
const GEMINI_LIVE_SILENCE_DURATION_MS = Math.max(Number(process.env.GEMINI_LIVE_SILENCE_DURATION_MS || 600) || 600, 100);
const GEMINI_LIVE_PREFIX_PADDING_MS = Math.max(Number(process.env.GEMINI_LIVE_PREFIX_PADDING_MS || 100) || 100, 20);
const GEMINI_LIVE_DIRECT_AUDIO = String(process.env.GEMINI_LIVE_DIRECT_AUDIO || (AI_PROVIDER === 'gemini-live' ? 'true' : 'false')).toLowerCase() === 'true';
const DEEPGRAM_ENDPOINTING_MS = Math.max(Number(process.env.DEEPGRAM_ENDPOINTING_MS || 220) || 220, 80);
const DEEPGRAM_FINAL_FLUSH_MS = Math.max(Number(process.env.DEEPGRAM_FINAL_FLUSH_MS || 180) || 180, 50);
const LIVE_MAX_RESPONSE_TOKENS = Math.max(Number(process.env.LIVE_MAX_RESPONSE_TOKENS || process.env.GEMINI_MAX_OUTPUT_TOKENS || 180) || 180, 24);
const GEMINI_LIVE_MAX_OUTPUT_TOKENS = Math.max(Number(process.env.GEMINI_LIVE_MAX_OUTPUT_TOKENS || 340) || 340, 64);
const LIVE_TEMPERATURE = Number(process.env.LIVE_TEMPERATURE || process.env.GEMINI_TEMPERATURE || 0.35);
const FINAL_AUDIO_GRACE_MS = Math.max(Number(process.env.FINAL_AUDIO_GRACE_MS || 3000) || 3000, 1000);
const DEEPGRAM_TTS_MODEL = process.env.DEEPGRAM_TTS_MODEL || 'aura-2-thalia-en';
const requestedReverseMediaChunkBytes = Math.min(
  Math.max(Number(process.env.ICALLMATE_REVERSE_MEDIA_CHUNK_BYTES || 1600) || 1600, 640),
  3200
);
const ICALLMATE_REVERSE_MEDIA_CHUNK_BYTES = requestedReverseMediaChunkBytes - (requestedReverseMediaChunkBytes % 2);
const ICALLMATE_REVERSE_MEDIA_INTERVAL_MS = Math.round(ICALLMATE_REVERSE_MEDIA_CHUNK_BYTES / 16);
const REALTIME_MODEL = GEMINI_MODEL;
const MAX_PRECONNECT_MEDIA_CHUNKS = Math.max(Number(process.env.MAX_PRECONNECT_MEDIA_CHUNKS || 60) || 60, 10);
const MAX_PRECONNECT_MEDIA_BYTES = Math.max(Number(process.env.MAX_PRECONNECT_MEDIA_BYTES || 512000) || 512000, 64000);
const CLIENT_NAME = process.env.CLIENT_NAME || 'your diagnostic and medical collection center';
const SERVER_NAME_BASE_URL = process.env.SERVER_NAME ? `https://${String(process.env.SERVER_NAME).replace(/^https?:\/\//i, '').replace(/\/+$/g, '')}` : '';
const CONFIGURED_PUBLIC_BASE_URL = (
  SERVER_NAME_BASE_URL
  || process.env.APP_BASE_URL
  || process.env.NGROK_URL
  || process.env.WEBHOOK_URL
  || ''
).replace(/\/$/, '');
const HAS_CONFIGURED_PUBLIC_BASE_URL = Boolean(CONFIGURED_PUBLIC_BASE_URL);
const PUBLIC_BASE_URL = CONFIGURED_PUBLIC_BASE_URL || `http://localhost:${PORT}`;
const VOICE_PIPELINE = process.env.VOICE_PIPELINE || 'legacy';
const USE_ORCHESTRATED_PIPELINE = VOICE_PIPELINE === 'orchestrated';
const DISABLE_SCHEDULER = String(process.env.DISABLE_SCHEDULER || '').toLowerCase() === 'true';
const DISABLE_OWNER_DIGEST = String(process.env.DISABLE_OWNER_DIGEST || '').toLowerCase() === 'true';
const MAX_CALL_DURATION_SECONDS = Math.max(Number(process.env.MAX_CALL_DURATION_SECONDS || 60) || 60, 10);
const MIN_RETRY_GAP_MINUTES = Math.max(Number(process.env.MIN_RETRY_GAP_MINUTES || 180) || 180, 1);

// ── In-memory state maps (shared across modules) ──────────────────────────────

const liveCallState = new Map();
const incomingCallState = new Map();
const pendingCallDiagnostics = new Map();

// ── Retention / timing constants ───────────────────────────────────────────────

const LIVE_CALL_RETENTION_MS = 20 * 60 * 1000;
const LIVE_CALL_ACTIVE_STALE_MS = 90 * 60 * 1000;
const INCOMING_CALL_RETENTION_MS = 60 * 60 * 1000;
const ICALLMATE_DEFAULT_DID = '8037259753';
const ICALLMATE_DEFAULT_TEST_NUMBER = '+918037259753';
const CALL_DIAGNOSTIC_WARN_MS = Math.max(Number(process.env.CALL_DIAGNOSTIC_WARN_MS || 20000) || 20000, 5000);

// ── Call types ─────────────────────────────────────────────────────────────────

const CALL_TYPES = Object.freeze({
  REVIEW_CALL: 'REVIEW_CALL',
  THREE_MONTH_FOLLOWUP: 'THREE_MONTH_FOLLOWUP'
});

// ── Helpers ────────────────────────────────────────────────────────────────────

function redactSecret(value, visiblePrefix = 4, visibleSuffix = 4) {
  const text = String(value || '').trim();
  if (!text) {
    return '';
  }

  if (text.length <= visiblePrefix + visibleSuffix) {
    return '[set]';
  }

  return `${text.slice(0, visiblePrefix)}…${text.slice(-visibleSuffix)} (len=${text.length})`;
}

function describeEnvValue(value) {
  const text = String(value ?? '');
  return `${JSON.stringify(text)} (len=${text.length})`;
}

function logConfigSnapshot(scope = 'CONFIG') {
  const snapshot = {
    NODE_ENV: process.env.NODE_ENV || '',
    PORT: process.env.PORT || '',
    TZ: process.env.TZ || '',
    CALL_MODE,
    VOICE_PIPELINE,
    AI_PROVIDER,
    REALTIME_MODEL,
    GEMINI_MODEL,
    GEMINI_VOICE,
    GEMINI_LIVE_THINKING_LEVEL,
    GEMINI_LIVE_SILENCE_DURATION_MS,
    GEMINI_LIVE_PREFIX_PADDING_MS,
    DEEPGRAM_ENDPOINTING_MS,
    DEEPGRAM_FINAL_FLUSH_MS,
    LIVE_MAX_RESPONSE_TOKENS,
    GEMINI_LIVE_MAX_OUTPUT_TOKENS,
    LIVE_TEMPERATURE,
    GEMINI_LIVE_DIRECT_AUDIO,
    FINAL_AUDIO_GRACE_MS,
    DEEPGRAM_TTS_MODEL,
    ICALLMATE_REVERSE_MEDIA_CHUNK_BYTES,
    ICALLMATE_REVERSE_MEDIA_INTERVAL_MS,
    DISABLE_SCHEDULER,
    DISABLE_OWNER_DIGEST,
    APP_BASE_URL: describeEnvValue(process.env.APP_BASE_URL || ''),
    NGROK_URL: describeEnvValue(process.env.NGROK_URL || ''),
    WEBHOOK_URL: describeEnvValue(process.env.WEBHOOK_URL || ''),
    SERVER_NAME: describeEnvValue(process.env.SERVER_NAME || ''),
    ICALLMATE_IBD_API_ENDPOINT: process.env.ICALLMATE_IBD_API_ENDPOINT || 'https://crm.icallmate.in',
    ICALLMATE_OBD_API_ENDPOINT: process.env.ICALLMATE_OBD_API_ENDPOINT || 'https://ecp1.icallmate.in',
    ICALLMATE_DID: process.env.ICALLMATE_DID || ICALLMATE_DEFAULT_DID,
    ICALLMATE_SERVICE_NO: process.env.ICALLMATE_SERVICE_NO || '',
    ICALLMATE_IVR_TEMPLATE_ID: process.env.ICALLMATE_IVR_TEMPLATE_ID || '',
    ICALLMATE_AGENT_ID: process.env.ICALLMATE_AGENT_ID || '',
    ICALLMATE_UKEY_PRESENT: Boolean(process.env.ICALLMATE_UKEY),
    ICALLMATE_WEBHOOK_SECRET_PRESENT: Boolean(process.env.ICALLMATE_WEBHOOK_SECRET || process.env.WEBHOOK_SECRET),
    ICALLMATE_MEDIA_SHARED_SECRET_PRESENT: Boolean(process.env.ICALLMATE_MEDIA_SHARED_SECRET),
    GEMINI_API_KEY_PRESENT: Boolean(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY),
    DEEPGRAM_API_KEY_PRESENT: Boolean(process.env.DEEPGRAM_API_KEY),
    DATABASE_URL: process.env.DATABASE_URL || ''
  };

  console.log(`[${scope}] ${JSON.stringify(snapshot)}`);
}

/**
 * Picks the Supabase connection string for the current environment.
 *
 * SUPABASE_URL     -> production
 * SUPABASE_URL_DEV -> everything else (local, dev, UAT)
 *
 * DATABASE_URL overrides both when set, which is what one-off scripts and
 * CI use to target a specific database explicitly.
 */
function resolveDatabaseUrl(env = process.env) {
  const override = String(env.DATABASE_URL || '').trim();
  if (override) return override;

  const isProduction = String(env.NODE_ENV || '').toLowerCase() === 'production';
  const key = isProduction ? 'SUPABASE_URL' : 'SUPABASE_URL_DEV';
  return String(env[key] || '').trim();
}

/** Service-role key for the current environment. Server-side only, never sent to a browser. */
function resolveServiceRoleKey(env = process.env) {
  const isProduction = String(env.NODE_ENV || '').toLowerCase() === 'production';
  const scoped = isProduction ? env.SUPABASE_SERVICE_ROLE_KEY : env.SUPABASE_SERVICE_ROLE_KEY_DEV;
  return String(scoped || env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
}

/**
 * Storage REST base, derived from the Postgres connection string rather than a
 * separate API-URL variable, so the two can never point at different projects.
 * Handles both the pooler form (user `postgres.<ref>`) and the direct form
 * (host `db.<ref>.supabase.co`).
 */
function resolveStorageUrl(env = process.env) {
  const explicit = String(env.SUPABASE_API_URL || '').trim();
  if (explicit) return `${explicit.replace(/\/$/, '')}/storage/v1`;

  const connection = resolveDatabaseUrl(env);
  if (!connection) return '';
  let parsed;
  try { parsed = new URL(connection); } catch { return ''; }

  const fromUser = parsed.username.includes('.') ? parsed.username.split('.').pop() : '';
  const fromHost = /^db\.([a-z0-9]+)\.supabase\.co$/i.exec(parsed.hostname)?.[1] || '';
  const ref = fromUser || fromHost;
  return ref ? `https://${ref}.supabase.co/storage/v1` : '';
}

/** Names the variable resolveDatabaseUrl would have read, for error messages. */
function databaseUrlVarName(env = process.env) {
  if (String(env.DATABASE_URL || '').trim()) return 'DATABASE_URL';
  return String(env.NODE_ENV || '').toLowerCase() === 'production'
    ? 'SUPABASE_URL'
    : 'SUPABASE_URL_DEV';
}

/**
 * Returns null when the value is a usable Postgres connection string,
 * or a human-readable problem description otherwise.
 */
function validateDatabaseUrl(value, varName = 'DATABASE_URL') {
  const url = String(value || '').trim();
  if (!url) return `${varName} is required (Supabase Postgres connection string)`;
  if (!/^postgres(ql)?:\/\//i.test(url)) {
    return `${varName} must be a postgres:// connection string. It now points at `
      + 'Supabase, not a SQLite file \u2014 a leftover path such as /app/data/feedback.db '
      + 'will not work.';
  }
  return null;
}

function validateConfig() {
  const missing = [];

  const databaseUrlIssue = validateDatabaseUrl(
    resolveDatabaseUrl(),
    databaseUrlVarName()
  );
  if (databaseUrlIssue) {
    missing.push(databaseUrlIssue);
  }

  if (AI_PROVIDER.startsWith('gemini') && !process.env.GEMINI_API_KEY && !process.env.GOOGLE_API_KEY) {
    missing.push('GEMINI_API_KEY or GOOGLE_API_KEY');
  }

  if (!['gemini', 'gemini-live'].includes(AI_PROVIDER)) {
    missing.push('AI_PROVIDER must be gemini or gemini-live');
  }

  if (!process.env.DEEPGRAM_API_KEY) {
    missing.push('DEEPGRAM_API_KEY');
  }

  if (
    String(process.env.NODE_ENV || '').toLowerCase() === 'production'
    && !process.env.ICALLMATE_WEBHOOK_SECRET
    && !process.env.WEBHOOK_SECRET
  ) {
    missing.push('ICALLMATE_WEBHOOK_SECRET');
  }

  if (
    String(process.env.NODE_ENV || '').toLowerCase() === 'production'
    && Buffer.byteLength(String(process.env.ICALLMATE_MEDIA_SHARED_SECRET || ''), 'utf8') < 32
  ) {
    missing.push('ICALLMATE_MEDIA_SHARED_SECRET (at least 32 bytes)');
  }

  if (USE_ORCHESTRATED_PIPELINE) {
    throw new Error('VOICE_PIPELINE=orchestrated is no longer supported. iCallMate media is the only voice stream path.');
  }

  if (!HAS_CONFIGURED_PUBLIC_BASE_URL) {
    missing.push('APP_BASE_URL or NGROK_URL or WEBHOOK_URL or SERVER_NAME');
  }

  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
}

module.exports = {
  PORT,
  AI_PROVIDER,
  CALL_MODE,
  GEMINI_MODEL,
  GEMINI_VOICE,
  GEMINI_LIVE_THINKING_LEVEL,
  GEMINI_LIVE_SILENCE_DURATION_MS,
  GEMINI_LIVE_PREFIX_PADDING_MS,
  GEMINI_LIVE_DIRECT_AUDIO,
  DEEPGRAM_ENDPOINTING_MS,
  DEEPGRAM_FINAL_FLUSH_MS,
  LIVE_MAX_RESPONSE_TOKENS,
  GEMINI_LIVE_MAX_OUTPUT_TOKENS,
  LIVE_TEMPERATURE,
  FINAL_AUDIO_GRACE_MS,
  DEEPGRAM_TTS_MODEL,
  ICALLMATE_REVERSE_MEDIA_CHUNK_BYTES,
  ICALLMATE_REVERSE_MEDIA_INTERVAL_MS,
  REALTIME_MODEL,
  MAX_PRECONNECT_MEDIA_CHUNKS,
  MAX_PRECONNECT_MEDIA_BYTES,
  CLIENT_NAME,
  PUBLIC_BASE_URL,
  HAS_CONFIGURED_PUBLIC_BASE_URL,
  VOICE_PIPELINE,
  USE_ORCHESTRATED_PIPELINE,
  DISABLE_SCHEDULER,
  DISABLE_OWNER_DIGEST,
  MAX_CALL_DURATION_SECONDS,
  MIN_RETRY_GAP_MINUTES,
  liveCallState,
  incomingCallState,
  pendingCallDiagnostics,
  LIVE_CALL_RETENTION_MS,
  LIVE_CALL_ACTIVE_STALE_MS,
  INCOMING_CALL_RETENTION_MS,
  ICALLMATE_DEFAULT_DID,
  ICALLMATE_DEFAULT_TEST_NUMBER,
  CALL_DIAGNOSTIC_WARN_MS,
  CALL_TYPES,
  redactSecret,
  describeEnvValue,
  logConfigSnapshot,
  validateConfig,
  validateDatabaseUrl,
  resolveDatabaseUrl,
  databaseUrlVarName,
  resolveServiceRoleKey,
  resolveStorageUrl
};
