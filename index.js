require('dotenv').config();

const crypto = require('crypto');
const express = require('express');
const http = require('http');
const path = require('path');
const WebSocket = require('ws');
const { initializeDatabase, dbRun, dbGet, dbAll } = require('./db');
const customersRouter = require('./routes/customers');
const clientsRouter = require('./routes/clients');
const campaignsRouter = require('./routes/campaigns');
const feedbackRouter = require('./routes/feedback');
const reportsRouter = require('./routes/reports');
const agentsRouter = require('./routes/agents');
const testCallRouter = require('./routes/test-call');
const testAiCallRouter = require('./routes/test-ai-call');
const { saveCallFeedbackFromTranscript } = require('./services/call-feedback');
const { processCompletedCallPipeline } = require('./services/post-call-pipeline');
const { buildOwnerDashboardData } = require('./services/reporting');
const { sendSimpleEmail } = require('./services/email');
const {
  initiateCall,
  sendWhatsAppMessage
} = require('./services/icallmate');
const {
  buildPreCallIntelligence,
  computePriorityScore,
  getCurrentSlotLabel,
  applyCallOutcomeWorkflow,
  createSupervisorEvent
} = require('./services/call-orchestration');

const app = express();
app.set('trust proxy', 1);
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const PROTECTED_HTML_PATHS = new Set([
  '/admin.html',
  '/incoming-calls.html',
  '/customers.html',
  '/clients.html',
  '/feedback.html',
  '/feedback-analysis.html',
  '/reports.html'
]);

const ADMIN_USERNAME = 'admin';
const ADMIN_PASSWORD = '1234';
const AUTH_COOKIE_NAME = 'feedback_admin_session';
const AUTH_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const AUTH_SIGNING_SECRET = process.env.AUTH_SIGNING_SECRET || process.env.SESSION_SECRET || process.env.ICALLMATE_UKEY || 'feedback-admin-auth-secret';

function parseCookies(req) {
  const header = String(req.headers.cookie || '');
  if (!header) {
    return {};
  }

  return header.split(';').reduce((accumulator, item) => {
    const separatorIndex = item.indexOf('=');
    if (separatorIndex === -1) {
      return accumulator;
    }

    const key = item.slice(0, separatorIndex).trim();
    const value = item.slice(separatorIndex + 1).trim();
    if (key) {
      accumulator[key] = decodeURIComponent(value);
    }
    return accumulator;
  }, {});
}

function signAuthValue(value) {
  return crypto.createHmac('sha256', AUTH_SIGNING_SECRET).update(value).digest('base64url');
}

function createAuthToken(username) {
  const payload = Buffer.from(JSON.stringify({
    username,
    exp: Date.now() + AUTH_SESSION_TTL_MS
  })).toString('base64url');
  const signature = signAuthValue(payload);
  return `${payload}.${signature}`;
}

function readAuthSession(req) {
  const cookies = parseCookies(req);
  const token = cookies[AUTH_COOKIE_NAME];
  if (!token) {
    return null;
  }

  const [payload, signature] = token.split('.');
  if (!payload || !signature) {
    return null;
  }

  const expectedSignature = signAuthValue(payload);
  const signatureBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expectedSignature);
  if (
    signatureBuffer.length !== expectedBuffer.length
    || !crypto.timingSafeEqual(signatureBuffer, expectedBuffer)
  ) {
    return null;
  }

  try {
    const session = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!session?.username || !session?.exp || session.exp < Date.now()) {
      return null;
    }
    return session;
  } catch (error) {
    return null;
  }
}

function shouldUseSecureCookie(req) {
  if (!req) {
    return false;
  }

  if (req.secure) {
    return true;
  }

  const forwardedProto = String(req.headers['x-forwarded-proto'] || '')
    .split(',')[0]
    .trim()
    .toLowerCase();

  return forwardedProto === 'https';
}

function setAuthCookie(req, res, token) {
  const isSecure = shouldUseSecureCookie(req);
  const cookieParts = [
    `${AUTH_COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(AUTH_SESSION_TTL_MS / 1000)}`
  ];

  if (isSecure) {
    cookieParts.push('Secure');
  }

  res.setHeader('Set-Cookie', cookieParts.join('; '));
}

function clearAuthCookie(req, res) {
  const isSecure = shouldUseSecureCookie(req);
  const cookieParts = [
    `${AUTH_COOKIE_NAME}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=0'
  ];

  if (isSecure) {
    cookieParts.push('Secure');
  }

  res.setHeader('Set-Cookie', cookieParts.join('; '));
}

function requireAdminAuth(req, res, next) {
  const session = readAuthSession(req);
  if (session) {
    req.adminSession = session;
    return next();
  }

  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  return res.redirect('/login.html');
}

app.use((req, res, next) => {
  if (PROTECTED_HTML_PATHS.has(req.path) || req.path.startsWith('/api/')) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
  next();
});

app.use((req, res, next) => {
  if (
    req.path === '/login.html'
    || req.path.startsWith('/api/auth/')
    || req.path === '/api/icallmate/callback'
    || req.path === '/api/icallmate/config'
    || req.path === '/icallmate/health'
    || req.path === '/icallmate/media'
  ) {
    return next();
  }

  if (PROTECTED_HTML_PATHS.has(req.path) || req.path.startsWith('/api/')) {
    return requireAdminAuth(req, res, next);
  }

  return next();
});

app.use(express.static(path.join(__dirname, 'public')));

const PORT = Number(process.env.PORT || 3000);
const CALL_MODE = 'gemini';
const AI_PROVIDER = 'gemini';
const DEFAULT_GEMINI_MODEL = 'models/gemini-2.5-flash-native-audio-preview-12-2025';
const DEPRECATED_GEMINI_LIVE_MODELS = new Set([
  'models/gemini-3.1-flash-live-preview',
  'gemini-3.1-flash-live-preview',
  'models/gemini-live-2.5-flash-preview',
  'gemini-live-2.5-flash-preview'
]);

function normalizeGeminiModelName(modelName) {
  const normalized = String(modelName || '').trim();
  if (!normalized || DEPRECATED_GEMINI_LIVE_MODELS.has(normalized)) {
    return DEFAULT_GEMINI_MODEL;
  }

  return normalized.startsWith('models/') ? normalized : `models/${normalized}`;
}

function resolveRealtimeModelName(modelName) {
  const candidate = String(modelName || '').trim();
  return normalizeGeminiModelName(candidate || REALTIME_MODEL);
}

const REQUESTED_GEMINI_MODEL = process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL;
const GEMINI_MODEL = normalizeGeminiModelName(REQUESTED_GEMINI_MODEL);
if (GEMINI_MODEL !== String(REQUESTED_GEMINI_MODEL || '').trim()) {
  console.warn(`[CONFIG] Gemini model "${REQUESTED_GEMINI_MODEL}" is deprecated or unsupported here; using "${GEMINI_MODEL}" instead.`);
}
const GEMINI_VOICE = process.env.GEMINI_VOICE || 'Kore';
const REALTIME_MODEL = GEMINI_MODEL;
const GEMINI_OPENING_RETRY_MS = Math.max(Number(process.env.GEMINI_OPENING_RETRY_MS || 1500) || 1500, 800);
const GEMINI_OPENING_RETRY_ENABLED = String(process.env.GEMINI_OPENING_RETRY_ENABLED || 'false').toLowerCase() === 'true';
const MAX_PRECONNECT_MEDIA_CHUNKS = Math.max(Number(process.env.MAX_PRECONNECT_MEDIA_CHUNKS || 60) || 60, 10);
const MAX_PRECONNECT_MEDIA_BYTES = Math.max(Number(process.env.MAX_PRECONNECT_MEDIA_BYTES || 512000) || 512000, 64000);
const CLIENT_NAME = process.env.CLIENT_NAME || 'your diagnostic and medical collection center';
const HARDCODED_PUBLIC_BASE_URL = 'https://winter-undeclamatory-unstammeringly.ngrok-free.dev';
const SERVER_NAME_BASE_URL = process.env.SERVER_NAME ? `https://${String(process.env.SERVER_NAME).replace(/^https?:\/\//i, '').replace(/\/+$/g, '')}` : '';
const PUBLIC_BASE_URL = (
  SERVER_NAME_BASE_URL
  || process.env.APP_BASE_URL
  || process.env.NGROK_URL
  || process.env.WEBHOOK_URL
  || HARDCODED_PUBLIC_BASE_URL
).replace(/\/$/, '');
const GEMINI_WS_BASE_URL = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';
const VOICE_PIPELINE = process.env.VOICE_PIPELINE || 'legacy';
const USE_ORCHESTRATED_PIPELINE = VOICE_PIPELINE === 'orchestrated';
const DISABLE_SCHEDULER = String(process.env.DISABLE_SCHEDULER || '').toLowerCase() === 'true';
const DISABLE_OWNER_DIGEST = String(process.env.DISABLE_OWNER_DIGEST || '').toLowerCase() === 'true';
const liveCallState = new Map();
const incomingCallState = new Map();
const pendingCallDiagnostics = new Map();
const LIVE_CALL_RETENTION_MS = 20 * 60 * 1000;
const LIVE_CALL_ACTIVE_STALE_MS = 90 * 60 * 1000;
const INCOMING_CALL_RETENTION_MS = 60 * 60 * 1000;
const ICALLMATE_DEFAULT_DID = '8037259753';
const ICALLMATE_DEFAULT_TEST_NUMBER = '+918037259753';
const CALL_DIAGNOSTIC_WARN_MS = Math.max(Number(process.env.CALL_DIAGNOSTIC_WARN_MS || 20000) || 20000, 5000);

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
    REQUESTED_GEMINI_MODEL,
    GEMINI_MODEL,
    GEMINI_VOICE,
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
    GEMINI_API_KEY_PRESENT: Boolean(process.env.GEMINI_API_KEY),
    DEEPGRAM_API_KEY_PRESENT: Boolean(process.env.DEEPGRAM_API_KEY),
    DATABASE_URL: process.env.DATABASE_URL || ''
  };

  console.log(`[${scope}] ${JSON.stringify(snapshot)}`);
}

function getSecurePublicBaseUrl() {
  const baseUrl = String(PUBLIC_BASE_URL || '').trim();
  if (!baseUrl) {
    return '';
  }

  return baseUrl.replace(/^http:\/\//i, 'https://');
}

function runInBackground(label, work) {
  Promise.resolve()
    .then(() => work())
    .catch((error) => {
      console.error(`[${label}]`, error.message);
    });
}

process.on('unhandledRejection', (reason) => {
  const message = reason instanceof Error ? reason.stack || reason.message : String(reason);
  console.error('[UNHANDLED REJECTION]', message);
});

process.on('uncaughtExceptionMonitor', (error) => {
  console.error('[UNCAUGHT EXCEPTION]', error.stack || error.message);
});

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

function applyAgentTemplate(template, replacements = {}) {
  return String(template || '').replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi, (_, key) => {
    return replacements[key] ?? '';
  });
}

function buildDefaultAgentSystemPrompt(clientName, customerName) {
  return `
You are Priya, a warm and respectful Hindi-speaking calling assistant from ${clientName}.
You are calling ${customerName} for a blood donation follow-up on behalf of Apna Blood Centre, Palwal.

Purpose:
Call previous blood donors after around 3 months, thank them for their earlier donation,
ask whether they can donate blood again, and collect any problem/feedback from their last donation.

Tone and language:
- Speak in simple, natural Hindi/Hinglish.
- Be polite, warm, and brief.
- Do not sound robotic or like an AI system.
- Do not pressure the person to donate.
- Ask only one main question at a time.
- Keep every response short: 1-3 sentences.
- If the person is busy, not interested, or says no, thank them respectfully and close.
- Never give medical advice. If they mention a health issue, say the team will note it and they should follow doctor guidance.

Conversation flow:

1. Greeting and identity confirmation
Start by saying:
"Good morning sir/ma'am, main Apna Blood Centre, Palwal se Priya baat kar rahi hoon. Kya main ${customerName} ji se baat kar rahi hoon?"
If this is not the right person, apologize and end politely.
If they are busy, say: "Koi baat nahi sir/ma'am, hum baad mein contact kar lenge. Dhanyavaad."

2. Thank them for previous donation
Say:
"Sir/ma'am, aapne kuch time pehle blood donate kiya tha. Uske liye Apna Blood Centre ki taraf se aapka bahut-bahut dhanyavaad."

3. Ask about repeat donation after 3 months
Say:
"Aapke blood donation ko lagbhag 3 months ho gaye hain. Kya aap phir se blood donate karna chahenge?"

4. If they say yes
Thank them and say:
"Bahut dhanyavaad sir/ma'am. Aap kisi bhi din apni suvidha ke hisaab se, khana khaane ke baad, 9 AM se 5 PM ke beech Apna Blood Centre aa sakte hain."
Then add:
"Humare yahan thalassemia patients, garbhwati mahilaon, aur zaruratmand bachchon ke liye free blood diya jaata hai. Aapka donation kisi ki jaan bachane mein madad kar sakta hai."
If they ask date or place, collect it naturally:
- Date: ask "Aap kis din aana chahenge?"
- Place: say "Apna Blood Centre, Palwal."

5. If they say no or not now
Say:
"Koi baat nahi sir/ma'am. Aapka pehle blood donate karne ke liye bahut dhanyavaad."
Then ask:
"Blood donate karne ke baad aapko koi problem ya dikkat hui thi?"

6. If they had no problem
Say:
"Theek hai sir/ma'am, bahut dhanyavaad. Aapka din shubh ho."

7. If they had a problem
Say:
"Sorry sir/ma'am, aapko dikkat hui. Kya aap bata sakte hain kya problem hui thi?"
After they explain, say:
"Main aapki baat team tak pahucha dungi. Next time hum iska dhyan rakhenge."

8. Social follow-up, only if the conversation is positive and they are not annoyed
Say:
"Sir/ma'am, humne aapke paas ek video/link send kiya hai. Agar possible ho to please like, comment, share ya subscribe kar dijiye."
Then say:
"Facebook aur Google par Apna Blood Centre ke naam se page hai. Aapka support humein aur logon tak pahunchne mein madad karega."

9. Closing
End with:
"Dhanyavaad sir/ma'am. Apna Blood Centre ki taraf se aapka bahut-bahut dhanyavaad. Aapka din shubh ho."

Important rules:
- Do not ask survey-style diagnostic center questions about cleanliness, staff, sample collection, rating, or Google Form.
- Do not invent appointment confirmation if the donor did not agree.
- Do not repeat the same question again and again.
- If the donor asks why you are calling, explain: "Sir/ma'am, hum previous blood donors ko 3 months ke baad follow-up karte hain, kyunki blood donation se zaruratmand patients ki madad hoti hai."
- If the donor asks whether donation is safe, say: "Sir/ma'am, final decision aapki health aur doctor/team ki guidance ke hisaab se hi hoga."
`.trim();
}

