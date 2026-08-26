require('dotenv').config();

const express = require('express');
const http = require('http');
const path = require('path');
const WebSocket = require('ws');
const twilio = require('twilio');
const { initializeDatabase } = require('./db');
const { createCustomersRouter } = require('./routes/customers');
const { createPostgres } = require('./persistence/postgres');
const { createRepositories } = require('./repositories');
const { createFeedbackRouter } = require('./routes/feedback');
const { createReportsRouter } = require('./routes/reports');
const { createAuthRouter } = require('./routes/auth');
const { createSupabaseAuth } = require('./auth/supabase-auth');
const { createSessionMiddleware } = require('./auth/session');
const { createAuthMiddleware, requireRole, sameOrigin } = require('./auth/middleware');
const { currentClientId, runWithClient } = require('./auth/client-context');
const { loadRuntimeConfig } = require('./config/runtime-config');
const { createLogger } = require('./logging/logger');
const { createRequestContext } = require('./middleware/request-context');
const { validateTwilioHttp, validateTwilioUpgrade } = require('./middleware/twilio-validation');
const { createHealthHandler, shutdownRuntime } = require('./runtime/lifecycle');
const { saveCallFeedbackFromTranscript } = require('./services/call-feedback');
const { processCompletedCallPipeline } = require('./services/post-call-pipeline');
const {
  buildPreCallIntelligence,
  computePriorityScore,
  getCurrentSlotLabel,
  applyCallOutcomeWorkflow,
  createSupervisorEvent
} = require('./services/call-orchestration');

const runtimeConfig = loadRuntimeConfig(process.env);
const originalConsole = {
  log: console.log.bind(console),
  error: console.error.bind(console)
};
const logger = createLogger({ sink: originalConsole });
console.log = (...args) => logger.info('application_log', { message: args.map((value) => value instanceof Error ? value.message : String(value)).join(' ') });
console.warn = (...args) => logger.warn('application_log', { message: args.map(String).join(' ') });
console.error = (...args) => logger.error('application_log', { message: args.map((value) => value instanceof Error ? value.message : String(value)).join(' ') });

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.set('trust proxy', 1);
app.use(createSessionMiddleware({
  secret: runtimeConfig.cookieSecret,
  secure: runtimeConfig.nodeEnv === 'production',
  maxAgeMs: runtimeConfig.sessionMaxAgeMs
}));
app.use(createRequestContext({ logger }));

const PORT = runtimeConfig.port;
const CALL_MODE = process.env.CALL_MODE || (process.env.OPENAI_API_KEY ? 'openai' : 'scripted');
const AI_PROVIDER = CALL_MODE === 'gemini' ? 'gemini' : 'openai';
const OPENAI_REALTIME_MODEL = process.env.OPENAI_REALTIME_MODEL || 'gpt-realtime';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'models/gemini-3.1-flash-live-preview';
const GEMINI_VOICE = process.env.GEMINI_VOICE || 'Kore';
const REALTIME_MODEL = AI_PROVIDER === 'gemini' ? GEMINI_MODEL : OPENAI_REALTIME_MODEL;
const CLIENT_NAME = process.env.CLIENT_NAME || 'your diagnostic and medical collection center';
const PUBLIC_BASE_URL = runtimeConfig.publicBaseUrl;
const GEMINI_WS_URL = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';
const liveCallState = new Map();

let postgres;
let repositories;
let activeClientId;
let passwordAuth;

function getRepositories() {
  if (!repositories) throw new Error('Repositories are not initialized');
  return repositories;
}

function getActiveClientId() {
  const selectedClientId = currentClientId() || activeClientId;
  if (!selectedClientId) throw new Error('Active client context is not initialized');
  return selectedClientId;
}

function repositoryProxy(name) {
  return new Proxy({}, {
    get(_target, property) {
      return (...args) => getRepositories()[name][property](...args);
    }
  });
}

const customerRepositoryProxy = repositoryProxy('customers');
const feedbackRepositoryProxy = repositoryProxy('feedback');
const userRepositoryProxy = repositoryProxy('users');
const clientRepositoryProxy = repositoryProxy('clients');
const passwordAuthProxy = {
  verifyPassword(...args) {
    if (!passwordAuth) throw new Error('Supabase Auth is not initialized');
    return passwordAuth.verifyPassword(...args);
  }
};
const authMiddleware = createAuthMiddleware({ users: userRepositoryProxy, clients: clientRepositoryProxy });
const webmasterOnly = requireRole('webmaster');
const browserSameOrigin = sameOrigin({ publicBaseUrl: PUBLIC_BASE_URL });
const twilioHttpValidation = validateTwilioHttp({
  authToken: process.env.TWILIO_AUTH_TOKEN,
  publicBaseUrl: PUBLIC_BASE_URL,
  logger
});
const twilioUpgradeValidation = validateTwilioUpgrade({
  authToken: process.env.TWILIO_AUTH_TOKEN,
  publicBaseUrl: PUBLIC_BASE_URL,
  logger
});

