require('dotenv').config();

const express = require('express');
const http = require('http');
const path = require('path');
const WebSocket = require('ws');
const twilio = require('twilio');
const { initializeDatabase, dbRun, dbGet, dbAll } = require('./db');
const customersRouter = require('./routes/customers');
const feedbackRouter = require('./routes/feedback');
const reportsRouter = require('./routes/reports');

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = Number(process.env.PORT || 3000);
const CALL_MODE = process.env.CALL_MODE || (process.env.OPENAI_API_KEY ? 'openai' : 'scripted');
const AI_PROVIDER = CALL_MODE === 'gemini' ? 'gemini' : 'openai';
const OPENAI_REALTIME_MODEL = process.env.OPENAI_REALTIME_MODEL || 'gpt-realtime';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'models/gemini-3.1-flash-live-preview';
const GEMINI_VOICE = process.env.GEMINI_VOICE || 'Kore';
const REALTIME_MODEL = AI_PROVIDER === 'gemini' ? GEMINI_MODEL : OPENAI_REALTIME_MODEL;
const CLIENT_NAME = process.env.CLIENT_NAME || 'your diagnostic and medical collection center';
const PUBLIC_BASE_URL = (process.env.NGROK_URL || process.env.WEBHOOK_URL || '').replace(/\/$/, '');
const GEMINI_WS_URL = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';

const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

function buildAgentSystemPrompt(clientName, customerName) {
  return `
You are Priya, a warm and professional customer feedback agent calling on behalf of ${clientName},
a diagnostic and medical collection center.

Your job is to have a friendly, natural phone conversation to collect honest feedback
about the customer's recent visit. Start in simple Hindi by default.
At the beginning of the call, ask whether they would prefer to continue in Hindi or English.
If the customer responds in Hindi or mixes languages, match their style naturally.
If they ask for English, switch to simple English.

CONVERSATION FLOW — follow this order, but keep it conversational, not robotic:

1. GREETING & INTRODUCTION
Introduce yourself, mention you are calling from ${clientName},
confirm you are speaking with the right person by name.
First ask whether they would like to continue in Hindi or English.
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
- Start the call with this structure: greet the customer in Hindi, say your name is Priya, say you are calling from ${clientName}, confirm you are speaking with ${customerName}, ask whether they want to continue in Hindi or English, then ask if they have 2-3 minutes for feedback.
- Do not skip the introduction.
- Do not sound like a bot, assistant, or AI system.
- Do not jump to random topics or generic small talk.
- Ask only one main question at a time.
`.trim();
}

function buildOpeningPrompt(clientName, customerName) {
  return [
    `Start the phone call now as Priya from ${clientName}.`,
    `The customer name is ${customerName}.`,
    `Your first spoken turn should closely follow this wording: "Hello, am I speaking with ${customerName}? This is Priya calling from ${clientName}. I am calling to quickly collect feedback about your recent visit. Do you have 2 to 3 minutes?"`,
    'After that, continue the conversation naturally using the feedback flow in the system instructions.',
    'Keep every reply short, warm, and phone-friendly.'
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
    intro: `Namaste. Kya main ${customerName} se baat kar rahi hoon? Main Priya bol rahi hoon, ${clientName} se. Hindi mein baat karne ke liye Hindi boliye ya 1 dabaiye. To continue in English, say English or press 2.`,
    noLanguageResponse: 'Humein aapka jawab nahin mila. Dhanyavaad. Namaste.',
    consent: `Dhanyavaad. Main Hindi mein baat karti hoon. Kya aapke paas aapki recent visit ke feedback ke liye 2 se 3 minute hain? Haan boliye ya 1 dabaiye.`,
    decline: 'Koi baat nahin. Aapke samay ke liye dhanyavaad. Namaste.',
    noConsentResponse: 'Humein aapka jawab nahin mila. Dhanyavaad. Namaste.',
    rating: 'Dhanyavaad. Hamare collection center mein aapka overall experience kaisa tha? 1 se 5 tak rating dijiye, jahan 5 excellent hai. Number boliye ya key dabaiye.',
    noRatingResponse: 'Humein aapki rating nahin mili. Dhanyavaad. Namaste.',
    closing: 'Aapke feedback ke liye dhanyavaad. Aapki rai hamari service improve karne mein madad karegi. Agar aap chahein to hum WhatsApp par ek review link bhi bhej sakte hain. Namaste.'
  };
}