function buildAgentSystemPrompt(clientName, customerName, agentConfig = null) {
  if (agentConfig?.system_prompt) {
    return applyAgentTemplate(agentConfig.system_prompt, {
      client_name: clientName,
      customer_name: customerName,
      language: agentConfig.language || 'hi',
      agent_name: agentConfig.name || 'Agent'
    });
  }

  return buildDefaultAgentSystemPrompt(clientName, customerName);
}

function buildDefaultOpeningPrompt(clientName, customerName) {
  return `Sirf yeh exact line boliye aur is turn me kuch aur mat boliye: "Good morning sir/ma'am, main Apna Blood Centre, Palwal se Priya baat kar rahi hoon. Kya main ${customerName} ji se baat kar rahi hoon?"`;
}

function buildOpeningPrompt(clientName, customerName, agentConfig = null) {
  if (agentConfig?.opening_prompt) {
    return applyAgentTemplate(agentConfig.opening_prompt, {
      client_name: clientName,
      customer_name: customerName,
      language: agentConfig.language || 'hi',
      agent_name: agentConfig.name || 'Agent'
    });
  }

  return buildDefaultOpeningPrompt(clientName, customerName);
}

function buildIncomingAgentSystemPrompt(clientName) {
  return `
You are Priya, a calm Hindi/Hinglish receptionist for ${clientName}.
The caller has called the business first. This is an inbound support call, not an outbound follow-up.

Goal:
- Greet briefly and ask how you can help.
- Help with common patient/customer needs: report status, appointment timing, address, service availability, callback request, or complaint.
- If details are needed, collect name, phone number, and the issue in a natural way.
- If the caller asks for something you cannot verify, say the team will check and call back.
- Keep responses short, polite, and human.

Rules:
- Do not say you are calling them.
- Do not talk about previous blood donation follow-up unless the caller asks about blood donation.
- Do not ask outbound survey questions.
- Do not invent report results, appointment confirmations, prices, or medical advice.
- If the caller is angry or reports a problem, apologize once, collect the issue, and say the team will follow up.
- If the caller wants to end, thank them and close.
`.trim();
}

function buildIncomingOpeningPrompt(clientName) {
  return `Sirf yeh exact line boliye aur is turn me kuch aur mat boliye: "Namaste, ${clientName} se Priya bol rahi hoon. Main aapki kis tarah madad kar sakti hoon?"`;
}

async function getAgentConfigById(agentId) {
  if (!agentId) return null;
  return dbGet('SELECT * FROM agents WHERE id = ? AND is_active = 1', [agentId]);
}

async function getDefaultAgentConfig() {
  return dbGet('SELECT * FROM agents WHERE is_default = 1 AND is_active = 1 ORDER BY id ASC LIMIT 1');
}

function validateConfig() {
  const missing = [];

  if (!process.env.GEMINI_API_KEY) {
    missing.push('GEMINI_API_KEY');
  }

  if (USE_ORCHESTRATED_PIPELINE) {
    throw new Error('VOICE_PIPELINE=orchestrated is no longer supported. iCallMate media is the only voice stream path.');
  }

  if (!PUBLIC_BASE_URL) {
    missing.push('APP_BASE_URL or NGROK_URL or WEBHOOK_URL or SERVER_NAME');
  }

  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
}

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

let ownerDigestRunning = false;

async function runOwnerDigestTick() {
  if (ownerDigestRunning || !shouldTriggerOwnerDigest()) {
    return;
  }

  ownerDigestRunning = true;

  try {
    const todayKey = getLocalDateKey();
    const state = await dbGet('SELECT value FROM app_state WHERE key = ?', ['owner_morning_digest_last_sent']);
    if (state?.value === todayKey) {
      return;
    }

    const digest = await buildOwnerDashboardData();
    const lines = [
      digest.digest_text,
      '',
      `Revenue pipeline: Rs ${Number(digest.roi_snapshot?.revenue_pipeline_estimate || 0).toFixed(0)}`,
      `Estimated AI ops cost: Rs ${Number(digest.roi_snapshot?.ai_ops_cost_estimate || 0).toFixed(0)}`,
      `Estimated staff saving: Rs ${Number(digest.roi_snapshot?.estimated_saving_vs_staff || 0).toFixed(0)}`,
      '',
      digest.alerts?.length
        ? `Priority alerts:\n- ${digest.alerts.map((item) => `${item.customer_name}: ${item.headline}`).join('\n- ')}`
        : 'Priority alerts: none'
    ].join('\n');

    if (process.env.OWNER_EMAIL) {
      await sendSimpleEmail(process.env.OWNER_EMAIL, `CEO Morning Digest — ${todayKey}`, lines);
    }

    if (process.env.OWNER_PHONE && process.env.ICALLMATE_WHATSAPP_ENABLED === 'true') {
      await sendWhatsAppMessage(process.env.OWNER_PHONE, digest.digest_text);
    }

    await dbRun(
      `INSERT INTO app_state (key, value, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      ['owner_morning_digest_last_sent', todayKey, new Date().toISOString()]
    );

    console.log('[OWNER DIGEST] Morning digest sent successfully');
  } catch (error) {
    console.error('[OWNER DIGEST ERROR]', error.message);
  } finally {
    ownerDigestRunning = false;
  }
}

function normalizeSpeech(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ');
}

function inferDtmfUtterance(digit, transcript = []) {
  const normalizedDigit = String(digit || '').trim();
  const lastAgentTurn = [...transcript].reverse().find((turn) => turn.role === 'AGENT');
  const lastPrompt = String(lastAgentTurn?.text || '').toLowerCase();
  const ratingContext = /(1 se 5|scale|rating|star|stars|excellent|rate)/.test(lastPrompt);

  if (ratingContext) {
    const map = {
      '1': 'meri rating ek hai',
      '2': 'meri rating do hai',
      '3': 'meri rating teen hai',
      '4': 'meri rating chaar hai',
      '5': 'meri rating paanch hai'
    };
    return map[normalizedDigit] || normalizedDigit;
  }

  const genericMap = {
    '1': 'haan, continue',
    '2': 'nahin',
    '3': 'teen',
    '4': 'chaar',
    '5': 'paanch'
  };

  return genericMap[normalizedDigit] || normalizedDigit;
}

function isAffirmativeResponse(speech, digit) {
  const normalized = normalizeSpeech(speech);
  const affirmativePhrases = [
    'yes',
    'yeah',
    'yep',
    'ok',
    'okay',
    'sure',
    'continue',
    'haan',
    'han',
    'ha',
    'haan ji',
    'han ji',
    'ji',
    'bilkul',
    'theek hai',
    'thik hai'
  ];

  return digit === '1' || affirmativePhrases.some((phrase) => normalized.includes(phrase));
}

function detectLanguageChoice(speech, digit) {
  const normalized = normalizeSpeech(speech);

  if (digit === '2' || normalized.includes('english') || normalized.includes('inglish')) {
    return 'en';
  }

  return 'hi';
}

function getScriptedCopy(language, customerName = process.env.CUSTOMER_NAME, clientName = CLIENT_NAME) {
  if (language === 'en') {
    return {
      intro: `Hello, am I speaking with ${customerName}? This is Priya calling from Apna Blood Centre, Palwal. To continue in English, say English or press 2. Hindi mein baat karne ke liye Hindi boliye ya 1 dabaiye.`,
      noLanguageResponse: 'We did not receive your language preference. Thank you for your time. Goodbye.',
      consent: `Thank you. You donated blood some time ago. It has been around 3 months since your donation. Would you like to donate blood again? Please say yes or press 1 if you are interested.`,
      decline: 'No problem. Thank you for your time. Goodbye.',
      noConsentResponse: 'We did not receive a response. Thank you for your time. Goodbye.',
      rating: 'Thank you. You can visit Apna Blood Centre, Palwal any day between 9 AM and 5 PM after having food. Did you face any problem after your previous blood donation? Please say yes or no.',
      noRatingResponse: 'We did not receive a response. Thank you for your time. Goodbye.',
      closing: 'Thank you. Your donation can help thalassemia patients, pregnant women, and children in need. Have a good day.'
    };
  }

  return {
    intro: `Namaste. Kya main ${customerName} se baat kar rahi hoon? Main Priya bol rahi hoon, Apna Blood Centre, Palwal se. Hindi mein baat karne ke liye haan boliye ya 1 dabaiye.`,
    noLanguageResponse: 'Humein aapka jawab nahin mila. Dhanyavaad. Namaste.',
    consent: `Dhanyavaad. Aapne kuch time pehle blood donate kiya tha. Aapke blood donation ko lagbhag 3 months ho gaye hain. Kya aap phir se blood donate karna chahenge?`,
    decline: 'Koi baat nahin. Aapke samay ke liye dhanyavaad. Namaste.',
    noConsentResponse: 'Humein aapka jawab nahin mila. Dhanyavaad. Namaste.',
    rating: 'Bahut dhanyavaad. Aap kisi bhi din khana khaane ke baad 9 AM se 5 PM ke beech Apna Blood Centre, Palwal aa sakte hain. Blood donate karne ke baad aapko koi problem ya dikkat hui thi?',
    noRatingResponse: 'Humein aapka jawab nahin mila. Dhanyavaad. Namaste.',
    closing: 'Dhanyavaad. Aapka donation thalassemia patients, garbhwati mahilaon, aur zaruratmand bachchon ki madad kar sakta hai. Aapka din shubh ho.'
  };
}

function buildXmlResponse(innerXml) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n${innerXml}\n</Response>`;
}

function buildScriptedTwiml(customerName, clientName) {
  const encodedCustomerName = encodeURIComponent(customerName || process.env.CUSTOMER_NAME || 'Customer');
  const encodedClientName = encodeURIComponent(clientName || CLIENT_NAME);
  const copy = getScriptedCopy('hi', customerName, clientName);

  return buildXmlResponse(`  <Gather input="dtmf speech" numDigits="1" timeout="6" speechTimeout="auto" language="hi-IN" actionOnEmptyResult="true" action="/call/scripted/consent?lang=hi&amp;customerName=${xmlEscape(encodedCustomerName)}&amp;clientName=${xmlEscape(encodedClientName)}" method="POST">
    <Say language="hi-IN">${xmlEscape(copy.intro)}</Say>
  </Gather>
  <Say language="hi-IN">${xmlEscape(copy.noLanguageResponse)}</Say>
  <Hangup />`);
}

function buildScriptedLanguageResponse(req) {
  const speech = String(req.body.SpeechResult || '').trim().toLowerCase();
  const digit = String(req.body.Digits || '').trim();
  const language = detectLanguageChoice(speech, digit);
  const copy = getScriptedCopy(language, req.query.customerName, req.query.clientName);
  const encodedCustomerName = encodeURIComponent(req.query.customerName || process.env.CUSTOMER_NAME || 'Customer');
  const encodedClientName = encodeURIComponent(req.query.clientName || CLIENT_NAME);

  return buildXmlResponse(`  <Gather input="speech dtmf" numDigits="1" timeout="7" speechTimeout="auto" language="${language === 'en' ? 'en-IN' : 'hi-IN'}" actionOnEmptyResult="true" action="/call/scripted/consent?lang=${xmlEscape(language)}&amp;customerName=${xmlEscape(encodedCustomerName)}&amp;clientName=${xmlEscape(encodedClientName)}" method="POST">
    <Say language="${language === 'en' ? 'en-IN' : 'hi-IN'}">${xmlEscape(copy.consent)}</Say>
  </Gather>
  <Say language="${language === 'en' ? 'en-IN' : 'hi-IN'}">${xmlEscape(copy.noConsentResponse)}</Say>
  <Hangup />`);
}

function buildScriptedConsentResponse(req) {
  const speech = String(req.body.SpeechResult || '').trim();
  const digit = String(req.body.Digits || '').trim();
  const language = req.query.lang === 'en' ? 'en' : 'hi';
  const copy = getScriptedCopy(language, req.query.customerName, req.query.clientName);
  const encodedCustomerName = encodeURIComponent(req.query.customerName || process.env.CUSTOMER_NAME || 'Customer');
  const encodedClientName = encodeURIComponent(req.query.clientName || CLIENT_NAME);

  if (!isAffirmativeResponse(speech, digit)) {
    return buildXmlResponse(`  <Say language="hi-IN">${xmlEscape(copy.decline)}</Say>
  <Hangup />`);
  }

  return buildXmlResponse(`  <Gather input="speech dtmf" numDigits="1" timeout="10" speechTimeout="auto" language="hi-IN" actionOnEmptyResult="true" action="/call/scripted/rating?lang=${xmlEscape(language)}&amp;customerName=${xmlEscape(encodedCustomerName)}&amp;clientName=${xmlEscape(encodedClientName)}" method="POST">
    <Say language="hi-IN">${xmlEscape(copy.rating)}</Say>
  </Gather>
  <Say language="hi-IN">${xmlEscape(copy.noRatingResponse)}</Say>
  <Hangup />`);
}

function buildScriptedRatingResponse(req) {
  const speech = String(req.body.SpeechResult || '').trim();
  const digit = String(req.body.Digits || '').trim();
  const language = req.query.lang === 'en' ? 'en' : 'hi';
  const copy = getScriptedCopy(language, req.query.customerName, req.query.clientName);
  const rating = digit || speech;

  console.log(`[SCRIPTED] Rating response: ${rating || 'none'}`);

  return buildXmlResponse(`  <Say language="hi-IN">${xmlEscape(copy.closing)}</Say>
  <Hangup />`);
}

function resamplePcm16(buffer, fromRate, toRate) {
  if (!buffer.length || fromRate === toRate) {
    return buffer;
  }

  const inputSamples = Math.floor(buffer.length / 2);
  const outputSamples = Math.max(1, Math.round((inputSamples * toRate) / fromRate));
  const output = Buffer.alloc(outputSamples * 2);

  for (let i = 0; i < outputSamples; i += 1) {
    const position = (i * (inputSamples - 1)) / Math.max(outputSamples - 1, 1);
    const leftIndex = Math.floor(position);
    const rightIndex = Math.min(leftIndex + 1, inputSamples - 1);
    const weight = position - leftIndex;
    const left = buffer.readInt16LE(leftIndex * 2);
    const right = buffer.readInt16LE(rightIndex * 2);
    const sample = Math.round(left + ((right - left) * weight));
    output.writeInt16LE(sample, i * 2);
  }

  return output;
}

function parsePcmRate(mimeType, fallbackRate) {
  const match = String(mimeType || '').match(/rate=(\d+)/i);
  return match ? Number(match[1]) : fallbackRate;
}

function normalizePhoneLookupValue(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.length === 10) return digits;
  if (digits.length > 10) return digits.slice(-10);
  return digits;
}

function usesGeminiRealtimeTextInput(modelName) {
  return /gemini-3\.1/i.test(String(modelName || ''));
}

function buildGeminiWsUrl() {
  const url = new URL(GEMINI_WS_BASE_URL);
  if (process.env.GEMINI_API_KEY) {
    url.searchParams.set('key', process.env.GEMINI_API_KEY);
  }
  return url.toString();
}

function createDeepgramListenUrl() {
  const url = new URL('wss://api.deepgram.com/v1/listen');
  url.searchParams.set('model', 'nova-2');
  url.searchParams.set('language', 'hi');
  url.searchParams.set('interim_results', 'true');
  url.searchParams.set('endpointing', '300');
  url.searchParams.set('smart_format', 'true');
  url.searchParams.set('encoding', 'linear16');
  url.searchParams.set('sample_rate', '8000');
  url.searchParams.set('channels', '1');
  return url.toString();
}

function buildGeminiContentsFromTranscript(transcript = [], nextUserTurn = null) {
  const contents = transcript.map((turn) => ({
    role: turn.role === 'AGENT' ? 'model' : 'user',
    parts: [{ text: turn.text }]
  }));

  const normalizedNextUserTurn = String(nextUserTurn || '').trim();
  const lastContent = contents[contents.length - 1];
  const lastText = String(lastContent?.parts?.[0]?.text || '').trim();

  if (normalizedNextUserTurn && !(lastContent?.role === 'user' && lastText === normalizedNextUserTurn)) {
    contents.push({
      role: 'user',
      parts: [{ text: normalizedNextUserTurn }]
    });
  }

  return contents;
}

function extractGeminiTextFromChunk(payload) {
  const candidates = Array.isArray(payload?.candidates) ? payload.candidates : [];
  const texts = [];

  candidates.forEach((candidate) => {
    const parts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [];
    parts.forEach((part) => {
      if (typeof part?.text === 'string' && part.text) {
        texts.push(part.text);
      }
    });
  });

  return texts.join('');
}

function shouldFlushSpeechSegment(buffer) {
  const text = String(buffer || '').trim();
  if (!text) {
    return false;
  }

  return /[.!?,;:।]\s*$/.test(text) || text.length >= 80;
}

async function streamGeminiResponse({ systemPrompt, contents, onTextChunk, signal, modelName }) {
  const normalizedModelName = String(modelName || REALTIME_MODEL || '').replace(/^models\//, '');
  const modelPath = encodeURIComponent(normalizedModelName);
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${modelPath}:streamGenerateContent?alt=sse&key=${encodeURIComponent(process.env.GEMINI_API_KEY)}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      systemInstruction: {
        parts: [{ text: systemPrompt }]
      },
      generationConfig: {
        temperature: 0.3
      },
      contents
    }),
    signal
  });

  if (!response.ok || !response.body) {
    const errorText = await response.text().catch(() => '');
    throw new Error(`Gemini streaming failed (${response.status}): ${errorText || response.statusText}`);
  }

  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  let buffer = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split('\n\n');
    buffer = events.pop() || '';

    for (const eventBlock of events) {
      const lines = eventBlock
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
      const dataLine = lines.find((line) => line.startsWith('data:'));
      if (!dataLine) {
        continue;
      }

      const payloadText = dataLine.slice(5).trim();
      if (!payloadText || payloadText === '[DONE]') {
        continue;
      }

      const payload = JSON.parse(payloadText);
      const textChunk = extractGeminiTextFromChunk(payload);
      if (textChunk) {
        await onTextChunk(textChunk);
      }
    }
  }
}