async function providerClientContext(req, res, next) {
  try {
    const clientId = Number(req.query.clientId);
    if (!Number.isSafeInteger(clientId) || clientId <= 0) return res.status(400).json({ error: 'Invalid client context' });
    const client = await getRepositories().clients.findById(clientId);
    if (!client || client.status !== 'active') return res.status(404).json({ error: 'Client not found' });
    runWithClient(clientId, next);
  } catch (error) {
    next(error);
  }
}

async function initializeCustomerPersistence() {
  if (!process.env.SUPABASE_DB_URL) throw new Error('SUPABASE_DB_URL is required');

  postgres = createPostgres({
    connectionString: runtimeConfig.supabaseDbUrl,
    ssl: runtimeConfig.databaseSsl,
    logger
  });
  await postgres.ping();

  repositories = createRepositories(postgres);
  if (process.env.NODE_ENV === 'test' && process.env.SUPABASE_TEST_AUTH_BYPASS === 'true') {
    passwordAuth = {
      async verifyPassword(email, password) {
        if (email !== process.env.SUPABASE_TEST_AUTH_EMAIL || password !== process.env.SUPABASE_TEST_AUTH_PASSWORD) return null;
        return { id: process.env.SUPABASE_TEST_AUTH_USER_ID };
      }
    };
  } else {
    passwordAuth = createSupabaseAuth({
      url: runtimeConfig.supabaseUrl,
      anonKey: runtimeConfig.supabasePublishableKey
    });
  }
  const [client] = await repositories.clients.listActive();
  if (!client) {
    await postgres.close();
    postgres = undefined;
    throw new Error('At least one active Supabase client is required');
  }

  activeClientId = client.id;
}

const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

