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
const { saveCallFeedbackFromTranscript } = require('./services/call-feedback');
const { processCompletedCallPipeline } = require('./services/post-call-pipeline');
const { buildOwnerDashboardData } = require('./services/reporting');
const { sendSimpleEmail } = require('./services/email');
const {
  buildExotelAuthHeader,
  fetchCallDetails,
  getRecordingUrlFromCallDetails,
  initiateCall,
  sendWhatsAppMessage
} = require('./services/exotel');
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
  '/customers.html',
  '/clients.html',
  '/feedback.html',
  '/reports.html'
]);

const ADMIN_USERNAME = 'Path Lab';
const ADMIN_PASSWORD = 'Pathlab123#@!';
const AUTH_COOKIE_NAME = 'feedback_admin_session';
const AUTH_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const AUTH_SIGNING_SECRET = process.env.AUTH_SIGNING_SECRET || process.env.SESSION_SECRET || process.env.EXOTEL_API_TOKEN || 'feedback-admin-auth-secret';

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
  if (req.path === '/login.html' || req.path.startsWith('/api/auth/')) {
    return next();
  }

  if (PROTECTED_HTML_PATHS.has(req.path) || req.path.startsWith('/api/')) {
    return requireAdminAuth(req, res, next);
  }

  return next();
});

app.use(express.static(path.join(__dirname, 'public')));

const PORT = Number(process.env.PORT || 3000);
const CALL_MODE = process.env.CALL_MODE || (process.env.OPENAI_API_KEY ? 'openai' : 'scripted');
const AI_PROVIDER = CALL_MODE === 'gemini' ? 'gemini' : 'openai';
const OPENAI_REALTIME_MODEL = process.env.OPENAI_REALTIME_MODEL || 'gpt-realtime';
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

const REQUESTED_GEMINI_MODEL = process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL;
const GEMINI_MODEL = normalizeGeminiModelName(REQUESTED_GEMINI_MODEL);
if (GEMINI_MODEL !== String(REQUESTED_GEMINI_MODEL || '').trim()) {
  console.warn(`[CONFIG] Gemini model "${REQUESTED_GEMINI_MODEL}" is deprecated or unsupported here; using "${GEMINI_MODEL}" instead.`);
}
const GEMINI_VOICE = process.env.GEMINI_VOICE || 'Kore';
const REALTIME_MODEL = AI_PROVIDER === 'gemini' ? GEMINI_MODEL : OPENAI_REALTIME_MODEL;
const CLIENT_NAME = process.env.CLIENT_NAME || 'your diagnostic and medical collection center';
const HARDCODED_PUBLIC_BASE_URL = 'https://winter-undeclamatory-unstammeringly.ngrok-free.dev';
const SERVER_NAME_BASE_URL = process.env.SERVER_NAME ? `https://${String(process.env.SERVER_NAME).replace(/^https?:\/\//i, '').replace(/\/+$/g, '')}` : '';
const PUBLIC_BASE_URL = (
  process.env.APP_BASE_URL
  || process.env.NGROK_URL
  || process.env.WEBHOOK_URL
  || SERVER_NAME_BASE_URL
  || HARDCODED_PUBLIC_BASE_URL
).replace(/\/$/, '');
const GEMINI_WS_URL = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';
const VOICE_PIPELINE = process.env.VOICE_PIPELINE || 'legacy';
const USE_ORCHESTRATED_PIPELINE = VOICE_PIPELINE === 'orchestrated';
const liveCallState = new Map();
const LIVE_CALL_RETENTION_MS = 20 * 60 * 1000;
const LIVE_CALL_ACTIVE_STALE_MS = 90 * 60 * 1000;

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
    APP_BASE_URL: describeEnvValue(process.env.APP_BASE_URL || ''),
    NGROK_URL: describeEnvValue(process.env.NGROK_URL || ''),
    WEBHOOK_URL: describeEnvValue(process.env.WEBHOOK_URL || ''),
    SERVER_NAME: describeEnvValue(process.env.SERVER_NAME || ''),
    EXOTEL_API_HOST: process.env.EXOTEL_API_HOST || '',
    EXOTEL_SID: redactSecret(process.env.EXOTEL_SID),
    EXOTEL_APP_ID: process.env.EXOTEL_APP_ID || '',
    EXOTEL_FLOW_URL: process.env.EXOTEL_FLOW_URL || process.env.EXOTEL_APPLET_URL || '',
    EXOTEL_VOICEBOT_URL: process.env.EXOTEL_VOICEBOT_URL || '',
    EXOTEL_APPLET_URL: process.env.EXOTEL_APPLET_URL || '',
    EXOTEL_CALLER_ID: process.env.EXOTEL_CALLER_ID || '',
    EXOTEL_WHATSAPP_FROM: process.env.EXOTEL_WHATSAPP_FROM || '',
    EXOTEL_API_KEY_PRESENT: Boolean(process.env.EXOTEL_API_KEY),
    EXOTEL_API_TOKEN_PRESENT: Boolean(process.env.EXOTEL_API_TOKEN),
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

function applyAgentTemplate(template, replacements = {}) {
  return String(template || '').replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi, (_, key) => {
    return replacements[key] ?? '';
  });
}