async function streamSynthesizedAudio() {
  throw new Error('Orchestrated third-party TTS has been removed. Use VOICE_PIPELINE=legacy.');
}

async function placeRealtimeCall({ customerPhone, customerName, customerId, clientName, agentId }) {
  return initiateCall(customerPhone, customerId, {
    baseUrl: PUBLIC_BASE_URL,
    customerName,
    clientName,
    agentId,
    wsurl: toWssUrl(PUBLIC_BASE_URL, '/icallmate/media'),
    callbackapi: `${PUBLIC_BASE_URL}/api/icallmate/callback`
  });
}

function computeNextAnnualReminderDate(lastVisitDate, referenceDate = new Date()) {
  const parts = String(lastVisitDate || '').split('-').map((value) => Number(value));
  const [, month, day] = parts;
  if (!month || !day) {
    return null;
  }

  const formatDateOnly = (date) => date.toISOString().slice(0, 10);
  const buildAnniversaryDate = (year) => {
    const lastDayOfMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const normalizedDay = Math.min(day, lastDayOfMonth);
    return new Date(Date.UTC(year, month - 1, normalizedDay));
  };

  const currentYear = referenceDate.getUTCFullYear();
  const today = formatDateOnly(referenceDate);
  let candidate = formatDateOnly(buildAnniversaryDate(currentYear));
  if (candidate < today) {
    candidate = formatDateOnly(buildAnniversaryDate(currentYear + 1));
  }

  return candidate;
}

async function ensureCustomerForCall({ customerId, customerName, customerPhone }) {
  if (customerId) {
    const existingById = await dbGet('SELECT * FROM customers WHERE id = ?', [customerId]);
    if (existingById) {
      return existingById;
    }
  }

  const existingByPhone = await dbGet('SELECT * FROM customers WHERE phone = ?', [customerPhone]);
  if (existingByPhone) {
    return existingByPhone;
  }

  const result = await dbRun(
    'INSERT INTO customers (name, phone, preferred_slot, status, created_at) VALUES (?, ?, ?, ?, ?)',
    [
      customerName || 'Customer',
      customerPhone,
      '10:00',
      'pending',
      new Date().toISOString()
    ]
  );

  return dbGet('SELECT * FROM customers WHERE id = ?', [result.lastID]);
}

async function claimCustomerForOutboundCall(customerId) {
  const result = await dbRun(
    `UPDATE customers
        SET status = ?,
            last_called_at = ?
      WHERE id = ?
        AND COALESCE(status, 'pending') != 'calling'`,
    ['calling', new Date().toISOString(), customerId]
  );

  return result.changes > 0;
}

async function releaseCustomerOutboundClaim(customerId, fallbackStatus = 'pending') {
  await dbRun(
    `UPDATE customers
        SET status = ?
      WHERE id = ?
        AND status = 'calling'`,
    [fallbackStatus, customerId]
  );
}

async function ensureCustomerForClientReminder(client) {
  let customer = null;

  if (client.linked_customer_id) {
    customer = await dbGet('SELECT * FROM customers WHERE id = ?', [client.linked_customer_id]);
  }

  if (!customer) {
    customer = await dbGet('SELECT * FROM customers WHERE phone = ?', [client.phone]);
  }

  if (customer) {
    await dbRun(
      `UPDATE customers
          SET name = ?,
              phone = ?,
              preferred_slot = ?,
              service_interest = ?,
              status = CASE WHEN status = 'completed' THEN 'pending' ELSE status END
        WHERE id = ?`,
      [
        client.name,
        client.phone,
        client.annual_reminder_slot || '10:00',
        client.treatment_type || null,
        customer.id
      ]
    );
    await dbRun(
      'UPDATE clients SET linked_customer_id = ?, updated_at = ? WHERE id = ?',
      [customer.id, new Date().toISOString(), client.id]
    );
    return dbGet('SELECT * FROM customers WHERE id = ?', [customer.id]);
  }

  const result = await dbRun(
    `INSERT INTO customers (
      name, phone, preferred_slot, status, created_at, service_interest
    ) VALUES (?, ?, ?, ?, ?, ?)`,
    [
      client.name,
      client.phone,
      client.annual_reminder_slot || '10:00',
      'pending',
      new Date().toISOString(),
      client.treatment_type || null
    ]
  );

  await dbRun(
    'UPDATE clients SET linked_customer_id = ?, updated_at = ? WHERE id = ?',
    [result.lastID, new Date().toISOString(), client.id]
  );

  return dbGet('SELECT * FROM customers WHERE id = ?', [result.lastID]);
}

async function findCustomerByPhone(phoneValue) {
  const normalized = normalizePhoneLookupValue(phoneValue);
  if (!normalized) return null;

  const customers = await dbAll('SELECT * FROM customers ORDER BY id DESC LIMIT 200');
  return customers.find((customer) => normalizePhoneLookupValue(customer.phone) === normalized) || null;
}

async function ensureIncomingCustomerForCall(phoneValue, fallbackName = 'Incoming caller') {
  const normalizedPhone = String(phoneValue || '').trim() || `incoming-${Date.now()}`;
  const existing = await findCustomerByPhone(normalizedPhone);
  if (existing) {
    return existing;
  }

  const result = await dbRun(
    'INSERT INTO customers (name, phone, preferred_slot, status, created_at) VALUES (?, ?, ?, ?, ?)',
    [
      fallbackName || 'Incoming caller',
      normalizedPhone,
      getCurrentSlotLabel(new Date()),
      'incoming',
      new Date().toISOString()
    ]
  );

  return dbGet('SELECT * FROM customers WHERE id = ?', [result.lastID]);
}

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

async function getCustomerCallHistory(customerId, limit = 20) {
  if (!customerId) return [];
  return dbAll(
    `SELECT called_at, outcome, sentiment_label, transcript_text, analysis_summary, extracted_review_text
     FROM calls
     WHERE customer_id = ?
     ORDER BY called_at DESC
     LIMIT ?`,
    [customerId, limit]
  );
}

async function hydratePreCallIntelligence(customer) {
  const history = await getCustomerCallHistory(customer.id);
  const intelligence = buildPreCallIntelligence(customer, history);

  await dbRun(
    `UPDATE customers
        SET priority_score = ?,
            ai_score = ?,
            best_call_slot = ?,
            preferred_dialect = ?,
            outstanding_issues = ?,
            last_sentiment_label = ?,
            pickup_rate_score = ?,
            dnd_checked_at = ?
      WHERE id = ?`,
    [
      intelligence.priorityScore,
      intelligence.priorityScore,
      intelligence.bestCallSlot,
      intelligence.preferredDialect,
      intelligence.outstandingIssues.join('\n') || null,
      intelligence.lastSentimentLabel || null,
      intelligence.pickupRateScore,
      new Date().toISOString(),
      customer.id
    ]
  );

  return {
    ...customer,
    priority_score: intelligence.priorityScore,
    ai_score: intelligence.priorityScore,
    best_call_slot: intelligence.bestCallSlot,
    preferred_dialect: intelligence.preferredDialect,
    outstanding_issues: intelligence.outstandingIssues.join('\n'),
    pickup_rate_score: intelligence.pickupRateScore
  };
}

function shouldBlockCustomerCall(customer) {
  if (customer.do_not_call) {
    return 'Customer is on DND / do-not-call';
  }

  if (customer.wrong_number_flag) {
    return 'Customer is flagged as wrong number';
  }

  if (String(customer.consent_status || '').toLowerCase() === 'denied') {
    return 'Consent denied for this customer';
  }

  return null;
}

function evaluateLiveSentimentLabel(text) {
  const normalized = String(text || '').toLowerCase();
  const negative = ['problem', 'issue', 'bad', 'rude', 'wait', 'dirty', 'complaint', 'angry', 'nahi', 'galat'];
  const positive = ['good', 'great', 'achha', 'accha', 'sahi', 'helpful', 'clean', 'thank'];
  const negativeCount = negative.filter((word) => normalized.includes(word)).length;
  const positiveCount = positive.filter((word) => normalized.includes(word)).length;

  if (negativeCount > positiveCount && negativeCount > 0) {
    return { label: 'negative', score: -0.75 };
  }

  if (positiveCount > negativeCount && positiveCount > 0) {
    return { label: 'positive', score: 0.65 };
  }

  return { label: 'neutral', score: 0 };
}

function shouldAutoHangupAfterAgentTurn(text) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim().toLowerCase();
  if (!normalized) {
    return false;
  }

  const looksLikeFollowupQuestion = (
    /[?？]|[?？]\s*$/.test(text)
    || /\b(kya|kaisa|kaisi|kaise|aur|kab|kyun|kyon|kripya|please|bataiye|batayiye)\b/i.test(normalized)
  );

  if (looksLikeFollowupQuestion) {
    return false;
  }

  return [
    /(^|\b)(goodbye|bye|alvida)(\b|$)/i,
    /(^|\b)(namaste|dhanyavaad|shukriya)(\b|$)/i,
    /apna dhyaan rakh/i,
    /din shubh ho/i,
    /aapka samay dene ke liye/i,
    /aapke feedback ke liye dhanyavaad/i,
    /aapka feedback bahut/i,
    /aapne jo feedback diya uske liye/i,
    /bahut (bahut )?dhanyawa?d/i,
    /hum (aapko|apko) (ek )?whatsapp (par )?(message|link) bhejenge/i,
    /google form ka link/i,
    /have a great day/i
  ].some((pattern) => pattern.test(normalized));
}

function estimateHangupDelayMs(text) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim().toLowerCase();
  if (!normalized) {
    return 4500;
  }

  const strongClosingPatterns = [
    /google form/i,
    /whatsapp/i,
    /din shubh ho/i,
    /goodbye/i,
    /namaste/i,
    /aapka samay dene ke liye/i,
    /aapke feedback ke liye dhanyavaad/i
  ];

  if (strongClosingPatterns.some((pattern) => pattern.test(normalized))) {
    return 1800;
  }

  const length = normalized.length;
  return Math.min(7000, Math.max(2800, 1800 + (length * 24)));
}