function buildScriptedTwiml(customerName, clientName) {
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
    action: `/call/scripted/language?customerName=${encodedCustomerName}&clientName=${encodedClientName}`,
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
    action: `/call/scripted/consent?lang=${language}&customerName=${encodedCustomerName}&clientName=${encodedClientName}`,
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
    twiml.say({ language: language === 'en' ? 'en-IN' : 'hi-IN' }, copy.decline);
    twiml.hangup();
    return twiml.toString();
  }

  const gather = twiml.gather({
    input: 'speech dtmf',
    numDigits: 1,
    timeout: 7,
    speechTimeout: 'auto',
    language: language === 'en' ? 'en-IN' : 'hi-IN',
    actionOnEmptyResult: true,
    action: `/call/scripted/rating?lang=${language}&customerName=${encodedCustomerName}&clientName=${encodedClientName}`,
    method: 'POST'
  });

  gather.say({ language: language === 'en' ? 'en-IN' : 'hi-IN' }, copy.rating);

  twiml.say({ language: language === 'en' ? 'en-IN' : 'hi-IN' }, copy.noRatingResponse);
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

  twiml.say({ language: language === 'en' ? 'en-IN' : 'hi-IN' }, copy.closing);
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

  const twimlUrl = `${PUBLIC_BASE_URL}/call/twiml?customerName=${safeCustomerName}&clientName=${safeClientName}${safeCustomerId}`;
  const statusUrl = `${PUBLIC_BASE_URL}/call/status${customerId ? `?customerId=${encodeURIComponent(String(customerId))}` : ''}`;

  return twilioClient.calls.create({
    to: customerPhone,
    from: process.env.TWILIO_PHONE_NUMBER,
    url: twimlUrl,
    method: 'GET',
    statusCallback: statusUrl,
    statusCallbackMethod: 'POST'
  });
}

async function triggerScheduledCalls() {
  const now = new Date();
  const currentSlot = now.toTimeString().slice(0, 5);

  const dueCustomers = await dbAll(
    `SELECT c.*
     FROM customers c
     LEFT JOIN calls call_today
       ON call_today.customer_id = c.id
      AND DATE(call_today.called_at) = DATE('now', 'localtime')
     WHERE c.status = 'pending'
       AND c.preferred_slot = ?
       AND call_today.id IS NULL`,
    [currentSlot]
  );

  if (!dueCustomers.length) {
    return;
  }

  console.log(`[SCHEDULER] Found ${dueCustomers.length} customer(s) due at ${currentSlot}`);

  for (const customer of dueCustomers) {
    try {
      const call = await placeRealtimeCall({
        customerPhone: customer.phone,
        customerName: customer.name,
        customerId: customer.id,
        clientName: CLIENT_NAME
      });

      await dbRun(
        'INSERT INTO calls (customer_id, outcome, twilio_sid, called_at) VALUES (?, ?, ?, ?)',
        [customer.id, 'scheduled_initiated', call.sid, new Date().toISOString()]
      );
      await dbRun('UPDATE customers SET status = ? WHERE id = ?', ['called', customer.id]);
      console.log(`[SCHEDULER] Scheduled call started for ${customer.name} (${call.sid})`);
    } catch (error) {
      console.error(`[SCHEDULER] Failed to call ${customer.name}:`, error.message);
      if (error.code === 21219) {
        await dbRun(
          'INSERT INTO calls (customer_id, outcome, called_at) VALUES (?, ?, ?)',
          [customer.id, 'twilio_unverified', new Date().toISOString()]
        );
        await dbRun('UPDATE customers SET status = ? WHERE id = ?', ['twilio_trial_blocked', customer.id]);
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

  transcript.push({
    role,
    text: String(text).trim(),
    time: new Date().toISOString()
  });
}

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    mode: CALL_MODE,
    model: REALTIME_MODEL,
    publicBaseUrl: PUBLIC_BASE_URL,
    timestamp: new Date().toISOString()
  });
});

app.get('/', (req, res) => {
  res.redirect('/admin.html');
});

app.use('/api/customers', customersRouter);
app.use('/api/feedback', feedbackRouter);
app.use('/api/reports', reportsRouter);