function buildDefaultAgentSystemPrompt(clientName, customerName) {
  return `
You are Priya, a warm and professional customer feedback agent calling on behalf of ${clientName},
a diagnostic and medical collection center.

Your job is to have a friendly, natural phone conversation to collect honest feedback
about the customer's recent visit. Speak only in simple, natural Hindi.
Do not ask whether they prefer Hindi or English.
Even if the customer mixes English words, continue in easy conversational Hindi.
Speak a little slowly and clearly, with natural short pauses.
Do not stay silent for long after the customer finishes speaking.

CONVERSATION FLOW — follow this order, but keep it conversational, not robotic:

1. GREETING & INTRODUCTION
Introduce yourself, mention you are calling from ${clientName},
confirm you are speaking with the right person by name.
Then ask if they have 2-3 minutes to share feedback about their recent visit.
If they say no or are busy — thank them politely and end the call.

2. OVERALL EXPERIENCE
Ask: "How was your overall experience at our collection center?"
Listen fully. Acknowledge their response warmly before moving on.

3. CLEANLINESS
Ask: "How did you find the cleanliness and hygiene of the center?"
If negative, ask: "Could you tell me more about what you noticed?"

4. STAFF BEHAVIOUR
Ask: "How was the behavior and attitude of our staff towards you?"
If they mention a specific person (positive or negative), note the name.
Ask: "Is there anyone from our team you would like to specially highlight?"

5. WAITING TIME & PROCESS
Ask: "How was the waiting time and the sample collection process? Was everything explained clearly to you?"

6. OVERALL RATING
Ask: "On a scale of 1 to 5, where 5 is excellent, how would you rate your overall experience?"
Wait for a number. If unclear, gently re-ask once.

7. IMPROVEMENT SUGGESTIONS
Ask: "Is there anything you feel we could do better to improve your experience?"
Let them speak freely. Do not rush this.

8. CLOSING
Thank them sincerely by name.
Tell them their feedback is valuable and will help improve the service.
Mention: "We will also send you a WhatsApp message with a link to leave a Google review if you are comfortable — it really helps us grow."
Say a warm goodbye.

RULES:
- Never interrupt the customer mid-sentence.
- If the customer goes off-topic, gently bring them back by saying: "That is helpful to know. Coming back to your visit..."
- Never argue or get defensive about negative feedback. Always empathize first.
- Keep your turns short: 1-3 sentences max per response.
- After the customer finishes each answer, briefly acknowledge before asking the next question.
- The full call should feel like 3-5 minutes, not a long survey.
- If the customer says they are busy or does not want to continue, politely thank them and end the conversation.
- Start the call with this structure: greet the customer in Hindi, say your name is Priya, say you are calling from ${clientName}, confirm you are speaking with ${customerName}, then ask if they have 2-3 minutes for feedback.
- Do not skip the introduction.
- Do not sound like a bot, assistant, or AI system.
- Do not jump to random topics or generic small talk.
- Ask only one main question at a time.
- Default to Hindi for the entire call.
- Speak slightly slower than normal phone conversation speed.
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
  return [
    `Start the call with a short Hindi greeting as Priya from ${clientName}.`,
    `Say: "Namaste, kya main ${customerName} se baat kar rahi hoon? Main Priya bol rahi hoon, ${clientName} se. Kya aapke paas 2 se 3 minute hain?"`,
    'Keep the first turn short, warm, and clearly spoken in Hindi.',
    'After the greeting, continue the feedback conversation naturally using the system instructions.'
  ].join(' ');
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

async function getAgentConfigById(agentId) {
  if (!agentId) return null;
  return dbGet('SELECT * FROM agents WHERE id = ? AND is_active = 1', [agentId]);
}

async function getDefaultAgentConfig() {
  return dbGet('SELECT * FROM agents WHERE is_default = 1 AND is_active = 1 ORDER BY id ASC LIMIT 1');
}

function validateConfig() {
  const missing = [
    'EXOTEL_SID',
    'EXOTEL_API_KEY',
    'EXOTEL_API_TOKEN',
    'EXOTEL_CALLER_ID'
  ].filter((key) => !process.env[key]);

  if (!process.env.EXOTEL_FLOW_URL && !process.env.EXOTEL_APPLET_URL) {
    missing.push('EXOTEL_FLOW_URL or EXOTEL_APPLET_URL');
  }

  if (CALL_MODE === 'openai' && !process.env.OPENAI_API_KEY) {
    missing.push('OPENAI_API_KEY');
  }

  if (CALL_MODE === 'gemini' && !process.env.GEMINI_API_KEY) {
    missing.push('GEMINI_API_KEY');
  }

  if (USE_ORCHESTRATED_PIPELINE) {
    throw new Error('VOICE_PIPELINE=orchestrated is no longer supported after removing third-party TTS. Use VOICE_PIPELINE=legacy.');
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

    if (process.env.OWNER_PHONE && process.env.EXOTEL_WHATSAPP_FROM) {
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
      intro: `Hello, am I speaking with ${customerName}? This is Priya calling from ${clientName}. To continue in English, say English or press 2. Hindi mein baat karne ke liye Hindi boliye ya 1 dabaiye.`,
      noLanguageResponse: 'We did not receive your language preference. Thank you for your time. Goodbye.',
      consent: `Thank you. I will continue in English. Do you have 2 to 3 minutes to share feedback about your recent visit? Please say yes or press 1 to continue.`,
      decline: 'No problem. Thank you for your time. Goodbye.',
      noConsentResponse: 'We did not receive a response. Thank you for your time. Goodbye.',
      rating: 'Thank you. How was your overall experience at our collection center? On a scale of 1 to 5, where 5 is excellent, please say the number or press it now.',
      noRatingResponse: 'We did not receive a rating. Thank you for your time. Goodbye.',
      closing: 'Thank you for your feedback. We appreciate your time and will use it to improve our service. We may also send you a WhatsApp message with a review link if you are comfortable. Goodbye.'
    };
  }

  return {
    intro: `Namaste. Kya main ${customerName} se baat kar rahi hoon? Main Priya bol rahi hoon, ${clientName} se. Main aapki recent visit ka chhota sa feedback lena chahti hoon. Kya aapke paas 2 se 3 minute hain? Haan boliye ya 1 dabaiye.`,
    noLanguageResponse: 'Humein aapka jawab nahin mila. Dhanyavaad. Namaste.',
    consent: `Dhanyavaad. Main  Hindi mein baat karungi. Aapka overall experience hamare collection center mein kaisa raha?`,
    decline: 'Koi baat nahin. Aapke samay ke liye dhanyavaad. Namaste.',
    noConsentResponse: 'Humein aapka jawab nahin mila. Dhanyavaad. Namaste.',
    rating: 'Dhanyavaad. Hamare collection center mein aapka overall experience kaisa tha? 1 se 5 tak rating dijiye, jahan 5 excellent hai. Number boliye ya key dabaiye.',
    noRatingResponse: 'Humein aapki rating nahin mili. Dhanyavaad. Namaste.',
    closing: 'Aapke feedback ke liye dhanyavaad. Aapki rai hamari service improve karne mein madad karegi. Agar aap chahein to hum WhatsApp par ek review link bhi bhej sakte hain. Namaste.'
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

function mulawToLinearSample(value) {
  const MULAW_BIAS = 0x84;
  let sample = ~value & 0xff;
  const sign = sample & 0x80;
  const exponent = (sample >> 4) & 0x07;
  const mantissa = sample & 0x0f;
  sample = ((mantissa << 3) + MULAW_BIAS) << exponent;
  return sign ? (MULAW_BIAS - sample) : (sample - MULAW_BIAS);
}

function decodeMuLaw(base64Payload) {
  const input = Buffer.from(base64Payload, 'base64');
  const output = Buffer.alloc(input.length * 2);

  for (let i = 0; i < input.length; i += 1) {
    output.writeInt16LE(mulawToLinearSample(input[i]), i * 2);
  }

  return output;
}

function linearToMuLawSample(sample) {
  const MULAW_MAX = 0x1fff;
  const MULAW_BIAS = 33;
  let pcm = Math.max(-32768, Math.min(32767, sample));
  let sign = 0;

  if (pcm < 0) {
    sign = 0x80;
    pcm = -pcm;
  }

  pcm = Math.min(pcm, MULAW_MAX);
  pcm += MULAW_BIAS;

  let exponent = 7;
  for (let expMask = 0x4000; (pcm & expMask) === 0 && exponent > 0; expMask >>= 1) {
    exponent -= 1;
  }

  const mantissa = (pcm >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

function encodeMuLawFromPcm16(buffer) {
  const sampleCount = Math.floor(buffer.length / 2);
  const output = Buffer.alloc(sampleCount);

  for (let i = 0; i < sampleCount; i += 1) {
    output[i] = linearToMuLawSample(buffer.readInt16LE(i * 2));
  }

  return output;
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

function getTransportModeFromStartPayload(start = {}, req = null) {
  const hintedProvider = req ? new URL(req.url, 'http://localhost').searchParams.get('provider') : '';
  if (hintedProvider === 'exotel') {
    return 'exotel';
  }

  const customParameters = getCustomParametersFromStart(start);
  const customProvider = String(
    customParameters.provider
    || customParameters.Provider
    || start.provider
    || start.Provider
    || ''
  ).toLowerCase();
  if (customProvider === 'exotel') {
    return 'exotel';
  }

  if (start.account_sid || start.accountSid) {
    return 'exotel';
  }

  const mediaFormat = start.mediaFormat || start.media_format || {};
  const encoding = String(mediaFormat.encoding || '').toLowerCase();
  if (encoding.includes('raw') || encoding.includes('slin') || encoding.includes('pcm')) {
    return 'exotel';
  }

  return 'twilio';
}

function extractStartPayload(message = {}) {
  return message.start || {};
}

function getStreamSidFromMessage(message = {}) {
  const start = extractStartPayload(message);
  return (
    start.streamSid
    || start.stream_sid
    || message.streamSid
    || message.stream_sid
    || null
  );
}

function getCallSidFromStart(start = {}) {
  return start.callSid || start.call_sid || null;
}

function getCustomParametersFromStart(start = {}) {
  return start.customParameters || start.custom_parameters || {};
}

function getMediaPayload(message = {}) {
  return message?.media?.payload || null;
}

function usesGeminiRealtimeTextInput(modelName) {
  return String(modelName || '').includes('gemini-3.1');
}

function createDeepgramListenUrl() {
  const url = new URL('wss://api.deepgram.com/v1/listen');
  url.searchParams.set('model', 'nova-2');
  url.searchParams.set('language', 'hi');
  url.searchParams.set('interim_results', 'true');
  url.searchParams.set('endpointing', '300');
  url.searchParams.set('smart_format', 'true');
  url.searchParams.set('encoding', 'mulaw');
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

  return /[.!?।]\s*$/.test(text) || text.length >= 140;
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
  const statusUrl = `${PUBLIC_BASE_URL}/call/status${customerId ? `?customerId=${encodeURIComponent(String(customerId))}` : ''}`;
  return initiateCall(customerPhone, customerId, statusUrl, {
    customerName,
    clientName,
    agentId
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

  return [
    /(^|\b)(goodbye|bye|alvida)(\b|$)/i,
    /apna dhyaan rakh/i,
    /aapne jo feedback diya uske liye/i,
    /bahut (bahut )?dhanyawa?d/i,
    /hum (aapko|apko) (ek )?whatsapp message bhejenge/i,
    /have a great day/i
  ].some((pattern) => pattern.test(normalized));
}

function estimateHangupDelayMs(text) {
  const length = String(text || '').trim().length;
  return Math.min(10000, Math.max(4500, 2500 + (length * 35)));
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
          customer_id, agent_id, outcome, twilio_sid, called_at, hot_lead_score,
          consent_message_played, call_script_version, supervisor_alert_level
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          customer.id,
          agentConfig?.id || null,
          'scheduled_initiated',
          call.sid,
          new Date().toISOString(),
          customer.priority_score || computePriorityScore(customer),
          1,
          agentConfig?.slug || 'hindi-feedback-v1',
          'normal'
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
          customer_id, agent_id, outcome, twilio_sid, called_at, hot_lead_score,
          consent_message_played, call_script_version, supervisor_alert_level
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          hydratedCustomer.id,
          agentConfig?.id || null,
          'scheduled_initiated',
          call.sid,
          new Date().toISOString(),
          hydratedCustomer.priority_score || computePriorityScore(hydratedCustomer),
          1,
          `annual-reminder:${client.treatment_type || 'client-care'}`,
          'normal'
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

app.post('/call/start', async (req, res) => {
  try {
    const customerPhone = req.body.customerPhone || process.env.CUSTOMER_PHONE;
    const customerName = req.body.customerName || process.env.CUSTOMER_NAME;
    const requestedCustomerId = req.body.customerId;
    const requestedAgentId = Number(req.body.agentId || req.query.agentId || 0) || null;
    let customer = await ensureCustomerForCall({
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

    console.log(
      `[CALL REQUEST] to=${customerPhone} callerId=${process.env.EXOTEL_CALLER_ID} ` +
      `applet=${process.env.EXOTEL_APPLET_URL} baseUrl=${PUBLIC_BASE_URL} ` +
      `mode=${CALL_MODE} pipeline=${VOICE_PIPELINE} model=${REALTIME_MODEL}`
    );
    console.log(
    `[CALL REQUEST CONFIG] ` +
      `APP_BASE_URL=${describeEnvValue(process.env.APP_BASE_URL || '')} ` +
      `NGROK_URL=${describeEnvValue(process.env.NGROK_URL || '')} ` +
      `WEBHOOK_URL=${describeEnvValue(process.env.WEBHOOK_URL || '')} ` +
      `SERVER_NAME=${describeEnvValue(process.env.SERVER_NAME || '')} ` +
      `EXOTEL_API_HOST=${process.env.EXOTEL_API_HOST || ''} ` +
      `EXOTEL_SID=${redactSecret(process.env.EXOTEL_SID)} ` +
      `EXOTEL_APP_ID=${process.env.EXOTEL_APP_ID || ''} ` +
      `EXOTEL_FLOW_URL=${process.env.EXOTEL_FLOW_URL || process.env.EXOTEL_APPLET_URL || ''} ` +
      `EXOTEL_VOICEBOT_URL=${process.env.EXOTEL_VOICEBOT_URL || ''} ` +
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
        customer_id, agent_id, outcome, twilio_sid, called_at, hot_lead_score,
        consent_message_played, call_script_version, supervisor_alert_level
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        customer.id,
        agentConfig?.id || null,
        'initiated',
        call.sid,
        new Date().toISOString(),
        customer.priority_score || computePriorityScore(customer),
        1,
        agentConfig?.slug || 'hindi-feedback-v1',
        'normal'
      ]
    );
    await dbRun('UPDATE customers SET status = ? WHERE id = ?', ['called', customer.id]);

    console.log(`[CALL STARTED] SID: ${call.sid}`);
    res.json({ success: true, sid: call.sid, callId: result.lastID, customerId: customer.id, agentId: agentConfig?.id || null });
  } catch (error) {
    console.error('[ERROR starting call]', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/call/twiml', (req, res) => {
  const customerName = req.query.customerName || process.env.CUSTOMER_NAME;
  const clientName = req.query.clientName || CLIENT_NAME;
  const agentId = req.query.agentId || '';

  if (CALL_MODE === 'scripted') {
    console.log('[CALL FLOW] Serving scripted XML flow');
    res.type('text/xml').send(buildScriptedTwiml(customerName, clientName));
    return;
  }

  const streamUrl = toWssUrl(PUBLIC_BASE_URL, '/call/stream');
  console.log(`[CALL FLOW] Serving stream XML with URL: ${streamUrl}`);
  console.log(`[CALL FLOW] customer=${customerName} client=${clientName} agentId=${agentId || 'none'}`);
  console.log(
    `[CALL FLOW CONFIG] ` +
    `APP_BASE_URL=${describeEnvValue(process.env.APP_BASE_URL || '')} ` +
    `NGROK_URL=${describeEnvValue(process.env.NGROK_URL || '')} ` +
    `WEBHOOK_URL=${describeEnvValue(process.env.WEBHOOK_URL || '')} ` +
    `PUBLIC_BASE_URL=${describeEnvValue(PUBLIC_BASE_URL)} ` +
    `CALL_MODE=${CALL_MODE} ` +
    `VOICE_PIPELINE=${VOICE_PIPELINE} ` +
    `REALTIME_MODEL=${REALTIME_MODEL}`
  );
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${xmlEscape(streamUrl)}" track="inbound_track">
      <Parameter name="customerName" value="${xmlEscape(customerName)}" />
      <Parameter name="clientName" value="${xmlEscape(clientName)}" />
      <Parameter name="customerId" value="${xmlEscape(req.query.customerId || '')}" />
      <Parameter name="agentId" value="${xmlEscape(agentId)}" />
    </Stream>
  </Connect>
</Response>`;

  res.type('text/xml').send(twiml);
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

app.all('/call/exotel/voicebot-url', async (req, res) => {
  try {
    const provider = 'exotel';
    const query = new URLSearchParams({ provider });

    const hintedPhone =
      req.body?.From
      || req.query?.From
      || req.body?.from
      || req.query?.from
      || '';

    const hintedCallSid =
      req.body?.CallSid
      || req.query?.CallSid
      || req.body?.call_sid
      || req.query?.call_sid
      || '';

    if (hintedPhone) {
      query.set('from', hintedPhone);
    }

    if (hintedCallSid) {
      query.set('callSid', hintedCallSid);
    }

    const streamUrl = `${toWssUrl(PUBLIC_BASE_URL, '/call/stream')}?${query.toString()}`;
    const traceMarker = {
      method: req.method,
      path: req.originalUrl,
      ip: req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '',
      userAgent: req.headers['user-agent'] || '',
      host: req.headers.host || '',
      from: hintedPhone || '',
      callSid: hintedCallSid || '',
      query: req.query || {},
      bodyKeys: Object.keys(req.body || {}),
      timestamp: new Date().toISOString()
    };
    console.log(
      `[EXOTEL VOICEBOT HIT] provider=${provider} streamUrl=${streamUrl} ` +
      `marker=${JSON.stringify(traceMarker)} ` +
      `APP_BASE_URL=${describeEnvValue(process.env.APP_BASE_URL || '')} ` +
      `NGROK_URL=${describeEnvValue(process.env.NGROK_URL || '')} ` +
      `WEBHOOK_URL=${describeEnvValue(process.env.WEBHOOK_URL || '')} ` +
      `PUBLIC_BASE_URL=${describeEnvValue(PUBLIC_BASE_URL)} ` +
      `EXOTEL_FLOW_URL=${process.env.EXOTEL_FLOW_URL || process.env.EXOTEL_APPLET_URL || ''} ` +
      `EXOTEL_VOICEBOT_URL=${process.env.EXOTEL_VOICEBOT_URL || ''}`
    );
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('X-Exotel-Voicebot-Hit', 'true');
    res.json({ url: streamUrl });
  } catch (error) {
    console.error('[EXOTEL VOICEBOT URL ERROR]', error.message);
    res.status(500).json({ error: 'Unable to generate Exotel voicebot URL' });
  }
});

app.post('/call/status', async (req, res) => {
  try {
    const providerStatus = req.body.CallStatus || req.body.Status || req.body.status || null;
    const providerCallSid = req.body.CallSid || req.body.call_sid || req.body.Sid || req.body.sid || null;
    const providerRecordingUrl = req.body.RecordingUrl || req.body.recording_url || null;
    const providerRecordingSid = req.body.RecordingSid || req.body.recording_sid || null;
    const eventType = req.body.EventType || req.body.event_type || null;
    console.log(`[CALL STATUS] ${providerStatus} | SID: ${providerCallSid}`);

    const callRecord = await dbGet('SELECT * FROM calls WHERE twilio_sid = ?', [providerCallSid]);
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

    const callRecord = await dbGet('SELECT * FROM calls WHERE twilio_sid = ?', [callSid]);
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
  try {
    let customer = await dbGet('SELECT * FROM customers WHERE id = ?', [req.params.customerId]);
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

    const call = await placeRealtimeCall({
      customerPhone: customer.phone,
      customerName: customer.name,
      customerId: customer.id,
      clientName: agentConfig?.client_name || CLIENT_NAME,
      agentId: agentConfig?.id || null
    });

    const result = await dbRun(
      `INSERT INTO calls (
        customer_id, agent_id, outcome, twilio_sid, called_at, hot_lead_score,
        consent_message_played, call_script_version, supervisor_alert_level
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        customer.id,
        agentConfig?.id || null,
        'initiated',
        call.sid,
        new Date().toISOString(),
        customer.priority_score || computePriorityScore(customer),
        1,
        agentConfig?.slug || 'hindi-feedback-v1',
        'normal'
      ]
    );

    await dbRun('UPDATE customers SET status = ? WHERE id = ?', ['called', customer.id]);
    res.json({ message: 'Call initiated', callId: result.lastID, sid: call.sid, agentId: agentConfig?.id || null, agentName: agentConfig?.name || null });
  } catch (error) {
    console.error('[API CALL INITIATE ERROR]', error.message);
    res.status(500).json({ error: error.message });
  }
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
         calls.twilio_sid,
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
         calls.twilio_sid,
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
        .filter((row) => row.twilio_sid && !seenCallSids.has(row.twilio_sid))
        .map((row) => {
          const calledAtMs = new Date(row.called_at || 0).getTime();
          const isFreshPending = (
            (row.outcome === 'initiated' || row.outcome === 'scheduled_initiated')
            && calledAtMs
            && !Number.isNaN(calledAtMs)
            && (now - calledAtMs) <= (10 * 60 * 1000)
          );

          return {
            call_sid: row.twilio_sid,
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
    const call = await dbGet('SELECT id, twilio_sid, recording_url, recording_status FROM calls WHERE id = ?', [req.params.callId]);

    if (!call?.recording_url && !call?.twilio_sid) {
      return res.status(404).json({ error: 'Recording not available yet' });
    }

    let playbackUrl = call.recording_url || null;
    let response = playbackUrl
      ? await fetch(playbackUrl, {
          headers: {
            Authorization: buildExotelAuthHeader()
          }
        })
      : null;

    if ((!response || !response.ok) && call?.twilio_sid) {
      try {
        const details = await fetchCallDetails(call.twilio_sid, { recordingUrlValidity: 15 });
        const refreshedUrl = getRecordingUrlFromCallDetails(details);
        if (refreshedUrl) {
          playbackUrl = refreshedUrl;
          await dbRun(
            'UPDATE calls SET recording_url = ?, recording_status = COALESCE(recording_status, ?) WHERE id = ?',
            [refreshedUrl, 'completed', call.id]
          );
          response = await fetch(refreshedUrl, {
            headers: {
              Authorization: buildExotelAuthHeader()
            }
          });
        }
      } catch (error) {
        console.error('[RECORDING REFRESH ERROR]', error.message);
      }
    }

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
         calls.twilio_sid,
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
        <div class="meta-card"><strong>Call SID</strong>${call.twilio_sid || '--'}</div>
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

function setupOrchestratedStream(twilioWs, req) {
  console.log('[STREAM] Media stream connected');
  console.log(`[STREAM] Upgrade request from ${req.socket.remoteAddress || 'unknown'}`);
  console.log('[STREAM] Voice pipeline: orchestrated');

  let streamSid;
  let transcriptPrinted = false;
  const transcript = [];
  let activeCustomerName = process.env.CUSTOMER_NAME || 'Customer';
  let activeClientName = CLIENT_NAME;
  let activeAgentId = null;
  let activeAgentConfig = null;
  let activeCustomerId = null;
  let activeCallSid = null;
  let activeCallId = null;
  let transcriptPersisted = false;
  let state = 'LISTENING';
  let callClosed = false;
  let greetingStarted = false;
  let deepgramReady = false;
  let currentGeminiController = null;
  let currentTtsController = null;
  let speechDrainRunning = false;
  let assistantSequence = Promise.resolve();
  let pendingSpeechSegments = [];
  let finalTranscriptBuffer = [];
  let interruptedGeneration = false;
  let deepgramWs = null;
  let autoHangupTimer = null;

  const getActiveSystemPrompt = () => buildAgentSystemPrompt(activeClientName, activeCustomerName, activeAgentConfig);
  const getActiveOpeningPrompt = () => buildOpeningPrompt(activeClientName, activeCustomerName, activeAgentConfig);
  const getActiveModelName = () => activeAgentConfig?.llm_model || REALTIME_MODEL;

  const printTranscriptOnce = () => {
    if (!transcriptPrinted) {
      transcriptPrinted = true;
      printTranscript(transcript);
    }
  };

  async function persistTranscriptOnce() {
    if (transcriptPersisted) {
      return;
    }

    transcriptPersisted = true;

    try {
      const result = await saveCallFeedbackFromTranscript({
        dbGet,
        dbRun,
        callSid: activeCallSid,
        customerId: activeCustomerId,
        transcript
      });

      if (result.saved) {
        console.log(`[FEEDBACK] Auto-saved call feedback as record ${result.feedbackId} (${result.category})`);
      } else {
        console.log(`[FEEDBACK] Skipped auto-save: ${result.reason}`);
      }
    } catch (error) {
      console.error('[FEEDBACK SAVE ERROR]', error.message);
    }
  }

  async function refreshLiveCallState(partial = {}) {
    if (!activeCallSid) return;

    const current = liveCallState.get(activeCallSid) || {
      call_sid: activeCallSid,
      customer_name: activeCustomerName,
      customer_id: activeCustomerId,
      call_id: activeCallId,
      started_at: new Date().toISOString(),
      transcript_preview: '',
      live_sentiment_label: 'neutral',
      live_sentiment_score: 0,
      red_flag: false,
      escalation_requested: false,
      status: 'active',
      pipeline: 'orchestrated',
      voice_state: state,
      agent_id: activeAgentId,
      agent_name: activeAgentConfig?.name || null
    };

    liveCallState.set(activeCallSid, {
      ...current,
      ...partial,
      customer_name: activeCustomerName,
      customer_id: activeCustomerId,
      agent_id: activeAgentId,
      agent_name: activeAgentConfig?.name || null,
      call_id: activeCallId,
      pipeline: 'orchestrated',
      voice_state: state,
      transcript_preview: transcript.slice(-4).map((turn) => `[${turn.role}] ${turn.text}`).join('\n')
    });

    if (activeCallId) {
      const nextState = liveCallState.get(activeCallSid);
      await dbRun(
        `UPDATE calls
            SET live_sentiment_score = ?,
                live_sentiment_label = ?,
                live_red_flag = ?,
                supervisor_alert_level = ?,
                human_escalation_requested = ?
          WHERE id = ?`,
        [
          nextState.live_sentiment_score || 0,
          nextState.live_sentiment_label || 'neutral',
          nextState.red_flag ? 1 : 0,
          nextState.red_flag ? 'high' : 'normal',
          nextState.escalation_requested ? 1 : 0,
          activeCallId
        ]
      );
    }
  }

  function clearAutoHangupTimer() {
    if (autoHangupTimer) {
      clearTimeout(autoHangupTimer);
      autoHangupTimer = null;
    }
  }

  function scheduleAutoHangupFromAgentText(text) {
    clearAutoHangupTimer();
    if (!shouldAutoHangupAfterAgentTurn(text) || callClosed) {
      return;
    }

    const delayMs = estimateHangupDelayMs(text);
    autoHangupTimer = setTimeout(() => {
      if (callClosed) {
        return;
      }
      console.log(`[AUTO HANGUP] Closing orchestrated call after farewell (${delayMs}ms)`);
      closeCallSession('completed').catch((error) => {
        console.error('[AUTO HANGUP ERROR]', error.message);
      }).finally(() => {
        if (twilioWs.readyState === WebSocket.OPEN) {
          twilioWs.close();
        }
      });
    }, delayMs);
  }

  function sendAudioToCaller(base64Payload) {
    if (!streamSid || !base64Payload || callClosed || twilioWs.readyState !== WebSocket.OPEN) {
      return;
    }

    twilioWs.send(JSON.stringify({
      event: 'media',
      streamSid,
      media: { payload: base64Payload }
    }));
  }

  function clearCallerPlaybackBuffer() {
    if (!streamSid || callClosed || twilioWs.readyState !== WebSocket.OPEN) {
      return;
    }

    twilioWs.send(JSON.stringify({
      event: 'clear',
      streamSid
    }));
  }

  async function evaluateAndStoreSentiment(text) {
    const sentiment = evaluateLiveSentimentLabel(text);
    const redFlag = sentiment.label === 'negative';

    await refreshLiveCallState({
      live_sentiment_label: sentiment.label,
      live_sentiment_score: sentiment.score,
      red_flag: redFlag
    });

    if (redFlag && activeCallId) {
      await createSupervisorEvent({
        dbRun,
        callId: activeCallId,
        eventType: 'live_negative_signal',
        severity: 'high',
        payload: { transcript: text }
      });
    }
  }

  function enqueueSpeechSegment(text) {
    const normalized = String(text || '').replace(/\s+/g, ' ').trim();
    if (!normalized || interruptedGeneration || callClosed) {
      return;
    }

    pendingSpeechSegments.push(normalized);
    if (!speechDrainRunning) {
      drainSpeechQueue().catch((error) => {
        console.error('[TTS DRAIN ERROR]', error.message);
      });
    }
  }

  async function drainSpeechQueue() {
    if (speechDrainRunning) {
      return;
    }

    speechDrainRunning = true;

    try {
      while (pendingSpeechSegments.length && !callClosed && !interruptedGeneration) {
        const segment = pendingSpeechSegments.shift();
        currentTtsController = new AbortController();
        state = 'SPEAKING';
        await refreshLiveCallState({ status: 'active' });

        try {
          await streamSynthesizedAudio({
            text: segment,
            signal: currentTtsController.signal,
            onAudioChunk: async (chunk) => {
              sendAudioToCaller(chunk.toString('base64'));
            }
          });
        } catch (error) {
          if (error.name === 'AbortError') {
            console.log('[TTS] Audio stream interrupted');
            break;
          }

          throw error;
        }
      }
    } finally {
      currentTtsController = null;
      speechDrainRunning = false;
      if (!callClosed && state !== 'BARGE_IN') {
        state = 'LISTENING';
        refreshLiveCallState({ status: 'active' }).catch(() => {});
      }
    }
  }

  function interruptAssistant(reason) {
    if (!['SPEAKING', 'PROCESSING'].includes(state)) {
      return;
    }

    console.log(`[BARGE-IN] ${reason}`);
    interruptedGeneration = true;
    state = 'BARGE_IN';
    pendingSpeechSegments = [];
    clearCallerPlaybackBuffer();

    if (currentGeminiController) {
      currentGeminiController.abort();
      currentGeminiController = null;
    }

    if (currentTtsController) {
      currentTtsController.abort();
      currentTtsController = null;
    }

    refreshLiveCallState({ status: 'active' }).catch(() => {});
  }

  async function generateAssistantTurn(userTurnText) {
    if (callClosed) {
      return;
    }

    interruptedGeneration = false;
    pendingSpeechSegments = [];
    currentGeminiController = new AbortController();
    state = 'PROCESSING';
    await refreshLiveCallState({ status: 'active' });

    let fullResponse = '';
    let speechBuffer = '';

    try {
      await streamGeminiResponse({
        systemPrompt: getActiveSystemPrompt(),
        contents: buildGeminiContentsFromTranscript(transcript, userTurnText),
        signal: currentGeminiController.signal,
        modelName: getActiveModelName(),
        onTextChunk: async (textChunk) => {
          if (interruptedGeneration || callClosed) {
            return;
          }

          fullResponse += textChunk;
          speechBuffer += textChunk;

          if (shouldFlushSpeechSegment(speechBuffer)) {
            enqueueSpeechSegment(speechBuffer);
            speechBuffer = '';
          }
        }
      });

      if (speechBuffer.trim()) {
        enqueueSpeechSegment(speechBuffer);
      }

      if (fullResponse.trim()) {
        pushTranscriptTurn(transcript, 'AGENT', fullResponse.trim());
        console.log(`[AGENT]: ${fullResponse.trim()}`);
        await refreshLiveCallState({ status: 'active' });
        scheduleAutoHangupFromAgentText(fullResponse.trim());
      }
    } catch (error) {
      if (error.name === 'AbortError') {
        console.log('[GEMINI] Response interrupted');
        return;
      }

      console.error('[GEMINI ERROR]', error.message);
      const fallbackResponse = 'Maaf kijiye, ek chhoti technical dikkat aa gayi. Kya aap apni baat ek baar phir se bata sakte hain?';
      pushTranscriptTurn(transcript, 'AGENT', fallbackResponse);
      enqueueSpeechSegment(fallbackResponse);
    } finally {
      currentGeminiController = null;
    }
  }

  function queueAssistantTurn(userTurnText) {
    assistantSequence = assistantSequence
      .catch(() => {})
      .then(() => generateAssistantTurn(userTurnText));
    return assistantSequence;
  }

  function finalizeUserTurn(text) {
    const normalized = String(text || '').replace(/\s+/g, ' ').trim();
    if (!normalized || callClosed) {
      return;
    }

    clearAutoHangupTimer();
    pushTranscriptTurn(transcript, 'CUSTOMER', normalized);
    console.log(`[CUSTOMER]: ${normalized}`);
    evaluateAndStoreSentiment(normalized).catch(() => {});
    queueAssistantTurn(normalized).catch((error) => {
      console.error('[ASSISTANT TURN ERROR]', error.message);
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
        finalizeUserTurn(merged);
      }
      return;
    }

    if ((state === 'SPEAKING' || state === 'PROCESSING') && transcriptText.split(/\s+/).filter(Boolean).length >= 2) {
      interruptAssistant(`caller interruption detected: "${transcriptText}"`);
    }

    if (isFinal) {
      finalTranscriptBuffer.push(transcriptText);
    }

    if (isSpeechFinal) {
      const merged = finalTranscriptBuffer.length
        ? finalTranscriptBuffer.join(' ')
        : transcriptText;
      finalTranscriptBuffer = [];
      finalizeUserTurn(merged);
    }
  }

  function connectDeepgram() {
    deepgramWs = new WebSocket(createDeepgramListenUrl(), {
      headers: {
        Authorization: `Token ${process.env.DEEPGRAM_API_KEY}`
      }
    });

    deepgramWs.on('open', () => {
      deepgramReady = true;
      console.log('[DEEPGRAM] Live transcription connected');
      refreshLiveCallState({ status: 'active' }).catch(() => {});

      if (!greetingStarted) {
        greetingStarted = true;
        queueAssistantTurn(getActiveOpeningPrompt()).catch((error) => {
          console.error('[GREETING ERROR]', error.message);
        });
      }
    });

    deepgramWs.on('message', (raw) => {
      let event;

      try {
        event = JSON.parse(raw.toString());
      } catch (error) {
        console.error('[DEEPGRAM PARSE ERROR]', error.message);
        return;
      }

      if (event.type === 'Results') {
        handleDeepgramTranscript(event);
        return;
      }

      if (event.type === 'Metadata') {
        console.log('[DEEPGRAM] Metadata received');
      }
    });

    deepgramWs.on('close', () => {
      deepgramReady = false;
      console.log('[DEEPGRAM] Live transcription closed');
    });

    deepgramWs.on('error', (error) => {
      deepgramReady = false;
      console.error('[DEEPGRAM ERROR]', error.message);
    });
  }

  async function closeCallSession(status) {
    if (callClosed) {
      return;
    }

    callClosed = true;
    clearAutoHangupTimer();
    pendingSpeechSegments = [];
    interruptedGeneration = true;

    if (currentGeminiController) {
      currentGeminiController.abort();
      currentGeminiController = null;
    }

    if (currentTtsController) {
      currentTtsController.abort();
      currentTtsController = null;
    }

    if (deepgramWs?.readyState === WebSocket.OPEN) {
      deepgramWs.close();
    }

    await refreshLiveCallState({ status }).catch(() => {});
    printTranscriptOnce();
    await persistTranscriptOnce().catch((error) => {
      console.error('[FEEDBACK SAVE ERROR]', error.message);
    });
  }

  twilioWs.on('message', async (raw) => {
    let message;

    try {
      message = JSON.parse(raw.toString());
    } catch (error) {
      console.error('[STREAM] Failed to parse media stream message:', error.message);
      return;
    }

    if (message.event === 'start') {
      streamSid = message.start.streamSid;
      const customParameters = message.start.customParameters || {};
      activeCustomerName = customParameters.customerName || activeCustomerName;
      activeClientName = customParameters.clientName || activeClientName;
      activeCustomerId = customParameters.customerId ? Number(customParameters.customerId) : null;
      activeAgentId = customParameters.agentId ? Number(customParameters.agentId) : null;
      activeAgentConfig = activeAgentId ? await getAgentConfigById(activeAgentId) : await getDefaultAgentConfig();
      activeClientName = activeAgentConfig?.client_name || activeClientName;
      activeCallSid = message.start.callSid || activeCallSid;
      if (activeCallSid) {
        const callRow = await dbGet('SELECT id FROM calls WHERE twilio_sid = ?', [activeCallSid]);
        activeCallId = callRow?.id || null;
      }

      console.log(`[STREAM] streamSid: ${streamSid}`);
      console.log(`[STREAM] Start payload: ${JSON.stringify(message.start)}`);
      console.log(`[STREAM] Active customer=${activeCustomerName} client=${activeClientName}`);
      await refreshLiveCallState({ status: 'active', started_at: new Date().toISOString() });
      connectDeepgram();
      return;
    }

    if (message.event === 'media') {
      if (!deepgramReady || deepgramWs?.readyState !== WebSocket.OPEN) {
        return;
      }

      const audioChunk = Buffer.from(message.media.payload, 'base64');
      deepgramWs.send(audioChunk);
      return;
    }

    if (message.event === 'dtmf') {
      const digit = String(message.dtmf?.digit || '').trim();
      if (!digit) {
        return;
      }

      interruptAssistant(`dtmf ${digit}`);
      const utterance = inferDtmfUtterance(digit, transcript);
      console.log(`[DTMF] Received digit=${digit} mapped="${utterance}"`);
      pushTranscriptTurn(transcript, 'CUSTOMER', `[DTMF ${digit}] ${utterance}`);
      queueAssistantTurn(utterance).catch((error) => {
        console.error('[ASSISTANT TURN ERROR]', error.message);
      });
      return;
    }

    if (message.event === 'stop') {
      console.log('[STREAM] Call ended');
      await closeCallSession('completed');
    }
  });

  twilioWs.on('close', () => {
    console.log('[STREAM] Media stream closed');
    closeCallSession('closed').catch((error) => {
      console.error('[STREAM CLOSE ERROR]', error.message);
    });
  });

  twilioWs.on('error', (error) => {
    console.error('[STREAM WS ERROR]', error.message);
  });
}

const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/call/stream' });

wss.on('connection', (twilioWs, req) => {
  if (USE_ORCHESTRATED_PIPELINE) {
    setupOrchestratedStream(twilioWs, req);
    return;
  }

  console.log('[STREAM] Media stream connected');
  console.log(`[STREAM] Upgrade request from ${req.socket.remoteAddress || 'unknown'}`);

  let aiWs;
  let streamSid;
  let transcriptPrinted = false;
  const transcript = [];
  let geminiSetupComplete = false;
  let geminiOpeningPromptRetryTimer = null;
  let geminiAudioReceived = false;
  let aiSessionStarting = false;
  let activeCustomerName = process.env.CUSTOMER_NAME || 'Customer';
  let activeClientName = CLIENT_NAME;
  let activeAgentId = null;
  let activeAgentConfig = null;
  let activeCustomerId = null;
  let activeCallSid = null;
  let activeCallId = null;
  let transportMode = 'twilio';
  let transcriptPersisted = false;
  let callClosed = false;
  let autoHangupTimer = null;

  const getActiveSystemPrompt = () => buildAgentSystemPrompt(activeClientName, activeCustomerName, activeAgentConfig);
  const getActiveOpeningPrompt = () => buildOpeningPrompt(activeClientName, activeCustomerName, activeAgentConfig);
  const getActiveModelName = () => activeAgentConfig?.llm_model || REALTIME_MODEL;

  const printTranscriptOnce = () => {
    if (!transcriptPrinted) {
      transcriptPrinted = true;
      printTranscript(transcript);
    }
  };

  async function persistTranscriptOnce() {
    if (transcriptPersisted) {
      return;
    }

    transcriptPersisted = true;

    try {
      const result = await saveCallFeedbackFromTranscript({
        dbGet,
        dbRun,
        callSid: activeCallSid,
        customerId: activeCustomerId,
        transcript
      });

      if (result.saved) {
        console.log(`[FEEDBACK] Auto-saved call feedback as record ${result.feedbackId} (${result.category})`);
      } else {
        console.log(`[FEEDBACK] Skipped auto-save: ${result.reason}`);
      }
    } catch (error) {
      console.error('[FEEDBACK SAVE ERROR]', error.message);
    }
  }

  async function refreshLiveCallState(partial = {}) {
    if (!activeCallSid) return;

    const current = liveCallState.get(activeCallSid) || {
      call_sid: activeCallSid,
      customer_name: activeCustomerName,
      customer_id: activeCustomerId,
      call_id: activeCallId,
      started_at: new Date().toISOString(),
      transcript_preview: '',
      live_sentiment_label: 'neutral',
      live_sentiment_score: 0,
      red_flag: false,
      escalation_requested: false,
      status: 'active',
      agent_id: activeAgentId,
      agent_name: activeAgentConfig?.name || null
    };

    liveCallState.set(activeCallSid, {
      ...current,
      ...partial,
      customer_name: activeCustomerName,
      customer_id: activeCustomerId,
      agent_id: activeAgentId,
      agent_name: activeAgentConfig?.name || null,
      call_id: activeCallId,
      transcript_preview: transcript.slice(-4).map((turn) => `[${turn.role}] ${turn.text}`).join('\n')
    });

    if (activeCallId) {
      const nextState = liveCallState.get(activeCallSid);
      await dbRun(
        `UPDATE calls
            SET live_sentiment_score = ?,
                live_sentiment_label = ?,
                live_red_flag = ?,
                supervisor_alert_level = ?,
                human_escalation_requested = ?
          WHERE id = ?`,
        [
          nextState.live_sentiment_score || 0,
          nextState.live_sentiment_label || 'neutral',
          nextState.red_flag ? 1 : 0,
          nextState.red_flag ? 'high' : 'normal',
          nextState.escalation_requested ? 1 : 0,
          activeCallId
        ]
      );
    }
  }

  function clearAutoHangupTimer() {
    if (autoHangupTimer) {
      clearTimeout(autoHangupTimer);
      autoHangupTimer = null;
    }
  }

  function clearGeminiOpeningPromptRetry() {
    if (geminiOpeningPromptRetryTimer) {
      clearTimeout(geminiOpeningPromptRetryTimer);
      geminiOpeningPromptRetryTimer = null;
    }
  }

  function sendGeminiOpeningPrompt(promptText, label = 'opening') {
    const safePrompt = String(promptText || '').trim();
    if (!safePrompt || aiWs?.readyState !== WebSocket.OPEN || !geminiSetupComplete) {
      return;
    }

    console.log(`[GEMINI] Sending ${label} prompt (${safePrompt.length} chars)`);

    if (usesGeminiRealtimeTextInput(getActiveModelName())) {
      aiWs.send(JSON.stringify({
        realtimeInput: {
          text: safePrompt
        }
      }));
      return;
    }

    aiWs.send(JSON.stringify({
      clientContent: {
        turns: [
          {
            role: 'user',
            parts: [{ text: safePrompt }]
          }
        ],
        turnComplete: true
      }
    }));
  }

  function scheduleAutoHangupFromAgentText(text) {
    clearAutoHangupTimer();
    if (!shouldAutoHangupAfterAgentTurn(text) || callClosed) {
      return;
    }

    const delayMs = estimateHangupDelayMs(text);
    autoHangupTimer = setTimeout(() => {
      if (callClosed) {
        return;
      }
      callClosed = true;
      console.log(`[AUTO HANGUP] Closing legacy call after farewell (${delayMs}ms)`);
      refreshLiveCallState({ status: 'completed' }).catch(() => {});
      printTranscriptOnce();
      persistTranscriptOnce().catch((error) => {
        console.error('[FEEDBACK SAVE ERROR]', error.message);
      });
      if (aiWs?.readyState === WebSocket.OPEN) {
        aiWs.close();
      }
      clearGeminiOpeningPromptRetry();
      if (twilioWs.readyState === WebSocket.OPEN) {
        twilioWs.close();
      }
    }, delayMs);
  }

  function sendAudioToCaller(base64Payload) {
    if (!streamSid || !base64Payload) {
      return;
    }

    twilioWs.send(JSON.stringify({
      event: 'media',
      streamSid,
      media: { payload: base64Payload }
    }));
  }

  function sendTextInputToAi(text) {
    const safeText = String(text || '').trim();
    if (!safeText || aiWs?.readyState !== WebSocket.OPEN) {
      return;
    }

    if (AI_PROVIDER === 'gemini') {
      if (!geminiSetupComplete) {
        return;
      }

      if (usesGeminiRealtimeTextInput(getActiveModelName())) {
        aiWs.send(JSON.stringify({
          realtimeInput: {
            text: safeText
          }
        }));
      } else {
        aiWs.send(JSON.stringify({
          clientContent: {
            turns: [
              {
                role: 'user',
                parts: [{ text: safeText }]
              }
            ],
            turnComplete: true
          }
        }));
      }
      return;
    }

    aiWs.send(JSON.stringify({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: safeText
          }
        ]
      }
    }));

    aiWs.send(JSON.stringify({
      type: 'response.create',
      response: {
        output_modalities: ['audio']
      }
    }));
  }

  function createOpenAiSession() {
    aiSessionStarting = true;
    aiWs = new WebSocket(`wss://api.openai.com/v1/realtime?model=${encodeURIComponent(getActiveModelName())}`, {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'OpenAI-Beta': 'realtime=v1'
      }
    });

    aiWs.on('open', () => {
      console.log('[OPENAI] Realtime session opened');

      aiWs.send(JSON.stringify({
        type: 'session.update',
        session: {
          type: 'realtime',
          instructions: getActiveSystemPrompt(),
          output_modalities: ['audio'],
          audio: {
            input: {
              format: { type: transportMode === 'exotel' ? 'audio/pcm' : 'audio/pcmu' },
              transcription: {
                model: 'gpt-4o-mini-transcribe'
              },
              turn_detection: {
                type: 'server_vad',
                threshold: 0.5,
                prefix_padding_ms: 300,
                silence_duration_ms: 500,
                create_response: true,
                interrupt_response: true
              }
            },
            output: {
              format: { type: transportMode === 'exotel' ? 'audio/pcm' : 'audio/pcmu' },
              voice: 'alloy'
            }
          }
        }
      }));

      aiWs.send(JSON.stringify({
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: getActiveOpeningPrompt()
            }
          ]
        }
      }));

      aiWs.send(JSON.stringify({
        type: 'response.create',
        response: {
          output_modalities: ['audio'],
          instructions: `${getActiveSystemPrompt()}\n\n${getActiveOpeningPrompt()}`
        }
      }));
    });
  }

  function createGeminiSession() {
    aiSessionStarting = true;
    aiWs = new WebSocket(GEMINI_WS_URL, {
      headers: {
        'x-goog-api-key': process.env.GEMINI_API_KEY
      }
    });

    aiWs.on('open', () => {
      console.log('[GEMINI] Live session opened');
      aiWs.send(JSON.stringify({
        setup: {
          model: getActiveModelName(),
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
                text: getActiveSystemPrompt()
              }
            ]
          },
          realtimeInputConfig: {},
          inputAudioTranscription: {},
          outputAudioTranscription: {}
        }
      }));
    });
  }

  function attachAiEventHandlers() {
    aiWs.on('message', (raw) => {
      let message;

      try {
        message = JSON.parse(raw.toString());
      } catch (error) {
        console.error(`[${AI_PROVIDER.toUpperCase()}] Failed to parse message:`, error.message);
        return;
      }

      if (AI_PROVIDER === 'gemini') {
        if (message.setupComplete) {
          geminiSetupComplete = true;
          console.log('[GEMINI] Session configured');
          console.log(`[GEMINI] Config model=${getActiveModelName()} voice=${GEMINI_VOICE} transport=${transportMode}`);

          geminiAudioReceived = false;
          clearGeminiOpeningPromptRetry();
          sendGeminiOpeningPrompt(getActiveOpeningPrompt(), 'initial');
          geminiOpeningPromptRetryTimer = setTimeout(() => {
            if (callClosed || geminiAudioReceived || aiWs?.readyState !== WebSocket.OPEN) {
              return;
            }
            console.warn('[GEMINI] No audible response detected after the opening prompt; retrying with a shorter opener.');
            sendGeminiOpeningPrompt(
              `Namaste, kya main ${activeCustomerName} se baat kar rahi hoon? Main Priya bol rahi hoon, ${activeClientName} se. Kya aapke paas 2 se 3 minute hain?`,
              'retry'
            );
          }, 7000);
          return;
        }

        if (message.serverContent?.inputTranscription?.text) {
          clearAutoHangupTimer();
          pushTranscriptTurn(transcript, 'CUSTOMER', message.serverContent.inputTranscription.text);
          console.log(`[CUSTOMER]: ${message.serverContent.inputTranscription.text}`);
          const sentiment = evaluateLiveSentimentLabel(message.serverContent.inputTranscription.text);
          const redFlag = sentiment.label === 'negative';
          refreshLiveCallState({
            live_sentiment_label: sentiment.label,
            live_sentiment_score: sentiment.score,
            red_flag: redFlag
          }).catch(() => {});
          if (redFlag && activeCallId) {
            createSupervisorEvent({
              dbRun,
              callId: activeCallId,
              eventType: 'live_negative_signal',
              severity: 'high',
              payload: { transcript: message.serverContent.inputTranscription.text }
            }).catch(() => {});
          }
        }

        if (message.serverContent?.outputTranscription?.text) {
          pushTranscriptTurn(transcript, 'AGENT', message.serverContent.outputTranscription.text);
          console.log(`[AGENT]: ${message.serverContent.outputTranscription.text}`);
          refreshLiveCallState({}).catch(() => {});
          scheduleAutoHangupFromAgentText(message.serverContent.outputTranscription.text);
        }

        const parts = message.serverContent?.modelTurn?.parts || [];
        for (const part of parts) {
          if (!part.inlineData?.data || !String(part.inlineData.mimeType || '').startsWith('audio/pcm')) {
            continue;
          }

          geminiAudioReceived = true;
          clearGeminiOpeningPromptRetry();
          const pcm16 = Buffer.from(part.inlineData.data, 'base64');
          const sourceRate = parsePcmRate(part.inlineData.mimeType, 24000);
          const resampled = resamplePcm16(pcm16, sourceRate, 8000);
          const outboundAudio = transportMode === 'exotel'
            ? resampled.toString('base64')
            : encodeMuLawFromPcm16(resampled).toString('base64');
          console.log(`[GEMINI] Outbound audio chunk mime=${part.inlineData.mimeType} sourceRate=${sourceRate} bytes=${resampled.length}`);
          sendAudioToCaller(outboundAudio);
        }

        if (message.serverContent?.interrupted) {
          console.log('[GEMINI] Response interrupted');
        }

        if (message.error) {
          console.error('[GEMINI ERROR]', JSON.stringify(message, null, 2));
        }
        return;
      }

      if (message.type === 'session.updated') {
        console.log('[OPENAI] Session configured');
        return;
      }

      if (message.type === 'response.created') {
        console.log('[OPENAI] Response created');
        return;
      }

      if (message.type === 'response.output_audio.delta' && message.delta) {
        sendAudioToCaller(message.delta);
        return;
      }

      if (message.type === 'response.output_audio_transcript.done') {
        pushTranscriptTurn(transcript, 'AGENT', message.transcript);
        console.log(`[AGENT]: ${message.transcript}`);
        refreshLiveCallState({}).catch(() => {});
        scheduleAutoHangupFromAgentText(message.transcript);
        return;
      }

      if (message.type === 'conversation.item.input_audio_transcription.completed') {
        clearAutoHangupTimer();
        pushTranscriptTurn(transcript, 'CUSTOMER', message.transcript);
        console.log(`[CUSTOMER]: ${message.transcript}`);
        const sentiment = evaluateLiveSentimentLabel(message.transcript);
        const redFlag = sentiment.label === 'negative';
        refreshLiveCallState({
          live_sentiment_label: sentiment.label,
          live_sentiment_score: sentiment.score,
          red_flag: redFlag
        }).catch(() => {});
        return;
      }

      if (message.type === 'error') {
        console.error('[OPENAI ERROR]', JSON.stringify(message, null, 2));
      }
    });

    aiWs.on('close', () => {
      aiSessionStarting = false;
      console.log(`[${AI_PROVIDER.toUpperCase()}] Realtime session closed`);
    });

    aiWs.on('error', (error) => {
      aiSessionStarting = false;
      console.error(`[${AI_PROVIDER.toUpperCase()} WS ERROR]`, error.message);
    });
  }

  function ensureAiSession() {
    if (aiWs || aiSessionStarting) {
      return;
    }

    if (AI_PROVIDER === 'gemini') {
      createGeminiSession();
    } else {
      createOpenAiSession();
    }

    attachAiEventHandlers();
  }

  twilioWs.on('message', async (raw) => {
    let message;

    try {
      message = JSON.parse(raw.toString());
    } catch (error) {
      console.error('[STREAM] Failed to parse media stream message:', error.message);
      return;
    }

    if (message.event === 'start') {
      const start = extractStartPayload(message);
      streamSid = getStreamSidFromMessage(message);
      transportMode = getTransportModeFromStartPayload(start, req);
      const customParameters = getCustomParametersFromStart(start);
      activeCustomerName = customParameters.customerName || activeCustomerName;
      activeClientName = customParameters.clientName || activeClientName;
      activeCustomerId = customParameters.customerId ? Number(customParameters.customerId) : null;
      activeAgentId = customParameters.agentId ? Number(customParameters.agentId) : null;
      activeAgentConfig = activeAgentId ? await getAgentConfigById(activeAgentId) : await getDefaultAgentConfig();
      activeClientName = activeAgentConfig?.client_name || activeClientName;
      activeCallSid = getCallSidFromStart(start) || new URL(req.url, 'http://localhost').searchParams.get('callSid') || activeCallSid;

      if (!activeCustomerId) {
        const hintedPhone = start.from || new URL(req.url, 'http://localhost').searchParams.get('from') || '';
        const customer = await findCustomerByPhone(hintedPhone);
        if (customer) {
          activeCustomerId = customer.id;
          activeCustomerName = customer.name || activeCustomerName;
          if (!activeAgentId && customer.default_agent_id) {
            activeAgentId = Number(customer.default_agent_id) || null;
            activeAgentConfig = activeAgentId ? await getAgentConfigById(activeAgentId) : activeAgentConfig;
            activeClientName = activeAgentConfig?.client_name || activeClientName;
          }
        }
      }

      if (activeCallSid) {
        const callRow = await dbGet('SELECT id FROM calls WHERE twilio_sid = ?', [activeCallSid]);
        activeCallId = callRow?.id || null;
      }
      console.log(`[STREAM] streamSid: ${streamSid}`);
      console.log(`[STREAM] Start payload: ${JSON.stringify(start)}`);
      console.log(`[STREAM] Transport=${transportMode} customer=${activeCustomerName} client=${activeClientName}`);
      console.log(`[STREAM] AI provider=${AI_PROVIDER} model=${getActiveModelName()}`);
      await refreshLiveCallState({ status: 'active', started_at: new Date().toISOString() });
      ensureAiSession();
      return;
    }

    if (message.event === 'media' && aiWs?.readyState === WebSocket.OPEN) {
      const payload = getMediaPayload(message);
      if (!payload) {
        return;
      }

      if (AI_PROVIDER === 'gemini') {
        if (!geminiSetupComplete) {
          console.log('[STREAM] Dropping media chunk until Gemini setup completes');
          return;
        }

        const pcm16 = transportMode === 'exotel'
          ? Buffer.from(payload, 'base64')
          : decodeMuLaw(payload);
        if (!geminiAudioReceived) {
          console.log(`[GEMINI] First inbound audio chunk received (${pcm16.length} bytes)`);
        }
        aiWs.send(JSON.stringify({
          realtimeInput: {
            audio: {
              data: pcm16.toString('base64'),
              mimeType: 'audio/pcm;rate=8000'
            }
          }
        }));
        return;
      }

      aiWs.send(JSON.stringify({
        type: 'input_audio_buffer.append',
        audio: transportMode === 'exotel'
          ? encodeMuLawFromPcm16(Buffer.from(payload, 'base64')).toString('base64')
          : payload
      }));
      return;
    }

    if (message.event === 'dtmf') {
      const digit = String(message.dtmf?.digit || '').trim();
      if (!digit) {
        return;
      }

      const utterance = inferDtmfUtterance(digit, transcript);
      console.log(`[DTMF] Received digit=${digit} mapped="${utterance}"`);
      pushTranscriptTurn(transcript, 'CUSTOMER', `[DTMF ${digit}] ${utterance}`);
      sendTextInputToAi(utterance);
      return;
    }

    if (message.event === 'stop') {
      console.log('[STREAM] Call ended');
      callClosed = true;
      clearAutoHangupTimer();
      clearGeminiOpeningPromptRetry();
      refreshLiveCallState({ status: 'completed' }).catch(() => {});
      printTranscriptOnce();
      persistTranscriptOnce().catch((error) => {
        console.error('[FEEDBACK SAVE ERROR]', error.message);
      });

      if (aiWs?.readyState === WebSocket.OPEN) {
        aiWs.close();
      }
    }
  });

  twilioWs.on('close', () => {
    console.log('[STREAM] Media stream closed');
    callClosed = true;
    clearAutoHangupTimer();
    clearGeminiOpeningPromptRetry();
    refreshLiveCallState({ status: 'closed' }).catch(() => {});
    printTranscriptOnce();
    persistTranscriptOnce().catch((error) => {
      console.error('[FEEDBACK SAVE ERROR]', error.message);
    });

    if (aiWs?.readyState === WebSocket.OPEN) {
      aiWs.close();
    }
  });

  twilioWs.on('error', (error) => {
    console.error('[STREAM WS ERROR]', error.message);
  });
});