function buildTranscriptPreviewText(text, maxLines = 4) {
  const lines = String(text || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.slice(-maxLines).join('\n');
}

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

function getIncomingCallKey(message = {}) {
  return String(message.streamId || message.ChKey || message.callerId || `${Date.now()}`).trim();
}

async function upsertIncomingCallFromIcall(message = {}, patch = {}) {
  const key = getIncomingCallKey(message);
  const existing = incomingCallState.get(key) || {};
  const eventName = String(message.event || patch.event || '').toLowerCase();
  const nowIso = new Date().toISOString();
  const status = patch.status || (
    eventName === 'hangup-call' ? 'missed' : 'active'
  );

  const row = {
    id: key,
    stream_id: message.streamId || existing.stream_id || key,
    caller_name: patch.caller_name || existing.caller_name || 'Incoming caller',
    phone: message.callerId || existing.phone || '--',
    did: message.did || existing.did || '',
    call_direction: patch.call_direction || message.callDirection || existing.call_direction || 'incoming',
    status,
    received_at: existing.received_at || normalizeIcallTimestamp(message.timestamp),
    updated_at: nowIso,
    notes: patch.notes || existing.notes || 'iCallMate incoming call',
    last_event: eventName || existing.last_event || '',
    answered_at: patch.answered_at || existing.answered_at || null,
    ended_at: patch.ended_at || existing.ended_at || null,
    media_packets: Number(existing.media_packets || 0) + Number(patch.media_packets || 0),
    reverse_media_queue: Number(message.RevMediaQ || existing.reverse_media_queue || 0),
    botid: message.botid || existing.botid || '',
    userrefno: message.userrefno || existing.userrefno || '',
    sysrefno: message.sysrefno || existing.sysrefno || '',
    extra_params: message.extraParams || existing.extra_params || ''
  };

  incomingCallState.set(key, row);

  try {
    const customer = await ensureIncomingCustomerForCall(row.phone, row.caller_name);
    const existingCall = await dbGet('SELECT * FROM calls WHERE provider_call_id = ?', [row.stream_id]);
    const outcome = row.status === 'active' ? 'active' : row.status;
    const providerPayload = JSON.stringify({
      event: eventName,
      streamId: row.stream_id,
      callerId: row.phone,
      did: row.did,
      ChKey: message.ChKey || null,
      botid: row.botid || null,
      userrefno: row.userrefno || null,
      sysrefno: row.sysrefno || null,
      extraParams: row.extra_params || null
    });

    if (existingCall) {
      await dbRun(
        `UPDATE calls
            SET customer_id = ?,
                outcome = ?,
                did = ?,
                answered_at = COALESCE(?, answered_at),
                ended_at = COALESCE(?, ended_at),
                media_packets = COALESCE(media_packets, 0) + ?,
                last_event = ?,
                notes = ?,
                provider_payload_json = ?,
                call_direction = ?,
                call_source = ?,
                called_at = COALESCE(called_at, ?)
          WHERE id = ?`,
        [
          customer.id,
          outcome,
          row.did || null,
          row.answered_at,
          row.ended_at,
          Number(patch.media_packets || 0),
          row.last_event || null,
          row.notes || null,
          providerPayload,
          row.call_direction || 'incoming',
          'icallmate',
          row.received_at,
          existingCall.id
        ]
      );
    } else {
      await dbRun(
        `INSERT INTO calls (
          customer_id, outcome, provider_call_id, called_at, call_direction, call_source,
          did, answered_at, ended_at, media_packets, last_event, notes,
          transcript_status, analysis_status, provider_payload_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          customer.id,
          outcome,
          row.stream_id,
          row.received_at,
          row.call_direction || 'incoming',
          'icallmate',
          row.did || null,
          row.answered_at,
          row.ended_at,
          Number(row.media_packets || 0),
          row.last_event || null,
          row.notes || null,
          'live_stream',
          'pending',
          providerPayload
        ]
      );
    }
  } catch (error) {
    console.error('[ICALLMATE INCOMING DB ERROR]', error.message);
  }

  return row;
}

function pruneIncomingCallState(now = Date.now()) {
  for (const [key, row] of incomingCallState.entries()) {
    const updatedAt = new Date(row?.updated_at || row?.received_at || 0).getTime();
    if (!updatedAt || Number.isNaN(updatedAt) || (now - updatedAt) > INCOMING_CALL_RETENTION_MS) {
      incomingCallState.delete(key);
    }
  }
}

async function triggerScheduledCalls() {
  const now = new Date();
  const currentSlot = getCurrentSlotLabel(now);

  const dueCustomers = await dbAll(
    `SELECT c.*
     FROM customers c
     LEFT JOIN calls recent_call
       ON recent_call.customer_id = c.id
      AND DATETIME(recent_call.called_at) >= DATETIME('now', '-45 minutes')
     WHERE COALESCE(c.do_not_call, 0) = 0
       AND COALESCE(c.wrong_number_flag, 0) = 0
       AND COALESCE(c.admin_review_required, 0) = 0
       AND COALESCE(c.consent_status, 'unknown') != 'denied'
       AND COALESCE(c.status, 'pending') != 'calling'
       AND (
         (c.status = 'pending' AND COALESCE(c.best_call_slot, c.preferred_slot) <= ?)
         OR (c.status IN ('retry_scheduled', 'callback_scheduled') AND c.next_retry_at IS NOT NULL AND DATETIME(c.next_retry_at) <= DATETIME('now'))
       )
       AND (
         c.status IN ('retry_scheduled', 'callback_scheduled')
         OR recent_call.id IS NULL
       )`,
    [currentSlot]
  );

  if (!dueCustomers.length) {
    return;
  }

  const uniqueByPhone = new Map();
  for (const customer of dueCustomers) {
    const phoneKey = normalizePhoneLookupValue(customer.phone) || String(customer.phone || '').trim();
    if (!phoneKey) {
      continue;
    }

    if (uniqueByPhone.has(phoneKey)) {
      const existing = uniqueByPhone.get(phoneKey);
      console.log(
        `[SCHEDULER] Skipping duplicate customer row id=${customer.id} phone=${customer.phone} ` +
        `because row id=${existing.id} already queued`
      );
      continue;
    }

    uniqueByPhone.set(phoneKey, customer);
  }

  const hydratedCustomers = [];
  for (const customer of uniqueByPhone.values()) {
    hydratedCustomers.push(await hydratePreCallIntelligence(customer));
  }

  hydratedCustomers.sort((a, b) => (Number(b.priority_score) || 0) - (Number(a.priority_score) || 0));
  console.log(`[SCHEDULER] Found ${hydratedCustomers.length} eligible customer(s) due at ${currentSlot}`);

  for (const customer of hydratedCustomers) {
    try {
      const agentConfig = customer.default_agent_id ? await getAgentConfigById(customer.default_agent_id) : await getDefaultAgentConfig();
      const blockedReason = shouldBlockCustomerCall(customer);
      if (blockedReason) {
        console.log(`[SCHEDULER] Skipping ${customer.name}: ${blockedReason}`);
        continue;
      }

      const claimResult = await dbRun(
        `UPDATE customers
            SET status = ?,
                last_called_at = ?
          WHERE id = ?
            AND COALESCE(status, 'pending') IN ('pending', 'retry_scheduled', 'callback_scheduled')`,
        ['calling', new Date().toISOString(), customer.id]
      );

      if (!claimResult.changes) {
        console.log(`[SCHEDULER] Skipping ${customer.name}: already claimed by another run`);
        continue;
      }

      const call = await placeRealtimeCall({
        customerPhone: customer.phone,
        customerName: customer.name,
        customerId: customer.id,
        clientName: agentConfig?.client_name || CLIENT_NAME,
        agentId: agentConfig?.id || null
      });

      await dbRun(
        `INSERT INTO calls (
          customer_id, agent_id, outcome, provider_call_id, called_at, hot_lead_score,
          consent_message_played, call_script_version, supervisor_alert_level, call_direction, call_source
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          customer.id,
          agentConfig?.id || null,
          'scheduled_initiated',
          call.sid,
          new Date().toISOString(),
          customer.priority_score || computePriorityScore(customer),
          1,
          agentConfig?.slug || 'hindi-feedback-v1',
          'normal',
          'outbound',
          'icallmate'
        ]
      );
      await dbRun('UPDATE customers SET status = ? WHERE id = ?', ['called', customer.id]);
      console.log(`[SCHEDULER] Scheduled call started for ${customer.name} (${call.sid})`);
    } catch (error) {
      console.error(`[SCHEDULER] Failed to call ${customer.name}:`, error.message);
      try {
        await dbRun(
          `UPDATE customers
              SET status = ?
            WHERE id = ?
              AND status = 'calling'`,
          [customer.status || 'pending', customer.id]
        );
      } catch (rollbackError) {
        console.error(`[SCHEDULER] Failed to roll back customer ${customer.id}:`, rollbackError.message);
      }
    }
  }
}

async function triggerAnnualClientReminderCalls() {
  const now = new Date();
  const currentSlot = getCurrentSlotLabel(now);
  const currentYear = now.getUTCFullYear();

  const dueClients = await dbAll(
    `SELECT client.*
     FROM clients client
     LEFT JOIN calls recent_call
       ON recent_call.customer_id = client.linked_customer_id
      AND DATETIME(recent_call.called_at) >= DATETIME('now', '-45 minutes')
     WHERE COALESCE(client.annual_reminder_enabled, 1) = 1
       AND COALESCE(client.status, 'active') = 'active'
       AND client.next_annual_reminder_date IS NOT NULL
       AND DATE(client.next_annual_reminder_date) <= DATE('now')
       AND COALESCE(client.annual_reminder_slot, '10:00') <= ?
       AND COALESCE(client.last_annual_reminder_year, 0) < ?
       AND recent_call.id IS NULL
     ORDER BY client.next_annual_reminder_date ASC, client.annual_reminder_slot ASC`,
    [currentSlot, currentYear]
  );

  if (!dueClients.length) {
    return;
  }

  console.log(`[CLIENT REMINDER] Found ${dueClients.length} annual reminder client(s) due at ${currentSlot}`);

  for (const client of dueClients) {
    try {
      const customer = await ensureCustomerForClientReminder(client);
      const hydratedCustomer = await hydratePreCallIntelligence(customer);
      const blockedReason = shouldBlockCustomerCall(hydratedCustomer);
      if (blockedReason) {
        console.log(`[CLIENT REMINDER] Skipping ${client.name}: ${blockedReason}`);
        continue;
      }

      const agentConfig = hydratedCustomer.default_agent_id
        ? await getAgentConfigById(hydratedCustomer.default_agent_id)
        : await getDefaultAgentConfig();

      const claimResult = await dbRun(
        `UPDATE customers
            SET status = ?,
                last_called_at = ?
          WHERE id = ?
            AND COALESCE(status, 'pending') IN ('pending', 'retry_scheduled', 'callback_scheduled', 'called', 'completed')`,
        ['calling', new Date().toISOString(), hydratedCustomer.id]
      );

      if (!claimResult.changes) {
        console.log(`[CLIENT REMINDER] Skipping ${client.name}: customer row is already in use`);
        continue;
      }

      const call = await placeRealtimeCall({
        customerPhone: hydratedCustomer.phone,
        customerName: hydratedCustomer.name,
        customerId: hydratedCustomer.id,
        clientName: agentConfig?.client_name || CLIENT_NAME,
        agentId: agentConfig?.id || null
      });

      await dbRun(
        `INSERT INTO calls (
          customer_id, agent_id, outcome, provider_call_id, called_at, hot_lead_score,
          consent_message_played, call_script_version, supervisor_alert_level, call_direction, call_source
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          hydratedCustomer.id,
          agentConfig?.id || null,
          'scheduled_initiated',
          call.sid,
          new Date().toISOString(),
          hydratedCustomer.priority_score || computePriorityScore(hydratedCustomer),
          1,
          `annual-reminder:${client.treatment_type || 'client-care'}`,
          'normal',
          'outbound',
          'icallmate'
        ]
      );

      await dbRun('UPDATE customers SET status = ? WHERE id = ?', ['called', hydratedCustomer.id]);
      await dbRun(
        `UPDATE clients
            SET last_annual_reminder_at = ?,
                last_annual_reminder_year = ?,
                next_annual_reminder_date = ?,
                updated_at = ?
          WHERE id = ?`,
        [
          new Date().toISOString(),
          currentYear,
          computeNextAnnualReminderDate(client.last_visit_date, new Date(Date.UTC(currentYear + 1, 0, 1))),
          new Date().toISOString(),
          client.id
        ]
      );

      console.log(`[CLIENT REMINDER] Annual reminder call started for ${client.name} (${call.sid})`);
    } catch (error) {
      console.error(`[CLIENT REMINDER ERROR] ${client.name}: ${error.message}`);
    }
  }
}

let schedulerRunning = false;

async function runSchedulerTick() {
  if (schedulerRunning) {
    return;
  }

  schedulerRunning = true;
  try {
    await triggerAnnualClientReminderCalls();
    await triggerScheduledCalls();
  } finally {
    schedulerRunning = false;
  }
}

function toWssUrl(baseUrl, pathName) {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = pathName;
  url.search = '';
  url.hash = '';
  return url.toString();
}

function getRequestPublicBaseUrl(req) {
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

function xmlEscape(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

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

function isCustomerHangupIntent(text) {
  const normalized = String(text || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!normalized) {
    return false;
  }

  const patterns = [
    /\b(phone|call)\s+(kaat\s+do|kat\s+do|cut\s+do|band\s+karo|disconnect\s+karo|rakh\s+do)\b/i,
    /\b(kat|cut|disconnect|hang\s*up|band)\s+(the\s+)?(call|phone)\b/i,
    /\b(call|phone)\s+(band|close|disconnect|hangup)\s+(kar\s+do|karo)\b/i,
    /\bmain\s+(call|phone)\s+(rakh\s+raha|rakh\s+rahi)\s+(hoon|hu)\b/i,
    /\bbaad\s+mein\s+baat\s+karte\s+hai?n?\b/i,
    /\bnot\s+interested\b/i,
    /\bcall\s+mat\s+karo\b/i
  ];

  return patterns.some((pattern) => pattern.test(normalized));
}

function isAffirmativeAvailabilityResponse(text) {
  const normalized = String(text || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!normalized) {
    return false;
  }

  return /\b(haan|ha|han|yes|ji|bilkul|available|bolo|continue|sure)\b/.test(normalized)
    || /ho\s+sakti\s+hai/.test(normalized)
    || /ho\s+sakta\s+hai/.test(normalized)
    || /kar\s+sakte\s+hai/.test(normalized)
    || /kar\s+sakti\s+hoon/.test(normalized);
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

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    mode: CALL_MODE,
    pipeline: VOICE_PIPELINE,
    model: REALTIME_MODEL,
    publicBaseUrl: PUBLIC_BASE_URL,
    timestamp: new Date().toISOString()
  });
});

app.get('/', (req, res) => {
  if (readAuthSession(req)) {
    return res.redirect('/admin.html');
  }

  return res.redirect('/login.html');
});

app.get('/api/auth/session', (req, res) => {
  const session = readAuthSession(req);
  if (!session) {
    return res.status(401).json({ authenticated: false });
  }

  return res.json({
    authenticated: true,
    username: session.username
  });
});

app.post('/api/auth/login', (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');

  if (username !== ADMIN_USERNAME || password !== ADMIN_PASSWORD) {
    clearAuthCookie(req, res);
    return res.status(401).json({ error: 'Invalid username or password' });
  }

  const token = createAuthToken(username);
  setAuthCookie(req, res, token);
  return res.json({
    success: true,
    username
  });
});

app.post('/api/auth/logout', (req, res) => {
  clearAuthCookie(req, res);
  return res.json({ success: true });
});

app.use('/api/customers', customersRouter);
app.use('/api/clients', clientsRouter);
app.use('/api/campaigns', campaignsRouter);
app.use('/api/feedback', feedbackRouter);
app.use('/api/reports', reportsRouter);
app.use('/api/agents', agentsRouter);
app.use('/api/test-call', testCallRouter);
app.use('/api/test-ai-call', testAiCallRouter);

app.post('/call/start', async (req, res) => {
  let customer = null;
  try {
    const customerPhone = req.body.customerPhone || process.env.CUSTOMER_PHONE;
    const customerName = req.body.customerName || process.env.CUSTOMER_NAME;
    const requestedCustomerId = req.body.customerId;
    const requestedAgentId = Number(req.body.agentId || req.query.agentId || 0) || null;
    customer = await ensureCustomerForCall({
      customerId: requestedCustomerId,
      customerName,
      customerPhone
    });
    customer = await hydratePreCallIntelligence(customer);
    const agentConfig = requestedAgentId ? await getAgentConfigById(requestedAgentId) : await getDefaultAgentConfig();
    const clientName = req.body.clientName || agentConfig?.client_name || CLIENT_NAME;

    const blockedReason = shouldBlockCustomerCall(customer);
    if (blockedReason) {
      return res.status(409).json({ success: false, error: blockedReason });
    }

    const claimed = await claimCustomerForOutboundCall(customer.id);
    if (!claimed) {
      return res.status(409).json({ success: false, error: 'A call for this customer is already in progress' });
    }

    console.log(
      `[CALL REQUEST] to=${customerPhone} serviceNo=${process.env.ICALLMATE_SERVICE_NO || ''} baseUrl=${PUBLIC_BASE_URL} ` +
      `mode=${CALL_MODE} pipeline=${VOICE_PIPELINE} model=${REALTIME_MODEL}`
    );
    console.log(
    `[CALL REQUEST CONFIG] ` +
      `APP_BASE_URL=${describeEnvValue(process.env.APP_BASE_URL || '')} ` +
      `NGROK_URL=${describeEnvValue(process.env.NGROK_URL || '')} ` +
      `WEBHOOK_URL=${describeEnvValue(process.env.WEBHOOK_URL || '')} ` +
      `SERVER_NAME=${describeEnvValue(process.env.SERVER_NAME || '')} ` +
      `ICALLMATE_OBD_API_ENDPOINT=${process.env.ICALLMATE_OBD_API_ENDPOINT || 'https://ecp1.icallmate.in'} ` +
      `ICALLMATE_SERVICE_NO=${process.env.ICALLMATE_SERVICE_NO || ''} ` +
      `ICALLMATE_IVR_TEMPLATE_ID=${process.env.ICALLMATE_IVR_TEMPLATE_ID || ''} ` +
      `GEMINI_MODEL=${GEMINI_MODEL} ` +
      `GEMINI_VOICE=${GEMINI_VOICE} ` +
      `TZ=${process.env.TZ || ''}`
    );
    const call = await placeRealtimeCall({
      customerPhone,
      customerName: customer.name || customerName,
      customerId: customer.id,
      clientName,
      agentId: agentConfig?.id || null
    });

    const result = await dbRun(
      `INSERT INTO calls (
        customer_id, agent_id, outcome, provider_call_id, called_at, hot_lead_score,
        consent_message_played, call_script_version, supervisor_alert_level, call_direction, call_source
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        customer.id,
        agentConfig?.id || null,
        'initiated',
        call.sid,
        new Date().toISOString(),
        customer.priority_score || computePriorityScore(customer),
        1,
        agentConfig?.slug || 'hindi-feedback-v1',
        'normal',
        'outbound',
        'icallmate'
      ]
    );
    await dbRun('UPDATE customers SET status = ? WHERE id = ?', ['called', customer.id]);

    schedulePendingCallDiagnostic(call.sid, {
      customerId: customer.id,
      customerPhone,
      customerName: customer.name || customerName,
      agentId: agentConfig?.id || null,
      trigger: '/call/start'
    });
    console.log(`[CALL STARTED] SID: ${call.sid}`);
    res.json({ success: true, sid: call.sid, callId: result.lastID, customerId: customer.id, agentId: agentConfig?.id || null });
  } catch (error) {
    if (customer?.id) {
      try {
        await releaseCustomerOutboundClaim(customer.id, customer.status || 'pending');
      } catch (releaseError) {
        console.error('[CALL CLAIM RELEASE ERROR]', releaseError.message);
      }
    }
    console.error('[ERROR starting call]', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/call/scripted/consent', (req, res) => {
  console.log(`[SCRIPTED] Consent lang=${req.query.lang || 'hi'} digits=${req.body.Digits || ''} speech=${req.body.SpeechResult || ''}`);
  res.type('text/xml').send(buildScriptedConsentResponse(req));
});

app.post('/call/scripted/language', (req, res) => {
  console.log(`[SCRIPTED] Language digits=${req.body.Digits || ''} speech=${req.body.SpeechResult || ''}`);
  res.type('text/xml').send(buildScriptedLanguageResponse(req));
});

app.post('/call/scripted/rating', (req, res) => {
  res.type('text/xml').send(buildScriptedRatingResponse(req));
});

app.all('/call/status', async (req, res) => {
  try {
    const providerStatus = pickRequestValue(req, ['CallStatus', 'Status', 'status']);
    const providerCallSid = pickRequestValue(req, ['CallSid', 'call_sid', 'Sid', 'sid']);
    const providerRecordingUrl = pickRequestValue(req, ['RecordingUrl', 'recording_url']);
    const providerRecordingSid = pickRequestValue(req, ['RecordingSid', 'recording_sid']);
    const eventType = pickRequestValue(req, ['EventType', 'event_type']);
    console.log(
      `[CALL STATUS] method=${req.method} status=${providerStatus || ''} sid=${providerCallSid || ''} ` +
      `query=${JSON.stringify(req.query || {})} bodyKeys=${JSON.stringify(Object.keys(req.body || {}))}`
    );

    if (providerCallSid) {
      markPendingCallDiagnostic(providerCallSid, {
        statusHitAt: new Date().toISOString(),
        statusMethod: req.method,
        providerStatus: providerStatus || null,
        eventType: eventType || null
      });
    }

    const callRecord = await dbGet('SELECT * FROM calls WHERE provider_call_id = ?', [providerCallSid]);
    const customerId = req.query.customerId || callRecord?.customer_id;

    if (callRecord) {
      let mappedOutcome = null;
      if (providerStatus === 'completed') mappedOutcome = 'completed';
      if (providerStatus === 'no-answer') mappedOutcome = 'no_answer';
      if (providerStatus === 'failed') mappedOutcome = 'failed';
      if (providerStatus === 'busy') mappedOutcome = 'busy';

      const normalizedRecordingUrl = providerRecordingUrl
        ? String(providerRecordingUrl).endsWith('.mp3') ? providerRecordingUrl : `${providerRecordingUrl}.mp3`
        : null;

      if (normalizedRecordingUrl || providerRecordingSid) {
        await dbRun(
          `UPDATE calls
              SET recording_sid = COALESCE(?, recording_sid),
                  recording_url = COALESCE(?, recording_url),
                  recording_status = ?
            WHERE id = ?`,
          [
            providerRecordingSid || null,
            normalizedRecordingUrl,
            normalizedRecordingUrl ? 'completed' : (providerStatus || eventType || 'pending'),
            callRecord.id
          ]
        );
      }

      if (mappedOutcome) {
        await dbRun('UPDATE calls SET outcome = ?, outcome_detail = ? WHERE id = ?', [mappedOutcome, providerStatus, callRecord.id]);
      }

      if (mappedOutcome === 'completed' && normalizedRecordingUrl) {
        setTimeout(() => {
          runInBackground('POST CALL PIPELINE ERROR', async () => {
            const result = await processCompletedCallPipeline({ dbGet, dbRun, callSid: providerCallSid });
            if (result.ok) {
              console.log(`[POST CALL PIPELINE] Processed call ${providerCallSid} with feedback ${result.feedbackId}`);
            } else {
              console.log(`[POST CALL PIPELINE] Skipped call ${providerCallSid}: ${result.reason}`);
            }
          });
        }, 1500);
      }

      if (customerId) {
        const customer = await dbGet('SELECT * FROM customers WHERE id = ?', [customerId]);
        if (customer && mappedOutcome) {
          await applyCallOutcomeWorkflow({
            dbGet,
            dbRun,
            callRecord: { ...callRecord, outcome: mappedOutcome },
            customer,
            providerStatus: mappedOutcome,
            inferredOutcome: mappedOutcome
          });
        }
      }
    }

    res.sendStatus(200);
  } catch (error) {
    console.error('[CALL STATUS ERROR]', error.message);
    res.sendStatus(500);
  }
});

app.post('/call/recording-status', async (req, res) => {
  try {
    const callSid = req.body.CallSid;
    const recordingSid = req.body.RecordingSid;
    const recordingStatus = req.body.RecordingStatus;
    const recordingUrl = req.body.RecordingUrl ? `${req.body.RecordingUrl}.mp3` : null;

    console.log(`[RECORDING STATUS] ${recordingStatus} | Call SID: ${callSid} | Recording SID: ${recordingSid}`);

    const callRecord = await dbGet('SELECT * FROM calls WHERE provider_call_id = ?', [callSid]);
    if (callRecord) {
      await dbRun(
        `UPDATE calls
            SET recording_sid = ?,
                recording_url = ?,
                recording_status = ?
          WHERE id = ?`,
        [recordingSid || null, recordingUrl, recordingStatus || null, callRecord.id]
      );

      if (recordingStatus === 'completed' && recordingUrl) {
        setTimeout(() => {
          runInBackground('POST CALL PIPELINE ERROR', async () => {
            const result = await processCompletedCallPipeline({ dbGet, dbRun, callSid });
            if (result.ok) {
              console.log(`[POST CALL PIPELINE] Processed call ${callSid} with feedback ${result.feedbackId}`);
            } else {
              console.log(`[POST CALL PIPELINE] Skipped call ${callSid}: ${result.reason}`);
            }
          });
        }, 1500);
      }
    }

    res.sendStatus(200);
  } catch (error) {
    console.error('[RECORDING STATUS ERROR]', error.message);
    res.sendStatus(500);
  }
});

app.post('/api/calls/initiate/:customerId', async (req, res) => {
  let customer = null;
  try {
    customer = await dbGet('SELECT * FROM customers WHERE id = ?', [req.params.customerId]);
    if (!customer) {
      return res.status(404).json({ error: 'Customer not found' });
    }

    customer = await hydratePreCallIntelligence(customer);
    const requestedAgentId = Number(req.body?.agentId || req.query.agentId || customer.default_agent_id || 0) || null;
    const agentConfig = requestedAgentId ? await getAgentConfigById(requestedAgentId) : await getDefaultAgentConfig();
    const blockedReason = shouldBlockCustomerCall(customer);
    if (blockedReason) {
      return res.status(409).json({ error: blockedReason });
    }

    const claimed = await claimCustomerForOutboundCall(customer.id);
    if (!claimed) {
      return res.status(409).json({ error: 'A call for this customer is already in progress' });
    }

    const call = await placeRealtimeCall({
      customerPhone: customer.phone,
      customerName: customer.name,
      customerId: customer.id,
      clientName: agentConfig?.client_name || CLIENT_NAME,
      agentId: agentConfig?.id || null
    });

    const result = await dbRun(
      `INSERT INTO calls (
        customer_id, agent_id, outcome, provider_call_id, called_at, hot_lead_score,
        consent_message_played, call_script_version, supervisor_alert_level, call_direction, call_source
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        customer.id,
        agentConfig?.id || null,
        'initiated',
        call.sid,
        new Date().toISOString(),
        customer.priority_score || computePriorityScore(customer),
        1,
        agentConfig?.slug || 'hindi-feedback-v1',
        'normal',
        'outbound',
        'icallmate'
      ]
    );

    await dbRun('UPDATE customers SET status = ? WHERE id = ?', ['called', customer.id]);
    schedulePendingCallDiagnostic(call.sid, {
      customerId: customer.id,
      customerPhone: customer.phone,
      customerName: customer.name,
      agentId: agentConfig?.id || null,
      trigger: '/api/calls/initiate/:customerId'
    });
    res.json({ message: 'Call initiated', callId: result.lastID, sid: call.sid, agentId: agentConfig?.id || null, agentName: agentConfig?.name || null });
  } catch (error) {
    if (customer?.id) {
      try {
        await releaseCustomerOutboundClaim(customer.id, customer.status || 'pending');
      } catch (releaseError) {
        console.error('[API CALL CLAIM RELEASE ERROR]', releaseError.message);
      }
    }
    console.error('[API CALL INITIATE ERROR]', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/calls/incoming', async (req, res) => {
  pruneIncomingCallState();
  const dbRows = await dbAll(
    `SELECT
       calls.id,
       calls.provider_call_id AS stream_id,
       customers.name AS caller_name,
       customers.phone AS phone,
       calls.did,
       calls.call_direction,
       calls.outcome AS status,
       calls.called_at AS received_at,
       calls.answered_at,
       calls.ended_at,
       calls.media_packets,
       calls.last_event,
       calls.notes,
       calls.created_at,
       calls.provider_payload_json
     FROM calls
     JOIN customers ON customers.id = calls.customer_id
     WHERE calls.call_direction = 'incoming'
     ORDER BY COALESCE(calls.ended_at, calls.answered_at, calls.called_at, calls.created_at) DESC
     LIMIT 100`
  );

  const seen = new Set(dbRows.map((row) => row.stream_id).filter(Boolean));
  const liveOnlyRows = [...incomingCallState.values()].filter((row) => row.stream_id && !seen.has(row.stream_id));
  const calls = [
    ...dbRows.map((row) => ({
      ...row,
      status: row.status || 'active',
      updated_at: row.ended_at || row.answered_at || row.received_at || row.created_at
    })),
    ...liveOnlyRows
  ].sort((a, b) => new Date(b.updated_at || b.received_at || 0) - new Date(a.updated_at || a.received_at || 0));

  res.json({
    calls,
    active_count: calls.filter((call) => call.status === 'active').length,
    missed_count: calls.filter((call) => call.status === 'missed').length,
    completed_count: calls.filter((call) => call.status === 'completed').length,
    total_media_packets: calls.reduce((sum, call) => sum + Number(call.media_packets || 0), 0),
    updated_at: new Date().toISOString()
  });
});

app.get('/api/calls/metrics', async (req, res) => {
  try {
    const rows = await dbAll(
      `SELECT
         COALESCE(call_direction, 'outbound') AS direction,
         COALESCE(outcome, 'unknown') AS outcome,
         COUNT(*) AS count,
         SUM(CASE WHEN DATE(called_at) = DATE('now') THEN 1 ELSE 0 END) AS today_count,
         SUM(COALESCE(media_packets, 0)) AS media_packets
       FROM calls
       GROUP BY COALESCE(call_direction, 'outbound'), COALESCE(outcome, 'unknown')`
    );

    const summary = {
      inbound: { total: 0, today: 0, active: 0, completed: 0, missed: 0, media_packets: 0 },
      outbound: { total: 0, today: 0, initiated: 0, completed: 0, failed: 0, scheduled: 0, media_packets: 0 },
      all: { total: 0, today: 0, media_packets: 0 }
    };

    for (const row of rows) {
      const direction = row.direction === 'incoming' ? 'inbound' : 'outbound';
      const outcome = String(row.outcome || 'unknown').toLowerCase();
      const count = Number(row.count || 0);
      const todayCount = Number(row.today_count || 0);
      const mediaPackets = Number(row.media_packets || 0);
      const target = summary[direction];

      target.total += count;
      target.today += todayCount;
      target.media_packets += mediaPackets;
      summary.all.total += count;
      summary.all.today += todayCount;
      summary.all.media_packets += mediaPackets;

      if (direction === 'inbound') {
        if (outcome === 'active') target.active += count;
        if (outcome === 'completed') target.completed += count;
        if (outcome === 'missed') target.missed += count;
      } else {
        if (['initiated', 'scheduled_initiated', 'active'].includes(outcome)) target.initiated += count;
        if (outcome === 'completed') target.completed += count;
        if (['failed', 'busy', 'no_answer'].includes(outcome)) target.failed += count;
        if (outcome === 'scheduled_initiated') target.scheduled += count;
      }
    }

    res.json({
      ...summary,
      updated_at: new Date().toISOString()
    });
  } catch (error) {
    console.error('[CALL METRICS ERROR]', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/icallmate/config', async (req, res) => {
  const requestBaseUrl = getRequestPublicBaseUrl(req);
  res.json({
    websocket_url: `${toWssUrl(requestBaseUrl, '/icallmate/media')}`,
    did: process.env.ICALLMATE_DID || ICALLMATE_DEFAULT_DID,
    test_number: process.env.ICALLMATE_TEST_NUMBER || ICALLMATE_DEFAULT_TEST_NUMBER,
    incoming_api_endpoint: process.env.ICALLMATE_IBD_API_ENDPOINT || 'https://crm.icallmate.in',
    outbound_api_endpoint: process.env.ICALLMATE_OBD_API_ENDPOINT || 'https://ecp1.icallmate.in',
    callback_url: `${requestBaseUrl}/api/icallmate/callback`,
    audio_format: {
      sampleRate: 8000,
      encoding: 'LINEAR16',
      channels: 1,
      bitsPerSample: 16
    }
  });
});

app.post('/api/icallmate/callback', async (req, res) => {
  try {
    const payload = req.body || {};
    const key = String(payload.ref_no || payload.leadid || payload.phoneno || `${Date.now()}`);
    const callType = String(payload.call_type || '').toLowerCase();
    const status = String(payload.call_status || '') === '1' ? 'completed' : 'missed';
    const eventName = payload.event || payload.call_event || payload.call_status || 'callback';
    const callerId = payload.callerId || payload.phoneno || payload.customer_number || '';
    const did = payload.did || payload.serviceno || payload.dnis || '';

    console.log(
      `[ICALLMATE CALLBACK] event=${eventName} key=${key} callerId=${callerId} did=${did} ` +
      `callType=${callType || 'unknown'} status=${status}`
    );

    if (callType === 'inbound' || callType === 'inbou' || !callType) {
      incomingCallState.set(key, {
        id: key,
        stream_id: key,
        caller_name: payload.customer_name || 'Incoming caller',
        phone: payload.phoneno || '--',
        did: payload.serviceno || '',
        call_direction: 'incoming',
        status,
        received_at: normalizeIcallTimestamp(payload.call_start_time),
        updated_at: new Date().toISOString(),
        notes: payload.recording_filename ? 'Callback received with recording' : 'Callback received',
        last_event: 'callback',
        answered_at: payload.call_ansd_time ? normalizeIcallTimestamp(payload.call_ansd_time) : null,
        ended_at: payload.call_end_time ? normalizeIcallTimestamp(payload.call_end_time) : null,
        recording_url: payload.recording_filename || '',
        talktime: payload.talktime || ''
      });

      await upsertIncomingCallFromIcall({
        streamId: key,
        callerId: callerId || payload.phoneno || '',
        did,
        event: 'callback',
        timestamp: payload.call_start_time || payload.timestamp,
        extraParams: JSON.stringify({ callbackPayload: true })
      }, {
        status,
        call_direction: 'incoming',
        caller_name: payload.customer_name || 'Incoming caller',
        answered_at: payload.call_ansd_time ? normalizeIcallTimestamp(payload.call_ansd_time) : null,
        ended_at: payload.call_end_time ? normalizeIcallTimestamp(payload.call_end_time) : null,
        notes: payload.recording_filename ? 'Callback received with recording' : 'Callback received'
      });
    }

    res.json({ success: true });
  } catch (error) {
    console.error('[ICALLMATE CALLBACK ERROR]', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/icallmate/incoming-config', async (req, res) => {
  try {
    const requestBaseUrl = getRequestPublicBaseUrl(req);
    const dnisNo = String(req.body.dnisNo || req.body.virtualNumber || process.env.ICALLMATE_DID || ICALLMATE_DEFAULT_DID).trim();
    if (!dnisNo) {
      return res.status(400).json({ error: 'dnisNo or virtualNumber is required' });
    }

    const endpoint = `${String(process.env.ICALLMATE_IBD_API_ENDPOINT || 'https://crm.icallmate.in').replace(/\/+$/, '')}/Test_WSS/setMacroDnis`;
    const websocketUrl = req.body.wsurl || req.body.websocket_url || `${toWssUrl(requestBaseUrl, '/icallmate/media')}`;
    const callbackUrl = req.body.callbackapi || req.body.callback_url || `${requestBaseUrl}/api/icallmate/callback`;
    const macros = [
      { dnisNo, macroName: 'llm_wssurl', macroValue: websocketUrl },
      { dnisNo, macroName: 'llm_botid', macroValue: String(req.body.botid || process.env.ICALLMATE_BOT_ID || '') },
      { dnisNo, macroName: 'llm_agentid', macroValue: String(req.body.agentid || process.env.ICALLMATE_AGENT_ID || '') },
      { dnisNo, macroName: 'llm_extraparam', macroValue: String(req.body.extraParams || req.body.extra_param || 'path-lab') },
      { dnisNo, macroName: 'llm_iscallbackapi', macroValue: String(req.body.iscallbackapi ?? '0') },
      { dnisNo, macroName: 'llm_callbackapi', macroValue: callbackUrl }
    ];

    if (String(req.body.dryRun || '').toLowerCase() === 'true') {
      return res.json({ endpoint, macros, dryRun: true });
    }

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(macros)
    });
    const text = await response.text();
    let parsed = {};
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch (error) {
      parsed = { rawText: text };
    }
    const providerSuccess = response.ok && String(parsed.status || '').toLowerCase() !== 'failure';

    res.status(providerSuccess ? 200 : (response.ok ? 502 : response.status)).json({
      success: providerSuccess,
      endpoint,
      macros,
      response: text
    });
  } catch (error) {
    console.error('[ICALLMATE INCOMING CONFIG ERROR]', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/icallmate/outbound-campaign', async (req, res) => {
  try {
    const requestBaseUrl = getRequestPublicBaseUrl(req);
    const endpoint = `${String(process.env.ICALLMATE_OBD_API_ENDPOINT || 'https://ecp1.icallmate.in').replace(/\/+$/, '')}/OBDAPI/webresources/CreateOBDCampaignPost`;
    const msisdnlist = Array.isArray(req.body.msisdnlist) ? req.body.msisdnlist : [];
    if (!msisdnlist.length) {
      return res.status(400).json({ error: 'msisdnlist is required' });
    }

    const payload = {
      sourcetype: String(req.body.sourcetype || '0'),
      customivr: req.body.customivr ?? true,
      campaigntype: String(req.body.campaigntype || '4'),
      filetype: String(req.body.filetype || '2'),
      ukey: req.body.ukey || process.env.ICALLMATE_UKEY || '',
      serviceno: req.body.serviceno || process.env.ICALLMATE_SERVICE_NO || '',
      ivrtemplateid: req.body.ivrtemplateid || process.env.ICALLMATE_IVR_TEMPLATE_ID || '',
      maxTalkTimeInSec: Number(req.body.maxTalkTimeInSec || 0),
      retryatmpt: String(req.body.retryatmpt || '2'),
      sendnow: String(req.body.sendnow || '0'),
      schddate: req.body.schddate || '',
      retryduration: String(req.body.retryduration || '5'),
      s_unique: req.body.s_unique || '',
      msisdnlist: msisdnlist.map((item) => ({
        ...item,
        wsurl: item.wsurl || `${toWssUrl(requestBaseUrl, '/icallmate/media')}`,
        agentid: String(item.agentid || process.env.ICALLMATE_AGENT_ID || '0'),
        iscallbackapi: String(item.iscallbackapi ?? '0'),
        callbackapi: item.callbackapi || `${requestBaseUrl}/api/icallmate/callback`
      }))
    };

    if (String(req.body.dryRun || '').toLowerCase() === 'true') {
      return res.json({ endpoint, payload, dryRun: true });
    }

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const text = await response.text();
    let parsed = {};
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch (error) {
      parsed = { rawText: text };
    }
    const providerSuccess = response.ok && String(parsed.status || '').toLowerCase() !== 'failure';

    res.status(providerSuccess ? 200 : (response.ok ? 502 : response.status)).json({
      success: providerSuccess,
      endpoint,
      response: text
    });
  } catch (error) {
    console.error('[ICALLMATE OUTBOUND CAMPAIGN ERROR]', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.get('/icallmate/health', (req, res) => {
  const requestBaseUrl = getRequestPublicBaseUrl(req);
  res.json({
    ok: true,
    websocket_path: '/icallmate/media',
    websocket_url: `${toWssUrl(requestBaseUrl, '/icallmate/media')}`,
    did: process.env.ICALLMATE_DID || ICALLMATE_DEFAULT_DID,
    test_number: process.env.ICALLMATE_TEST_NUMBER || ICALLMATE_DEFAULT_TEST_NUMBER,
    timestamp: new Date().toISOString()
  });
});

app.get('/icallmate/media', (req, res) => {
  const requestBaseUrl = getRequestPublicBaseUrl(req);
  res.status(426).json({
    error: 'WebSocket upgrade required',
    websocket_url: `${toWssUrl(requestBaseUrl, '/icallmate/media')}`,
    expected_protocol: 'wss',
    did: process.env.ICALLMATE_DID || ICALLMATE_DEFAULT_DID
  });
});

app.get('/api/calls/recent', async (req, res) => {
  try {
    const rows = await dbAll(
      `SELECT
         calls.id,
         calls.customer_id,
         calls.agent_id,
         customers.name AS customer_name,
         customers.phone AS customer_phone,
         agents.name AS agent_name,
         agents.slug AS agent_slug,
         calls.called_at,
         calls.outcome,
         calls.call_direction,
         calls.call_source,
         calls.did,
         calls.media_packets,
         calls.answered_at,
         calls.ended_at,
         calls.notes,
         calls.provider_call_id,
         calls.recording_sid,
         calls.recording_url,
         calls.recording_status,
         calls.recording_local_path,
         calls.transcript_status,
         calls.transcript_source,
         calls.analysis_status,
         calls.analysis_summary,
         calls.analysis_json,
         calls.key_points_json,
         calls.report_excerpt,
         calls.language,
         calls.extracted_rating,
         calls.extracted_review_text,
         calls.sentiment_label,
         calls.sentiment_score,
         calls.hot_lead_score,
         calls.next_action_at,
         calls.follow_up_task,
         calls.crm_sync_status,
         calls.whatsapp_summary_sent,
         calls.live_sentiment_score,
         calls.live_sentiment_label,
         calls.live_red_flag,
         calls.supervisor_alert_level,
         calls.human_escalation_requested,
         calls.objections_json,
         calls.competitor_mentions_json
       FROM calls
       JOIN customers ON customers.id = calls.customer_id
       LEFT JOIN agents ON agents.id = calls.agent_id
       ORDER BY calls.id DESC
       LIMIT 25`
    );

    res.json(rows);
  } catch (error) {
    console.error('[RECENT CALLS ERROR]', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/calls/:callId(\\d+)', async (req, res) => {
  try {
    const row = await dbGet(
      `SELECT
         calls.id,
         calls.customer_id,
         calls.agent_id,
         customers.name AS customer_name,
         customers.phone AS customer_phone,
         agents.name AS agent_name,
         agents.slug AS agent_slug,
         calls.called_at,
         calls.outcome,
         calls.call_direction,
         calls.call_source,
         calls.did,
         calls.media_packets,
         calls.answered_at,
         calls.ended_at,
         calls.notes,
         calls.provider_call_id,
         calls.recording_sid,
         calls.recording_url,
         calls.recording_status,
         calls.recording_local_path,
         calls.transcript_status,
         calls.transcript_source,
         calls.analysis_status,
         calls.analysis_summary,
         calls.analysis_json,
         calls.key_points_json,
         calls.report_excerpt,
         calls.language,
         calls.extracted_rating,
         calls.extracted_review_text,
         calls.sentiment_label,
         calls.sentiment_score,
         calls.hot_lead_score,
         calls.next_action_at,
         calls.follow_up_task,
         calls.crm_sync_status,
         calls.whatsapp_summary_sent,
         calls.live_sentiment_score,
         calls.live_sentiment_label,
         calls.live_red_flag,
         calls.supervisor_alert_level,
         calls.human_escalation_requested,
         calls.objections_json,
         calls.competitor_mentions_json
       FROM calls
       JOIN customers ON customers.id = calls.customer_id
       LEFT JOIN agents ON agents.id = calls.agent_id
      WHERE calls.id = ?`,
      [req.params.callId]
    );

    if (!row) {
      return res.status(404).json({ error: 'Call not found' });
    }

    res.json(row);
  } catch (error) {
    console.error('[CALL DETAIL ERROR]', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/calls/live', async (req, res) => {
  try {
    pruneLiveCallState();
    const inMemoryRows = [...liveCallState.values()];
    const seenCallSids = new Set(inMemoryRows.map((row) => row.call_sid).filter(Boolean));
    const now = Date.now();
    const recentDbRows = await dbAll(
      `SELECT
         calls.id,
         calls.customer_id,
         calls.agent_id,
         calls.called_at,
         calls.outcome,
         calls.provider_call_id,
         calls.transcript_text,
         calls.live_sentiment_score,
         calls.live_sentiment_label,
         calls.live_red_flag,
         calls.supervisor_alert_level,
         calls.human_escalation_requested,
         customers.name AS customer_name,
         agents.name AS agent_name
       FROM calls
       JOIN customers ON customers.id = calls.customer_id
       LEFT JOIN agents ON agents.id = calls.agent_id
       WHERE DATETIME(calls.called_at) >= DATETIME('now', '-60 minutes')
       ORDER BY calls.called_at DESC
       LIMIT 12`
    );

    const mergedRows = [
      ...inMemoryRows,
      ...recentDbRows
        .filter((row) => row.provider_call_id && !seenCallSids.has(row.provider_call_id))
        .map((row) => {
          const calledAtMs = new Date(row.called_at || 0).getTime();
          const isFreshPending = (
            (row.outcome === 'initiated' || row.outcome === 'scheduled_initiated')
            && calledAtMs
            && !Number.isNaN(calledAtMs)
            && (now - calledAtMs) <= (10 * 60 * 1000)
          );

          return {
            call_sid: row.provider_call_id,
            customer_name: row.customer_name,
            customer_id: row.customer_id,
            call_id: row.id,
            started_at: row.called_at,
            transcript_preview: buildTranscriptPreviewText(row.transcript_text),
            live_sentiment_label: row.live_sentiment_label || 'neutral',
            live_sentiment_score: Number(row.live_sentiment_score || 0),
            red_flag: Boolean(Number(row.live_red_flag || 0)),
            escalation_requested: Boolean(Number(row.human_escalation_requested || 0)),
            status: isFreshPending ? 'active' : 'recent',
            agent_id: row.agent_id,
            agent_name: row.agent_name || 'Default Feedback Agent',
            supervisor_alert_level: row.supervisor_alert_level || 'normal'
          };
        })
    ].sort((a, b) => new Date(b.started_at || 0) - new Date(a.started_at || 0));

    res.json(mergedRows);
  } catch (error) {
    console.error('[LIVE CALLS ERROR]', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/calls/:callId/supervisor-events', async (req, res) => {
  try {
    const rows = await dbAll(
      'SELECT * FROM call_supervisor_events WHERE call_id = ? ORDER BY created_at DESC LIMIT 50',
      [req.params.callId]
    );
    res.json(rows);
  } catch (error) {
    console.error('[SUPERVISOR EVENTS ERROR]', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/calls/:callId/escalate', async (req, res) => {
  try {
    await dbRun(
      'UPDATE calls SET human_escalation_requested = ?, supervisor_alert_level = ?, supervisor_notes = ? WHERE id = ?',
      [1, 'critical', String(req.body.note || 'Manual escalation requested').trim(), req.params.callId]
    );
    await createSupervisorEvent({
      dbRun,
      callId: Number(req.params.callId),
      eventType: 'human_escalation_requested',
      severity: 'critical',
      payload: { note: String(req.body.note || 'Manual escalation requested').trim() }
    });
    res.json({ success: true });
  } catch (error) {
    console.error('[CALL ESCALATION ERROR]', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/calls/:callId/recording', async (req, res) => {
  try {
    const call = await dbGet('SELECT id, provider_call_id, recording_url, recording_status FROM calls WHERE id = ?', [req.params.callId]);

    if (!call?.recording_url && !call?.provider_call_id) {
      return res.status(404).json({ error: 'Recording not available yet' });
    }

    let playbackUrl = call.recording_url || null;
    let response = playbackUrl
      ? await fetch(playbackUrl)
      : null;

    if (!response || !response.ok) {
      const statusCode = response?.status || 404;
      return res.status(statusCode).json({ error: `Unable to fetch recording (${statusCode})` });
    }

    const arrayBuffer = await response.arrayBuffer();
    res.setHeader('Content-Type', response.headers.get('content-type') || 'audio/mpeg');
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.send(Buffer.from(arrayBuffer));
  } catch (error) {
    console.error('[RECORDING PROXY ERROR]', error.message);
    res.status(500).json({ error: 'Failed to stream recording' });
  }
});

app.get('/api/calls/:callId/transcript', async (req, res) => {
  try {
    const call = await dbGet(
      `SELECT
         calls.id,
         calls.provider_call_id,
         calls.called_at,
         calls.outcome,
         calls.language,
         calls.transcript_text,
         calls.transcript_status,
         customers.name AS customer_name
       FROM calls
       LEFT JOIN customers ON customers.id = calls.customer_id
       WHERE calls.id = ?`,
      [req.params.callId]
    );

    if (!call) {
      return res.status(404).json({ error: 'Call not found' });
    }

    if (!call.transcript_text) {
      return res.status(404).json({ error: 'Transcript not available yet' });
    }

    res.setHeader('Cache-Control', 'private, max-age=300');

    if (String(req.query.raw || '') === '1') {
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.send(call.transcript_text);
      return;
    }

    const turns = String(call.transcript_text || '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const match = line.match(/^\[([A-Z]+)\]:\s*(.*)$/);
        return {
          role: match?.[1] || 'NOTE',
          text: match?.[2] || line
        };
      });

    const escapedTurns = turns.map((turn) => ({
      role: String(turn.role).replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char])),
      text: String(turn.text).replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char]))
    }));

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Call Transcript</title>
  <style>
    :root {
      --bg: #f4f8ff;
      --panel: #ffffff;
      --line: rgba(118, 146, 182, 0.18);
      --text: #18233f;
      --muted: #6f7e99;
      --blue: #2d6df6;
      --green: #2ea043;
      --shadow: 0 18px 40px rgba(65, 92, 136, 0.12);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "Aptos", "Segoe UI", sans-serif;
      background: linear-gradient(180deg, #f9fbff 0%, #eef4ff 100%);
      color: var(--text);
      padding: 28px;
    }
    .shell {
      max-width: 980px;
      margin: 0 auto;
      background: rgba(255,255,255,0.88);
      border: 1px solid var(--line);
      border-radius: 28px;
      box-shadow: var(--shadow);
      overflow: hidden;
    }
    .hero {
      padding: 28px 30px 20px;
      border-bottom: 1px solid var(--line);
      background: linear-gradient(135deg, rgba(45,109,246,0.10), rgba(45,109,246,0.02));
    }
    .hero h1 { margin: 0 0 8px; font-size: 30px; }
    .muted { color: var(--muted); }
    .meta {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
      gap: 14px;
      margin-top: 18px;
    }
    .meta-card {
      padding: 14px 16px;
      border-radius: 18px;
      background: #fff;
      border: 1px solid var(--line);
    }
    .meta-card strong { display: block; font-size: 12px; color: var(--muted); margin-bottom: 6px; text-transform: uppercase; letter-spacing: 0.04em; }
    .body { padding: 26px 30px 30px; }
    .actions { display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 22px; }
    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 12px 16px;
      border-radius: 14px;
      border: 1px solid var(--line);
      background: #fff;
      color: var(--text);
      text-decoration: none;
      font-weight: 700;
    }
    .btn.primary { background: linear-gradient(135deg, #2d6df6 0%, #1d57d7 100%); color: #fff; border-color: transparent; }
    .turns { display: grid; gap: 14px; }
    .turn {
      border-radius: 20px;
      padding: 16px 18px;
      border: 1px solid var(--line);
      background: #fff;
    }
    .turn.agent { border-left: 4px solid var(--blue); }
    .turn.customer { border-left: 4px solid var(--green); }
    .turn.note { border-left: 4px solid #9aa9c5; }
    .turn-role {
      font-size: 12px;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: var(--muted);
      font-weight: 800;
      margin-bottom: 8px;
    }
    .turn-text {
      white-space: pre-wrap;
      line-height: 1.7;
      font-size: 15px;
    }
  </style>
</head>
<body>
  <div class="shell">
    <div class="hero">
      <h1>Call Transcript</h1>
      <div class="muted">Readable transcript view for review, QA, and reporting.</div>
      <div class="meta">
        <div class="meta-card"><strong>Customer</strong>${call.customer_name || 'Customer'}</div>
        <div class="meta-card"><strong>Call SID</strong>${call.provider_call_id || '--'}</div>
        <div class="meta-card"><strong>Outcome</strong>${call.outcome || '--'}</div>
        <div class="meta-card"><strong>Called At</strong>${call.called_at ? new Date(call.called_at).toLocaleString() : '--'}</div>
      </div>
    </div>
    <div class="body">
      <div class="actions">
        <a class="btn primary" href="${getSecurePublicBaseUrl() || ''}/admin.html">Open Dashboard</a>
        <a class="btn" href="?raw=1" target="_blank" rel="noopener">Open Raw Transcript</a>
      </div>
      <div class="turns">
        ${escapedTurns.map((turn) => `
          <div class="turn ${turn.role === 'AGENT' ? 'agent' : turn.role === 'CUSTOMER' ? 'customer' : 'note'}">
            <div class="turn-role">${turn.role}</div>
            <div class="turn-text">${turn.text}</div>
          </div>
        `).join('')}
      </div>
    </div>
  </div>
</body>
</html>`);
  } catch (error) {
    console.error('[TRANSCRIPT FETCH ERROR]', error.message);
    res.status(500).json({ error: 'Failed to fetch transcript' });
  }
});

const server = http.createServer(app);
const icallMateWss = new WebSocket.Server({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const pathname = new URL(req.url || '/', 'http://localhost').pathname;
  console.log(`[WS UPGRADE] path=${pathname} host=${req.headers.host || ''} origin=${req.headers.origin || ''} upgrade=${req.headers.upgrade || ''} remote=${req.socket.remoteAddress || 'unknown'}`);

  if (pathname === '/icallmate/media') {
    icallMateWss.handleUpgrade(req, socket, head, (ws) => {
      icallMateWss.emit('connection', ws, req);
    });
    return;
  }

  console.warn(`[WS UPGRADE] Rejected unknown path=${pathname}`);
  socket.destroy();
});

function sendIcallMateJson(ws, payload) {
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(payload));
}

function sendIcallMateMark(ws, message, name) {
  sendIcallMateJson(ws, {
    event: 'mark',
    sequenceNumber: String(Date.now()),
    ChKey: message.ChKey,
    streamId: message.streamId,
    mark: { name }
  });
}

function sendIcallMateReverseMedia(ws, session, pcmBuffer) {
  const buffer = Buffer.isBuffer(pcmBuffer) ? pcmBuffer : Buffer.from(pcmBuffer || []);
  if (!buffer.length) return;

  for (let offset = 0; offset < buffer.length; offset += 3200) {
    const chunk = buffer.subarray(offset, Math.min(offset + 3200, buffer.length));
    sendIcallMateJson(ws, {
      event: 'reverse-media',
      encoding: 'LINEAR16',
      streamId: session.streamId,
      callerId: session.callerId,
      did: session.did,
      source: 'ai',
      payload: chunk.toString('base64')
    });
  }
}

function createIcallMateAiBridge(ws, session) {
  let aiWs = null;
  let deepgramWs = null;
  let bridgeClosed = false;
  let geminiSetupComplete = false;
  let openingPromptSent = false;
  let deepgramReady = false;
  let finalTranscriptBuffer = [];

  const getSessionLabel = () => session.streamId || session.callerId || 'unknown';
  const isOutboundSession = () => String(session.callDirection || '').toLowerCase() === 'outbound';
  const getSessionClientName = () => session.clientName || CLIENT_NAME;
  const getSessionCustomerName = () => session.customerName || process.env.CUSTOMER_NAME || 'sir/maam';
  const getSystemPrompt = () => (
    isOutboundSession()
      ? buildAgentSystemPrompt(getSessionClientName(), getSessionCustomerName())
      : buildIncomingAgentSystemPrompt(getSessionClientName())
  );
  const getOpeningPrompt = () => (
    isOutboundSession()
      ? buildOpeningPrompt(getSessionClientName(), getSessionCustomerName())
      : buildIncomingOpeningPrompt(getSessionClientName())
  );

  function sendGeminiClientTurn(text, options = {}) {
    const safeText = String(text || '').trim();
    if (bridgeClosed || !safeText || aiWs?.readyState !== WebSocket.OPEN || !geminiSetupComplete) {
      return;
    }

    aiWs.send(JSON.stringify({
      clientContent: {
        turns: [
          {
            role: 'user',
            parts: [
              {
                text: options.interrupt
                  ? `Ignore any unfinished previous reply and respond to this message now. ${safeText}`
                  : safeText
              }
            ]
          }
        ],
        turnComplete: true
      }
    }));
  }

  function sendOpeningPrompt() {
    if (bridgeClosed || openingPromptSent || aiWs?.readyState !== WebSocket.OPEN || !geminiSetupComplete) {
      return;
    }

    openingPromptSent = true;
    console.log(`[ICALLMATE][GEMINI] Sending opening prompt streamId=${getSessionLabel()}`);
    sendGeminiClientTurn(getOpeningPrompt(), { interrupt: true });
  }

  function connectGemini() {
    if (bridgeClosed) {
      return;
    }

    if (aiWs && aiWs.readyState !== WebSocket.CLOSED) {
      sendOpeningPrompt();
      return;
    }

    geminiSetupComplete = false;
    openingPromptSent = false;
    aiWs = new WebSocket(buildGeminiWsUrl());

    aiWs.on('open', () => {
      if (bridgeClosed) {
        aiWs.close();
        return;
      }

      console.log(`[ICALLMATE][GEMINI] Live session opened streamId=${getSessionLabel()} model=${REALTIME_MODEL} voice=${GEMINI_VOICE}`);
      aiWs.send(JSON.stringify({
        setup: {
          model: resolveRealtimeModelName(REALTIME_MODEL),
          generationConfig: {
            responseModalities: ['AUDIO'],
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: {
                  voiceName: GEMINI_VOICE
                }
              }
            }
          },
          systemInstruction: {
            parts: [
              {
                text: getSystemPrompt()
              }
            ]
          },
          realtimeInputConfig: {},
          inputAudioTranscription: {},
          outputAudioTranscription: {}
        }
      }));
    });

    aiWs.on('message', (raw) => {
      if (bridgeClosed) {
        return;
      }

      let message;

      try {
        message = JSON.parse(raw.toString());
      } catch (error) {
        console.error('[ICALLMATE][GEMINI] Failed to parse message:', error.message);
        return;
      }

      if (message.setupComplete) {
        geminiSetupComplete = true;
        console.log(`[ICALLMATE][GEMINI] Session configured streamId=${getSessionLabel()}`);
        sendOpeningPrompt();
        return;
      }

      if (message.serverContent?.outputTranscription?.text) {
        console.log(`[ICALLMATE][AGENT]: ${message.serverContent.outputTranscription.text}`);
      }

      const parts = message.serverContent?.modelTurn?.parts || [];
      for (const part of parts) {
        if (!part.inlineData?.data || !String(part.inlineData.mimeType || '').startsWith('audio/pcm')) {
          continue;
        }

        const pcm16 = Buffer.from(part.inlineData.data, 'base64');
        const sourceRate = parsePcmRate(part.inlineData.mimeType, 24000);
        const resampled = resamplePcm16(pcm16, sourceRate, 8000);
        console.log(`[ICALLMATE][GEMINI] Sending reverse-media bytes=${resampled.length} sourceRate=${sourceRate} streamId=${getSessionLabel()}`);
        sendIcallMateReverseMedia(ws, session, resampled);
      }

      if (message.serverContent?.interrupted) {
        console.log(`[ICALLMATE][GEMINI] Response interrupted streamId=${getSessionLabel()}`);
      }

      if (message.error) {
        console.error('[ICALLMATE][GEMINI ERROR]', JSON.stringify(message, null, 2));
      }
    });

    aiWs.on('close', (code, reasonBuffer) => {
      const reason = Buffer.isBuffer(reasonBuffer) ? reasonBuffer.toString() : String(reasonBuffer || '');
      console.log(`[ICALLMATE][GEMINI] Live session closed code=${code ?? 'unknown'} reason=${reason || 'n/a'} streamId=${getSessionLabel()}`);
    });

    aiWs.on('error', (error) => {
      if (bridgeClosed) {
        return;
      }

      console.error('[ICALLMATE][GEMINI WS ERROR]', error.message);
    });
  }

  function handleDeepgramTranscript(event) {
    const transcriptText = String(event?.channel?.alternatives?.[0]?.transcript || '').trim();
    const isFinal = Boolean(event?.is_final);
    const isSpeechFinal = Boolean(event?.speech_final);

    if (!transcriptText) {
      if (isSpeechFinal && finalTranscriptBuffer.length) {
        const merged = finalTranscriptBuffer.join(' ').replace(/\s+/g, ' ').trim();
        finalTranscriptBuffer = [];
        if (merged) {
        console.log(`[ICALLMATE][CALLER]: ${merged}`);
          sendGeminiClientTurn(
            isOutboundSession()
              ? `Customer said: ${merged}\nDo not greet again. Continue the blood donation follow-up naturally in Hindi/Hinglish.`
              : `Caller said: ${merged}\nDo not greet again. Continue this inbound support call naturally in Hindi/Hinglish and help with the caller's request.`,
            { interrupt: true }
          );
        }
      }
      return;
    }

    if (isFinal) {
      finalTranscriptBuffer.push(transcriptText);
    }

    if (isSpeechFinal) {
      const merged = (finalTranscriptBuffer.length ? finalTranscriptBuffer.join(' ') : transcriptText)
        .replace(/\s+/g, ' ')
        .trim();
      finalTranscriptBuffer = [];
      if (merged) {
        console.log(`[ICALLMATE][CALLER]: ${merged}`);
        sendGeminiClientTurn(
          isOutboundSession()
            ? `Customer said: ${merged}\nDo not greet again. Continue the blood donation follow-up naturally in Hindi/Hinglish.`
            : `Caller said: ${merged}\nDo not greet again. Continue this inbound support call naturally in Hindi/Hinglish and help with the caller's request.`,
          { interrupt: true }
        );
      }
    }
  }

  function connectDeepgram() {
    if (bridgeClosed) {
      return;
    }

    if (!process.env.DEEPGRAM_API_KEY) {
      console.warn('[ICALLMATE][DEEPGRAM] Missing DEEPGRAM_API_KEY; bot can speak opening but caller speech will not be transcribed.');
      return;
    }

    if (deepgramWs && deepgramWs.readyState !== WebSocket.CLOSED) {
      return;
    }

    deepgramWs = new WebSocket(createDeepgramListenUrl(), {
      headers: {
        Authorization: `Token ${process.env.DEEPGRAM_API_KEY}`
      }
    });

    deepgramWs.on('open', () => {
      if (bridgeClosed) {
        deepgramWs.close();
        return;
      }

      deepgramReady = true;
      console.log(`[ICALLMATE][DEEPGRAM] Live transcription connected streamId=${getSessionLabel()}`);
    });

    deepgramWs.on('message', (raw) => {
      let event;

      try {
        event = JSON.parse(raw.toString());
      } catch (error) {
        console.error('[ICALLMATE][DEEPGRAM] Parse error:', error.message);
        return;
      }

      if (event.type === 'Results') {
        handleDeepgramTranscript(event);
      }
    });

    deepgramWs.on('close', () => {
      deepgramReady = false;
      console.log(`[ICALLMATE][DEEPGRAM] Live transcription closed streamId=${getSessionLabel()}`);
    });

    deepgramWs.on('error', (error) => {
      deepgramReady = false;
      if (bridgeClosed) {
        return;
      }

      console.error('[ICALLMATE][DEEPGRAM ERROR]', error.message);
    });
  }

  return {
    start() {
      if (bridgeClosed) {
        return;
      }

      connectGemini();
      connectDeepgram();
    },
    sendCallerAudio(payload) {
      if (bridgeClosed || !payload || !deepgramReady || deepgramWs?.readyState !== WebSocket.OPEN) {
        return;
      }

      deepgramWs.send(Buffer.from(payload, 'base64'));
    },
    close() {
      bridgeClosed = true;
      if (deepgramWs && deepgramWs.readyState < WebSocket.CLOSING) {
        deepgramWs.close();
      }
      if (aiWs && aiWs.readyState < WebSocket.CLOSING) {
        aiWs.close();
      }
    }
  };
}