function buildAgentSystemPrompt(clientName, customerName) {
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

function buildOpeningPrompt(clientName, customerName) {
  return [
    `Start the phone call now as Priya from ${clientName}.`,
    `The customer name is ${customerName}.`,
    `Your first spoken turn should closely follow this wording in Hindi: "Namaste, kya main ${customerName} se baat kar rahi hoon? Main Priya bol rahi hoon, ${clientName} se. Main aapki recent visit ka chhota sa feedback lena chahti hoon. Kya aapke paas 2 se 3 minute hain?"`,
    'After that, continue the conversation naturally using the feedback flow in the system instructions.',
    'Keep every reply short, warm, phone-friendly, and in Hindi only.',
    'Speak clearly and a little slowly.'
  ].join(' ');
}

function validateConfig() {
  const missing = [
    'TWILIO_ACCOUNT_SID',
    'TWILIO_AUTH_TOKEN',
    'TWILIO_PHONE_NUMBER',
    'CUSTOMER_PHONE',
    'CUSTOMER_NAME'
  ].filter((key) => !process.env[key]);

  if (CALL_MODE === 'openai' && !process.env.OPENAI_API_KEY) {
    missing.push('OPENAI_API_KEY');
  }

  if (CALL_MODE === 'gemini' && !process.env.GEMINI_API_KEY) {
    missing.push('GEMINI_API_KEY');
  }

  if (!PUBLIC_BASE_URL) {
    missing.push('NGROK_URL');
  }

  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
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

function buildScriptedTwiml(customerName, clientName, clientId) {
  const twiml = new twilio.twiml.VoiceResponse();
  const encodedCustomerName = encodeURIComponent(customerName || process.env.CUSTOMER_NAME || 'Customer');
  const encodedClientName = encodeURIComponent(clientName || CLIENT_NAME);
  const gather = twiml.gather({
    input: 'dtmf speech',
    numDigits: 1,
    timeout: 6,
    speechTimeout: 'auto',
    language: 'hi-IN',
    actionOnEmptyResult: true,
    action: `/call/scripted/consent?lang=hi&customerName=${encodedCustomerName}&clientName=${encodedClientName}&clientId=${encodeURIComponent(String(clientId))}`,
    method: 'POST'
  });

  gather.say({ language: 'hi-IN' }, getScriptedCopy('hi', customerName, clientName).intro);

  twiml.say({ language: 'hi-IN' }, getScriptedCopy('hi', customerName, clientName).noLanguageResponse);
  twiml.hangup();
  return twiml.toString();
}

function buildScriptedLanguageResponse(req) {
  const speech = String(req.body.SpeechResult || '').trim().toLowerCase();
  const digit = String(req.body.Digits || '').trim();
  const language = detectLanguageChoice(speech, digit);
  const copy = getScriptedCopy(language, req.query.customerName, req.query.clientName);
  const twiml = new twilio.twiml.VoiceResponse();
  const encodedCustomerName = encodeURIComponent(req.query.customerName || process.env.CUSTOMER_NAME || 'Customer');
  const encodedClientName = encodeURIComponent(req.query.clientName || CLIENT_NAME);

  const gather = twiml.gather({
    input: 'speech dtmf',
    numDigits: 1,
    timeout: 7,
    speechTimeout: 'auto',
    language: language === 'en' ? 'en-IN' : 'hi-IN',
    actionOnEmptyResult: true,
    action: `/call/scripted/consent?lang=${language}&customerName=${encodedCustomerName}&clientName=${encodedClientName}&clientId=${encodeURIComponent(String(req.query.clientId))}`,
    method: 'POST'
  });

  gather.say({ language: language === 'en' ? 'en-IN' : 'hi-IN' }, copy.consent);

  twiml.say({ language: language === 'en' ? 'en-IN' : 'hi-IN' }, copy.noConsentResponse);
  twiml.hangup();
  return twiml.toString();
}

function buildScriptedConsentResponse(req) {
  const speech = String(req.body.SpeechResult || '').trim();
  const digit = String(req.body.Digits || '').trim();
  const language = req.query.lang === 'en' ? 'en' : 'hi';
  const copy = getScriptedCopy(language, req.query.customerName, req.query.clientName);
  const twiml = new twilio.twiml.VoiceResponse();
  const encodedCustomerName = encodeURIComponent(req.query.customerName || process.env.CUSTOMER_NAME || 'Customer');
  const encodedClientName = encodeURIComponent(req.query.clientName || CLIENT_NAME);

  if (!isAffirmativeResponse(speech, digit)) {
    twiml.say({ language: 'hi-IN' }, copy.decline);
    twiml.hangup();
    return twiml.toString();
  }

  const gather = twiml.gather({
    input: 'speech dtmf',
    numDigits: 1,
    timeout: 10,
    speechTimeout: 'auto',
    language: 'hi-IN',
    actionOnEmptyResult: true,
    action: `/call/scripted/rating?lang=${language}&customerName=${encodedCustomerName}&clientName=${encodedClientName}&clientId=${encodeURIComponent(String(req.query.clientId))}`,
    method: 'POST'
  });

  gather.say({ language: 'hi-IN' }, copy.rating);

  twiml.say({ language: 'hi-IN' }, copy.noRatingResponse);
  twiml.hangup();
  return twiml.toString();
}

function buildScriptedRatingResponse(req) {
  const speech = String(req.body.SpeechResult || '').trim();
  const digit = String(req.body.Digits || '').trim();
  const language = req.query.lang === 'en' ? 'en' : 'hi';
  const copy = getScriptedCopy(language, req.query.customerName, req.query.clientName);
  const rating = digit || speech;
  const twiml = new twilio.twiml.VoiceResponse();

  console.log(`[SCRIPTED] Rating response: ${rating || 'none'}`);

  twiml.say({ language: 'hi-IN' }, copy.closing);
  twiml.hangup();
  return twiml.toString();
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

function usesGeminiRealtimeTextInput(modelName) {
  return String(modelName || '').includes('gemini-3.1');
}

async function placeRealtimeCall({ customerPhone, customerName, customerId, clientName }) {
  const safeCustomerName = encodeURIComponent(customerName || process.env.CUSTOMER_NAME || 'Customer');
  const safeClientName = encodeURIComponent(clientName || CLIENT_NAME);
  const safeCustomerId = customerId ? `&customerId=${encodeURIComponent(String(customerId))}` : '';
  const safeClientId = encodeURIComponent(String(getActiveClientId()));

  const twimlUrl = `${PUBLIC_BASE_URL}/call/twiml?customerName=${safeCustomerName}&clientName=${safeClientName}${safeCustomerId}&clientId=${safeClientId}`;
  const statusUrl = `${PUBLIC_BASE_URL}/call/status?clientId=${safeClientId}${safeCustomerId}`;
  const recordingStatusUrl = `${PUBLIC_BASE_URL}/call/recording-status?clientId=${safeClientId}${safeCustomerId}`;

  return twilioClient.calls.create({
    to: customerPhone,
    from: process.env.TWILIO_PHONE_NUMBER,
    url: twimlUrl,
    method: 'GET',
    statusCallback: statusUrl,
    statusCallbackMethod: 'POST',
    record: true,
    recordingChannels: 'dual',
    recordingStatusCallback: recordingStatusUrl,
    recordingStatusCallbackMethod: 'POST'
  });
}

async function ensureCustomerForCall({ customerId, customerName, customerPhone }) {
  const clientId = getActiveClientId();
  const customers = getRepositories().customers;
  if (customerId) {
    const existingById = await customers.findById(clientId, customerId);
    if (existingById) {
      return existingById;
    }
  }

  const existingByPhone = await customers.findByPhone(clientId, customerPhone);
  if (existingByPhone) {
    return existingByPhone;
  }

  return customers.create(clientId, {
    name: customerName || 'Customer',
    phone: customerPhone,
    preferred_slot: '10:00',
    status: 'pending'
  });
}

async function getCustomerCallHistory(customerId, limit = 20) {
  if (!customerId) return [];
  return getRepositories().calls.listForCustomer(getActiveClientId(), customerId, { limit });
}

async function hydratePreCallIntelligence(customer) {
  const history = await getCustomerCallHistory(customer.id);
  const intelligence = buildPreCallIntelligence(customer, history);

  await getRepositories().customers.update(getActiveClientId(), customer.id, {
    priority_score: intelligence.priorityScore,
    ai_score: intelligence.priorityScore,
    best_call_slot: intelligence.bestCallSlot,
    preferred_dialect: intelligence.preferredDialect,
    outstanding_issues: intelligence.outstandingIssues.join('\n') || null,
    last_sentiment_label: intelligence.lastSentimentLabel || null,
    pickup_rate_score: intelligence.pickupRateScore,
    dnd_checked_at: new Date().toISOString()
  });

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

async function triggerScheduledCalls() {
  const now = new Date();
  const currentSlot = getCurrentSlotLabel(now);

  const dueCustomers = await getRepositories().customers.findEligibleForScheduler(
    getActiveClientId(),
    { currentSlot, now, recentCallMinutes: 45, limit: 100 }
  );

  if (!dueCustomers.length) {
    return;
  }

  const hydratedCustomers = [];
  for (const customer of dueCustomers) {
    hydratedCustomers.push(await hydratePreCallIntelligence(customer));
  }

  hydratedCustomers.sort((a, b) => (Number(b.priority_score) || 0) - (Number(a.priority_score) || 0));
  console.log(`[SCHEDULER] Found ${hydratedCustomers.length} eligible customer(s) due at ${currentSlot}`);

  for (const customer of hydratedCustomers) {
    try {
      const blockedReason = shouldBlockCustomerCall(customer);
      if (blockedReason) {
        console.log(`[SCHEDULER] Skipping ${customer.name}: ${blockedReason}`);
        continue;
      }

      const call = await placeRealtimeCall({
        customerPhone: customer.phone,
        customerName: customer.name,
        customerId: customer.id,
        clientName: CLIENT_NAME
      });

      await getRepositories().calls.createAndMarkCustomer(getActiveClientId(), {
        customer_id: customer.id,
        outcome: 'scheduled_initiated',
        twilio_sid: call.sid,
        called_at: new Date().toISOString(),
        hot_lead_score: customer.priority_score || computePriorityScore(customer),
        consent_message_played: true,
        call_script_version: 'hindi-feedback-v1',
        supervisor_alert_level: 'normal',
        customer_status: 'called'
      });
      console.log(`[SCHEDULER] Scheduled call started for ${customer.name} (${call.sid})`);
    } catch (error) {
      console.error(`[SCHEDULER] Failed to call ${customer.name}:`, error.message);
      if (error.code === 21219) {
        await getRepositories().calls.createAndMarkCustomer(getActiveClientId(), {
          customer_id: customer.id,
          outcome: 'twilio_unverified',
          called_at: new Date().toISOString(),
          customer_status: 'twilio_trial_blocked'
        });
      }
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
    const activeClients = await getRepositories().clients.listActive();
    for (const client of activeClients) {
      await runWithClient(client.id, () => triggerScheduledCalls());
    }
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

app.get('/health', createHealthHandler({
  ping: async () => {
    if (!postgres) throw new Error('Database is not initialized');
    return postgres.ping();
  }
}));

app.get('/', (req, res) => {
  res.redirect('/login.html');
});

app.get('/login.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});
app.use('/auth', createAuthRouter({
  supabaseAuth: passwordAuthProxy,
  users: userRepositoryProxy,
  clients: clientRepositoryProxy,
  auth: authMiddleware,
  publicBaseUrl: PUBLIC_BASE_URL
}));
app.get('/admin.html', authMiddleware.reload, webmasterOnly, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});
app.use('/api', authMiddleware.reload, webmasterOnly, browserSameOrigin);

app.use('/api/customers', createCustomersRouter({
  customers: customerRepositoryProxy,
  getClientId: getActiveClientId
}));
app.use('/api/feedback', createFeedbackRouter({
  customers: customerRepositoryProxy,
  feedback: feedbackRepositoryProxy,
  getClientId: getActiveClientId
}));
app.use('/api/reports', createReportsRouter({
  repositories: repositoryProxy('reporting'),
  getClientId: getActiveClientId,
  publicBaseUrl: PUBLIC_BASE_URL
}));

app.post('/call/start', authMiddleware.reload, webmasterOnly, browserSameOrigin, async (req, res) => {
  try {
    const customerPhone = req.body.customerPhone || process.env.CUSTOMER_PHONE;
    const customerName = req.body.customerName || process.env.CUSTOMER_NAME;
    const requestedCustomerId = req.body.customerId;
    const clientName = req.body.clientName || CLIENT_NAME;
    let customer = await ensureCustomerForCall({
      customerId: requestedCustomerId,
      customerName,
      customerPhone
    });
    customer = await hydratePreCallIntelligence(customer);

    const blockedReason = shouldBlockCustomerCall(customer);
    if (blockedReason) {
      return res.status(409).json({ success: false, error: blockedReason });
    }

    console.log(`[CALL REQUEST] to=${customerPhone} from=${process.env.TWILIO_PHONE_NUMBER} twiml=${PUBLIC_BASE_URL}/call/twiml`);
    const call = await placeRealtimeCall({
      customerPhone,
      customerName: customer.name || customerName,
      customerId: customer.id,
      clientName
    });

    const callRecord = await getRepositories().calls.createAndMarkCustomer(getActiveClientId(), {
      customer_id: customer.id,
      outcome: 'initiated',
      twilio_sid: call.sid,
      called_at: new Date().toISOString(),
      hot_lead_score: customer.priority_score || computePriorityScore(customer),
      consent_message_played: true,
      call_script_version: 'hindi-feedback-v1',
      supervisor_alert_level: 'normal',
      customer_status: 'called'
    });

    console.log(`[CALL STARTED] SID: ${call.sid}`);
    res.json({ success: true, sid: call.sid, callId: callRecord.id, customerId: customer.id });
  } catch (error) {
    console.error('[ERROR starting call]', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/call/twiml', twilioHttpValidation, providerClientContext, (req, res) => {
  const customerName = req.query.customerName || process.env.CUSTOMER_NAME;
  const clientName = req.query.clientName || CLIENT_NAME;

  if (CALL_MODE === 'scripted') {
    console.log('[TWIML] Serving scripted TwiML flow');
    res.type('text/xml').send(buildScriptedTwiml(customerName, clientName, getActiveClientId()));
    return;
  }

  const streamUrl = `${toWssUrl(PUBLIC_BASE_URL, '/call/stream')}?clientId=${encodeURIComponent(String(getActiveClientId()))}`;
  console.log(`[TWIML] Serving TwiML with stream URL: ${streamUrl}`);
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${xmlEscape(streamUrl)}">
      <Parameter name="customerName" value="${xmlEscape(customerName)}" />
      <Parameter name="clientName" value="${xmlEscape(clientName)}" />
      <Parameter name="customerId" value="${xmlEscape(req.query.customerId || '')}" />
      <Parameter name="clientId" value="${xmlEscape(String(getActiveClientId()))}" />
    </Stream>
  </Connect>
</Response>`;

  res.type('text/xml').send(twiml);
});

app.post('/call/scripted/consent', twilioHttpValidation, providerClientContext, (req, res) => {
  console.log(`[SCRIPTED] Consent lang=${req.query.lang || 'hi'} digits=${req.body.Digits || ''} speech=${req.body.SpeechResult || ''}`);
  res.type('text/xml').send(buildScriptedConsentResponse(req));
});

app.post('/call/scripted/language', twilioHttpValidation, providerClientContext, (req, res) => {
  console.log(`[SCRIPTED] Language digits=${req.body.Digits || ''} speech=${req.body.SpeechResult || ''}`);
  res.type('text/xml').send(buildScriptedLanguageResponse(req));
});

app.post('/call/scripted/rating', twilioHttpValidation, providerClientContext, (req, res) => {
  res.type('text/xml').send(buildScriptedRatingResponse(req));
});

app.post('/call/status', twilioHttpValidation, providerClientContext, async (req, res) => {
  try {
    console.log(`[CALL STATUS] ${req.body.CallStatus} | SID: ${req.body.CallSid}`);

    const callRecord = await getRepositories().calls.findByTwilioSid(getActiveClientId(), req.body.CallSid);
    const customerId = req.query.customerId || callRecord?.customer_id;

    if (callRecord) {
      let mappedOutcome = null;
      if (req.body.CallStatus === 'completed') mappedOutcome = 'completed';
      if (req.body.CallStatus === 'no-answer') mappedOutcome = 'no_answer';
      if (req.body.CallStatus === 'failed') mappedOutcome = 'failed';
      if (req.body.CallStatus === 'busy') mappedOutcome = 'busy';

      if (mappedOutcome) {
        await getRepositories().calls.update(getActiveClientId(), callRecord.id, {
          outcome: mappedOutcome,
          outcome_detail: req.body.CallStatus
        });
      }

      if (customerId) {
        const customer = await getCustomersRepository().findById(getActiveClientId(), customerId);
        if (customer && mappedOutcome) {
          await applyCallOutcomeWorkflow({
            repositories: getRepositories(),
            clientId: getActiveClientId(),
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

app.post('/call/recording-status', twilioHttpValidation, providerClientContext, async (req, res) => {
  try {
    const callSid = req.body.CallSid;
    const recordingSid = req.body.RecordingSid;
    const recordingStatus = req.body.RecordingStatus;
    const recordingUrl = req.body.RecordingUrl ? `${req.body.RecordingUrl}.mp3` : null;

    console.log(`[RECORDING STATUS] ${recordingStatus} | Call SID: ${callSid} | Recording SID: ${recordingSid}`);

    const callRecord = await getRepositories().calls.findByTwilioSid(getActiveClientId(), callSid);
    if (callRecord) {
      await getRepositories().calls.update(getActiveClientId(), callRecord.id, {
        recording_sid: recordingSid || null,
        recording_url: recordingUrl,
        recording_status: recordingStatus || null
      });

      if (recordingStatus === 'completed' && recordingUrl) {
        setTimeout(() => {
          processCompletedCallPipeline({
            repositories: getRepositories(),
            clientId: getActiveClientId(),
            callSid
          }).then((result) => {
            if (result.ok) {
              console.log(`[POST CALL PIPELINE] Processed call ${callSid} with feedback ${result.feedbackId}`);
            } else {
              console.log(`[POST CALL PIPELINE] Skipped call ${callSid}: ${result.reason}`);
            }
          }).catch((error) => {
            console.error('[POST CALL PIPELINE ERROR]', error.message);
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
    let customer = await getCustomersRepository().findById(getActiveClientId(), req.params.customerId);
    if (!customer) {
      return res.status(404).json({ error: 'Customer not found' });
    }

    customer = await hydratePreCallIntelligence(customer);
    const blockedReason = shouldBlockCustomerCall(customer);
    if (blockedReason) {
      return res.status(409).json({ error: blockedReason });
    }

    const call = await placeRealtimeCall({
      customerPhone: customer.phone,
      customerName: customer.name,
      customerId: customer.id,
      clientName: CLIENT_NAME
    });

    const callRecord = await getRepositories().calls.createAndMarkCustomer(getActiveClientId(), {
      customer_id: customer.id,
      outcome: 'initiated',
      twilio_sid: call.sid,
      called_at: new Date().toISOString(),
      hot_lead_score: customer.priority_score || computePriorityScore(customer),
      consent_message_played: true,
      call_script_version: 'hindi-feedback-v1',
      supervisor_alert_level: 'normal',
      customer_status: 'called'
    });

    res.json({ message: 'Call initiated', callId: callRecord.id, sid: call.sid });
  } catch (error) {
    console.error('[API CALL INITIATE ERROR]', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/calls/recent', async (req, res) => {
  try {
    const rows = await getRepositories().calls.listRecent(getActiveClientId(), { limit: 25 });

    res.json(rows);
  } catch (error) {
    console.error('[RECENT CALLS ERROR]', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/calls/live', async (req, res) => {
  try {
    const rows = [...liveCallState.values()].sort((a, b) => new Date(b.started_at || 0) - new Date(a.started_at || 0));
    res.json(rows);
  } catch (error) {
    console.error('[LIVE CALLS ERROR]', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/calls/:callId/supervisor-events', async (req, res) => {
  try {
    const rows = await getRepositories().supervisorEvents.listForCall(
      getActiveClientId(),
      req.params.callId,
      { limit: 50 }
    );
    res.json(rows);
  } catch (error) {
    console.error('[SUPERVISOR EVENTS ERROR]', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/calls/:callId/escalate', async (req, res) => {
  try {
    await getRepositories().calls.update(getActiveClientId(), req.params.callId, {
      human_escalation_requested: true,
      supervisor_alert_level: 'critical',
      supervisor_notes: String(req.body.note || 'Manual escalation requested').trim()
    });
    await createSupervisorEvent({
      repositories: getRepositories(),
      clientId: getActiveClientId(),
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
    const call = await getRepositories().calls.findById(getActiveClientId(), req.params.callId);

    if (!call?.recording_url) {
      return res.status(404).json({ error: 'Recording not available yet' });
    }

    const authHeader = `Basic ${Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64')}`;
    const response = await fetch(call.recording_url, {
      headers: {
        Authorization: authHeader
      }
    });

    if (!response.ok) {
      return res.status(response.status).json({ error: `Unable to fetch recording (${response.status})` });
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
    const call = await getRepositories().calls.findByIdWithCustomer(getActiveClientId(), req.params.callId);

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
        <a class="btn primary" href="${process.env.NGROK_URL || ''}/admin.html">Open Dashboard</a>
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
const wss = new WebSocket.Server({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const requestUrl = new URL(req.url, PUBLIC_BASE_URL);
  if (requestUrl.pathname !== '/call/stream' || !twilioUpgradeValidation(req)) {
    socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  const clientId = Number(requestUrl.searchParams.get('clientId'));
  getRepositories().clients.findById(clientId).then((client) => {
    if (!Number.isSafeInteger(clientId) || !client || client.status !== 'active') {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (websocket) => {
      runWithClient(clientId, () => wss.emit('connection', websocket, req));
    });
  }).catch(() => socket.destroy());
});

wss.on('connection', (twilioWs, req) => {
  console.log('[STREAM] Twilio Media Stream connected');
  console.log(`[STREAM] Upgrade request from ${req.socket.remoteAddress || 'unknown'}`);

  let aiWs;
  let streamSid;
  let transcriptPrinted = false;
  const transcript = [];
  let geminiSetupComplete = false;
  let aiSessionStarting = false;
  let activeCustomerName = process.env.CUSTOMER_NAME || 'Customer';
  let activeClientName = CLIENT_NAME;
  let activeCustomerId = null;
  let activeCallSid = null;
  let activeCallId = null;
  let transcriptPersisted = false;

  const getActiveSystemPrompt = () => buildAgentSystemPrompt(activeClientName, activeCustomerName);
  const getActiveOpeningPrompt = () => buildOpeningPrompt(activeClientName, activeCustomerName);

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
        repositories: getRepositories(),
        clientId: getActiveClientId(),
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
      status: 'active'
    };

    liveCallState.set(activeCallSid, {
      ...current,
      ...partial,
      customer_name: activeCustomerName,
      customer_id: activeCustomerId,
      call_id: activeCallId,
      transcript_preview: transcript.slice(-4).map((turn) => `[${turn.role}] ${turn.text}`).join('\n')
    });

    if (activeCallId) {
      const nextState = liveCallState.get(activeCallSid);
      await getRepositories().calls.update(getActiveClientId(), activeCallId, {
        live_sentiment_score: nextState.live_sentiment_score || 0,
        live_sentiment_label: nextState.live_sentiment_label || 'neutral',
        live_red_flag: Boolean(nextState.red_flag),
        supervisor_alert_level: nextState.red_flag ? 'high' : 'normal',
        human_escalation_requested: Boolean(nextState.escalation_requested)
      });
    }
  }

  function sendAudioToTwilio(base64Payload) {
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

      if (usesGeminiRealtimeTextInput(REALTIME_MODEL)) {
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
    aiWs = new WebSocket(`wss://api.openai.com/v1/realtime?model=${encodeURIComponent(REALTIME_MODEL)}`, {
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
              format: { type: 'audio/pcmu' },
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
              format: { type: 'audio/pcmu' },
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
          model: REALTIME_MODEL,
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

          if (usesGeminiRealtimeTextInput(REALTIME_MODEL)) {
            aiWs.send(JSON.stringify({
              realtimeInput: {
                text: getActiveOpeningPrompt()
              }
            }));
          } else {
            aiWs.send(JSON.stringify({
              clientContent: {
                turns: [
                  {
                    role: 'user',
                    parts: [
                      {
                        text: getActiveOpeningPrompt()
                      }
                    ]
                  }
                ],
                turnComplete: true
              }
            }));
          }
          return;
        }

        if (message.serverContent?.inputTranscription?.text) {
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
              repositories: getRepositories(),
              clientId: getActiveClientId(),
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
        }

        const parts = message.serverContent?.modelTurn?.parts || [];
        for (const part of parts) {
          if (!part.inlineData?.data || !String(part.inlineData.mimeType || '').startsWith('audio/pcm')) {
            continue;
          }

          const pcm16 = Buffer.from(part.inlineData.data, 'base64');
          const sourceRate = parsePcmRate(part.inlineData.mimeType, 24000);
          const resampled = resamplePcm16(pcm16, sourceRate, 8000);
          const mulaw = encodeMuLawFromPcm16(resampled).toString('base64');
          sendAudioToTwilio(mulaw);
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
        sendAudioToTwilio(message.delta);
        return;
      }

      if (message.type === 'response.output_audio_transcript.done') {
        pushTranscriptTurn(transcript, 'AGENT', message.transcript);
        console.log(`[AGENT]: ${message.transcript}`);
        refreshLiveCallState({}).catch(() => {});
        return;
      }

      if (message.type === 'conversation.item.input_audio_transcription.completed') {
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
      console.error('[STREAM] Failed to parse Twilio message:', error.message);
      return;
    }

    if (message.event === 'start') {
      streamSid = message.start.streamSid;
      const customParameters = message.start.customParameters || {};
      activeCustomerName = customParameters.customerName || activeCustomerName;
      activeClientName = customParameters.clientName || activeClientName;
      activeCustomerId = customParameters.customerId ? Number(customParameters.customerId) : null;
      activeCallSid = message.start.callSid || activeCallSid;
      if (activeCallSid) {
        const callRow = await getRepositories().calls.findByTwilioSid(getActiveClientId(), activeCallSid);
        activeCallId = callRow?.id || null;
      }
      console.log(`[STREAM] streamSid: ${streamSid}`);
      console.log(`[STREAM] Start payload: ${JSON.stringify(message.start)}`);
      console.log(`[STREAM] Active customer=${activeCustomerName} client=${activeClientName}`);
      await refreshLiveCallState({ status: 'active', started_at: new Date().toISOString() });
      ensureAiSession();
      return;
    }

    if (message.event === 'media' && aiWs?.readyState === WebSocket.OPEN) {
      if (AI_PROVIDER === 'gemini') {
        if (!geminiSetupComplete) {
          return;
        }

        const pcm16 = decodeMuLaw(message.media.payload);
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
        audio: message.media.payload
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
    console.log('[STREAM] Twilio WS closed');
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

let schedulerTimer;
let shutdownPromise;

async function stopScheduler() {
  if (schedulerTimer) clearInterval(schedulerTimer);
  schedulerTimer = undefined;
}

async function handleShutdown(signal) {
  if (shutdownPromise) return shutdownPromise;
  logger.info('runtime_signal_received', { signal });
  shutdownPromise = shutdownRuntime({ stopScheduler, server, postgres, logger });
  return shutdownPromise;
}

process.once('SIGTERM', () => handleShutdown('SIGTERM').then(() => { process.exitCode = 0; }).catch(() => { process.exitCode = 1; }));
process.once('SIGINT', () => handleShutdown('SIGINT').then(() => { process.exitCode = 0; }).catch(() => { process.exitCode = 1; }));

(async () => {
  try {
    validateConfig();
    await initializeDatabase();
    await initializeCustomerPersistence();

    schedulerTimer = setInterval(() => {
      runSchedulerTick().catch((error) => {
        console.error('[SCHEDULER ERROR]', error.message);
      });
    }, 15000);

    runSchedulerTick().catch((error) => {
      console.error('[SCHEDULER ERROR]', error.message);
    });

    server.listen(PORT, () => {
      console.log(`[SERVER] Running on http://localhost:${PORT}`);
      console.log(`[SERVER] Public base URL: ${PUBLIC_BASE_URL}`);
      console.log(`[SERVER] Call mode: ${CALL_MODE}`);
      console.log(`[SERVER] Realtime model: ${REALTIME_MODEL}`);
      console.log('[SERVER] Scheduler active: checks pending customers every 15 seconds');
      console.log('[SERVER] Admin UI: http://localhost:3000/admin.html');
      console.log('[SERVER] Ready. Trigger a call with: curl -X POST http://localhost:3000/call/start');
    });
  } catch (error) {
    console.error('[CONFIG ERROR]', error.message);
    process.exit(1);
  }
})();