(async () => {
  try {
    validateConfig();
    await initializeDatabase();
    logConfigSnapshot('SERVER');

    setInterval(() => {
      runSchedulerTick().catch((error) => {
        console.error('[SCHEDULER ERROR]', error.message);
      });
    }, 15000);

    setInterval(() => {
      runOwnerDigestTick().catch((error) => {
        console.error('[OWNER DIGEST ERROR]', error.message);
      });
    }, 60000);

    setInterval(() => {
      pruneLiveCallState();
    }, 60000);

    runSchedulerTick().catch((error) => {
      console.error('[SCHEDULER ERROR]', error.message);
    });

    runOwnerDigestTick().catch((error) => {
      console.error('[OWNER DIGEST ERROR]', error.message);
    });

    server.listen(PORT, () => {
      console.log(`[SERVER] Running on http://localhost:${PORT}`);
      console.log(`[SERVER] Public base URL: ${PUBLIC_BASE_URL}`);
      console.log(`[SERVER] Call mode: ${CALL_MODE}`);
      console.log(`[SERVER] Voice pipeline: ${VOICE_PIPELINE}`);
      console.log(`[SERVER] Realtime model: ${REALTIME_MODEL}`);
      console.log('[SERVER] Scheduler active: checks pending customers every 15 seconds');
      console.log('[SERVER] Owner digest active: checks 8 AM morning delivery every 60 seconds');
      console.log('[SERVER] Admin UI: http://localhost:3000/admin.html');
      console.log('[SERVER] Ready. Trigger a call with: curl -X POST http://localhost:3000/call/start');
    });
  } catch (error) {
    console.error('[CONFIG ERROR]', error.message);
    process.exit(1);
  }
})();