icallMateWss.on('connection', (ws, req) => {
  console.log('[ICALLMATE] Media stream connected');
  console.log(`[ICALLMATE] Upgrade request from ${req.socket.remoteAddress || 'unknown'}`);
  console.log(`[ICALLMATE] Request headers host=${req.headers.host || ''} ua=${req.headers['user-agent'] || ''} x-forwarded-for=${req.headers['x-forwarded-for'] || ''}`);

  const session = {
    streamId: '',
    callerId: '',
    did: '',
    callDirection: 'incoming',
    customerName: '',
    clientName: CLIENT_NAME,
    answered: false,
    connectedAt: new Date().toISOString()
  };
  const aiBridge = createIcallMateAiBridge(ws, session);

  ws.on('message', async (raw) => {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch (error) {
      console.error('[ICALLMATE] Invalid JSON payload:', error.message);
      return;
    }

    const eventName = String(message.event || '').toLowerCase();
    console.log(`[ICALLMATE] event=${eventName || 'unknown'} streamId=${message.streamId || session.streamId || ''} callerId=${message.callerId || session.callerId || ''} did=${message.did || session.did || ''}`);
    if (message.streamId) session.streamId = message.streamId;
    if (message.callerId) session.callerId = message.callerId;
    if (message.did) session.did = message.did;
    const extraParams = parseIcallMateExtraParams(message.extraParams || message.extraparam || message.extra_param);
    if (extraParams.callDirection) session.callDirection = String(extraParams.callDirection).toLowerCase();
    if (extraParams.customerName) session.customerName = extraParams.customerName;
    if (extraParams.clientName) session.clientName = extraParams.clientName;

    if (eventName === 'connected') {
      await upsertIncomingCallFromIcall(message, { status: 'active', notes: 'iCallMate connected' });
      sendIcallMateMark(ws, message, 'connected-received');
      return;
    }

    if (eventName === 'start') {
      const mediaFormat = message.mediaFormat || {};
      const isExpectedAudio = (
        Number(mediaFormat.sampleRate) === 8000
        && String(mediaFormat.encoding || '').toUpperCase() === 'LINEAR16'
        && Number(mediaFormat.channels) === 1
        && Number(mediaFormat.bitsPerSample) === 16
      );

      await upsertIncomingCallFromIcall(message, {
        status: 'active',
        notes: isExpectedAudio ? 'iCallMate media stream started' : 'iCallMate media stream started with unexpected audio format'
      });
      sendIcallMateMark(ws, message, 'start-received');

      if (!session.answered) {
        session.answered = true;
        await upsertIncomingCallFromIcall(message, {
          status: 'active',
          answered_at: normalizeIcallTimestamp(message.timestamp),
          notes: 'Incoming call answered via start event'
        });
        aiBridge.start();
        sendIcallMateMark(ws, message, 'answer-received');
      }
      return;
    }

    if (eventName === 'answer') {
      session.answered = true;
      await upsertIncomingCallFromIcall(message, {
        status: 'active',
        answered_at: normalizeIcallTimestamp(message.timestamp),
        notes: 'Incoming call answered'
      });
      aiBridge.start();
      sendIcallMateMark(ws, message, 'answer-received');
      return;
    }

    if (eventName === 'media') {
      await upsertIncomingCallFromIcall(message, {
        status: 'active',
        media_packets: 1,
        notes: session.answered ? 'Incoming audio streaming' : 'Incoming media before answer'
      });
      aiBridge.sendCallerAudio(message.payload);
      return;
    }

    if (eventName === 'hangup-call') {
      await upsertIncomingCallFromIcall(message, {
        status: session.answered ? 'completed' : 'missed',
        ended_at: normalizeIcallTimestamp(message.timestamp),
        notes: session.answered ? 'Incoming call disconnected' : 'Incoming call missed'
      });
      sendIcallMateJson(ws, {
        event: 'reverse-media-stop',
        callerId: message.callerId || session.callerId,
        streamId: message.streamId || session.streamId
      });
      aiBridge.close();
      ws.close();
      return;
    }

    if (eventName === 'mark') {
      console.log(`[ICALLMATE] Mark received: ${message?.mark?.name || message.sequenceNumber || 'mark'}`);
      return;
    }

    console.log(`[ICALLMATE] Unhandled event: ${eventName || 'unknown'}`);
  });

  ws.on('close', () => {
    console.log('[ICALLMATE] Media stream closed');
    aiBridge.close();
    if (session.streamId) {
      upsertIncomingCallFromIcall({
        streamId: session.streamId,
        callerId: session.callerId,
        did: session.did,
        event: 'hangup-call',
        timestamp: new Date().toISOString()
      }, {
        status: session.answered ? 'completed' : 'missed',
        ended_at: new Date().toISOString(),
        notes: session.answered ? 'Incoming call disconnected' : 'Incoming call closed'
      });
    }
  });

  ws.on('error', (error) => {
    console.error('[ICALLMATE WS ERROR]', error.message);
  });
});