app.post('/call/start', async (req, res) => {
  try {
    const customerPhone = req.body.customerPhone || process.env.CUSTOMER_PHONE;
    const customerName = req.body.customerName || process.env.CUSTOMER_NAME;
    const customerId = req.body.customerId;
    const clientName = req.body.clientName || CLIENT_NAME;

    console.log(`[CALL REQUEST] to=${customerPhone} from=${process.env.TWILIO_PHONE_NUMBER} twiml=${PUBLIC_BASE_URL}/call/twiml`);
    const call = await placeRealtimeCall({ customerPhone, customerName, customerId, clientName });

    console.log(`[CALL STARTED] SID: ${call.sid}`);
    res.json({ success: true, sid: call.sid });
  } catch (error) {
    console.error('[ERROR starting call]', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/call/twiml', (req, res) => {
  const customerName = req.query.customerName || process.env.CUSTOMER_NAME;
  const clientName = req.query.clientName || CLIENT_NAME;

  if (CALL_MODE === 'scripted') {
    console.log('[TWIML] Serving scripted TwiML flow');
    res.type('text/xml').send(buildScriptedTwiml(customerName, clientName));
    return;
  }

  const streamUrl = toWssUrl(PUBLIC_BASE_URL, '/call/stream');
  console.log(`[TWIML] Serving TwiML with stream URL: ${streamUrl}`);
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${xmlEscape(streamUrl)}">
      <Parameter name="customerName" value="${xmlEscape(customerName)}" />
      <Parameter name="clientName" value="${xmlEscape(clientName)}" />
      <Parameter name="customerId" value="${xmlEscape(req.query.customerId || '')}" />
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

app.post('/call/status', async (req, res) => {
  try {
    console.log(`[CALL STATUS] ${req.body.CallStatus} | SID: ${req.body.CallSid}`);

    const callRecord = await dbGet('SELECT * FROM calls WHERE twilio_sid = ?', [req.body.CallSid]);
    const customerId = req.query.customerId || callRecord?.customer_id;

    if (callRecord && req.body.CallStatus === 'completed' && !callRecord.outcome) {
      await dbRun('UPDATE calls SET outcome = ? WHERE id = ?', ['completed', callRecord.id]);
    }

    if (callRecord && (req.body.CallStatus === 'no-answer' || req.body.CallStatus === 'failed' || req.body.CallStatus === 'busy')) {
      await dbRun('UPDATE calls SET outcome = ? WHERE id = ?', ['no_answer', callRecord.id]);
    }

    if (customerId && req.body.CallStatus === 'no-answer') {
      await dbRun('UPDATE customers SET status = ? WHERE id = ?', ['no_answer', customerId]);
    } else if (customerId && req.body.CallStatus === 'completed') {
      await dbRun('UPDATE customers SET status = ? WHERE id = ?', ['completed', customerId]);
    } else if (customerId && req.body.CallStatus === 'busy') {
      await dbRun('UPDATE customers SET status = ? WHERE id = ?', ['busy', customerId]);
    }

    res.sendStatus(200);
  } catch (error) {
    console.error('[CALL STATUS ERROR]', error.message);
    res.sendStatus(500);
  }
});

app.post('/api/calls/initiate/:customerId', async (req, res) => {
  try {
    const customer = await dbGet('SELECT * FROM customers WHERE id = ?', [req.params.customerId]);
    if (!customer) {
      return res.status(404).json({ error: 'Customer not found' });
    }

    const call = await placeRealtimeCall({
      customerPhone: customer.phone,
      customerName: customer.name,
      customerId: customer.id,
      clientName: CLIENT_NAME
    });

    const result = await dbRun(
      'INSERT INTO calls (customer_id, outcome, twilio_sid, called_at) VALUES (?, ?, ?, ?)',
      [customer.id, 'initiated', call.sid, new Date().toISOString()]
    );

    await dbRun('UPDATE customers SET status = ? WHERE id = ?', ['called', customer.id]);
    res.json({ message: 'Call initiated', callId: result.lastID, sid: call.sid });
  } catch (error) {
    console.error('[API CALL INITIATE ERROR]', error.message);
    res.status(500).json({ error: error.message });
  }
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/call/stream' });

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

  const getActiveSystemPrompt = () => buildAgentSystemPrompt(activeClientName, activeCustomerName);
  const getActiveOpeningPrompt = () => buildOpeningPrompt(activeClientName, activeCustomerName);

  const printTranscriptOnce = () => {
    if (!transcriptPrinted) {
      transcriptPrinted = true;
      printTranscript(transcript);
    }
  };

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
                text: `${getActiveSystemPrompt()}\n\n${getActiveOpeningPrompt()}`
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
        }

        if (message.serverContent?.outputTranscription?.text) {
          pushTranscriptTurn(transcript, 'AGENT', message.serverContent.outputTranscription.text);
          console.log(`[AGENT]: ${message.serverContent.outputTranscription.text}`);
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
        return;
      }

      if (message.type === 'conversation.item.input_audio_transcription.completed') {
        pushTranscriptTurn(transcript, 'CUSTOMER', message.transcript);
        console.log(`[CUSTOMER]: ${message.transcript}`);
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

  twilioWs.on('message', (raw) => {
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
      console.log(`[STREAM] streamSid: ${streamSid}`);
      console.log(`[STREAM] Start payload: ${JSON.stringify(message.start)}`);
      console.log(`[STREAM] Active customer=${activeCustomerName} client=${activeClientName}`);
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

    if (message.event === 'stop') {
      console.log('[STREAM] Call ended');
      printTranscriptOnce();

      if (aiWs?.readyState === WebSocket.OPEN) {
        aiWs.close();
      }
    }
  });

  twilioWs.on('close', () => {
    console.log('[STREAM] Twilio WS closed');
    printTranscriptOnce();

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

    setInterval(() => {
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