(async () => {
  try {
    validateConfig();
    await initializeDatabase();
    logConfigSnapshot('SERVER');

    if (!DISABLE_SCHEDULER) {
      setInterval(() => {
        runSchedulerTick().catch((error) => {
          console.error('[SCHEDULER ERROR]', error.message);
        });
      }, 15000);
    }

    if (!DISABLE_OWNER_DIGEST) {
      setInterval(() => {
        runOwnerDigestTick().catch((error) => {
          console.error('[OWNER DIGEST ERROR]', error.message);
        });
      }, 60000);
    }

    setInterval(() => {
      pruneLiveCallState();
    }, 60000);

    if (!DISABLE_SCHEDULER) {
      runSchedulerTick().catch((error) => {
        console.error('[SCHEDULER ERROR]', error.message);
      });
    }

    if (!DISABLE_OWNER_DIGEST) {
      runOwnerDigestTick().catch((error) => {
        console.error('[OWNER DIGEST ERROR]', error.message);
      });
    }

    server.listen(PORT, () => {
      console.log(`[SERVER] Running on http://localhost:${PORT}`);
      console.log(`[SERVER] Public base URL: ${PUBLIC_BASE_URL}`);
      console.log(`[SERVER] Call mode: ${CALL_MODE}`);
      console.log(`[SERVER] Voice pipeline: ${VOICE_PIPELINE}`);
      console.log(`[SERVER] Realtime model: ${REALTIME_MODEL}`);
      console.log(DISABLE_SCHEDULER
        ? '[SERVER] Scheduler disabled by DISABLE_SCHEDULER=true'
        : '[SERVER] Scheduler active: checks pending customers every 15 seconds');
      console.log(DISABLE_OWNER_DIGEST
        ? '[SERVER] Owner digest disabled by DISABLE_OWNER_DIGEST=true'
        : '[SERVER] Owner digest active: checks 8 AM morning delivery every 60 seconds');
      console.log('[SERVER] Admin UI: http://localhost:3000/admin.html');
      console.log('[SERVER] Ready. Trigger a call with: curl -X POST http://localhost:3000/call/start');
    });
  } catch (error) {
    console.error('[CONFIG ERROR]', error.message);
    process.exit(1);
  }
})();
