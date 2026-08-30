const { dbRun, dbGet } = require('../db');
const { extractCallFeedback } = require('./call-feedback');
const { categorizeFeedback, generateGeminiReply } = require('./gemini');
const { buildAgentSystemPrompt, buildOpeningPrompt } = require('../src/prompt-builder');

const sessions = new Map();
const SOURCE = 'test_ai_call';
const DEFAULT_CLIENT_NAME = process.env.CLIENT_NAME || 'KC Prashant Path Lab';
const BROWSER_TEST_CALLER = 'Browser Test Caller';

const QUESTION_PLAN = [
  {
    key: 'visit_experience',
    prompt: 'Aapka visit experience kaisa raha?'
  },
  {
    key: 'staff_behavior',
    prompt: 'Staff behavior kaisa tha?'
  },
  {
    key: 'cleanliness',
    prompt: 'Lab cleanliness kaisi lagi?'
  },
  {
    key: 'rating',
    prompt: 'Overall rating 1 se 5 ke beech kya denge?'
  },
  {
    key: 'improvement',
    prompt: 'Koi suggestion ya improvement batana chahenge?'
  }
];

function normalizeText(value) {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

function applyAgentTemplate(template, values) {
  return String(template || '').replace(/\{\{\s*(client_name|customer_name|language|agent_name)\s*\}\}/g, (match, key) => values[key] || '');
}

async function getOutboundPrompt() {
  const agent = await dbGet(
    `SELECT *
       FROM agents
      WHERE is_active = 1
      ORDER BY is_default DESC, id ASC
      LIMIT 1`
  );
  const clientName = agent?.client_name || DEFAULT_CLIENT_NAME;

  const systemPrompt = buildAgentSystemPrompt(clientName, BROWSER_TEST_CALLER, agent, 'review_call');
  const openingLine = buildOpeningPrompt(clientName, BROWSER_TEST_CALLER, agent, 'review_call');

  return {
    prompt: `${systemPrompt}

Browser test-call override:
- Do not ask for name or phone number.
- Ask one short voice-call question at a time.`,
    openingLine,
    agentId: agent?.id || null,
    clientName,
    promptSource: 'prompt-builder'
  };
}

function toPlainTranscript(transcript) {
  return transcript.map((turn) => `${turn.role}: ${turn.text}`).join('\n');
}

function serialize(session, extra = {}) {
  return {
    sessionId: session.id,
    callId: session.callId,
    status: session.status,
    transcript: session.transcript,
    summary: session.summary || null,
    ...extra
  };
}

async function generateLlmReply(session, userText) {
  return generateGeminiReply({
    systemPrompt: session.systemPrompt,
    transcript: session.transcript,
    userText
  });
}

function scriptedReply(session) {
  if (session.step < QUESTION_PLAN.length) {
    const text = QUESTION_PLAN[session.step].prompt;
    session.step += 1;
    return text;
  }

  session.step += 1;
  return 'Dhanyavaad. Aapka feedback capture ho gaya hai. Hum ise lab team ke saath share karenge.';
}

async function getOrCreateBrowserTestCustomer() {
  const phone = `browser-test-${Date.now()}`;
  const result = await dbRun(
    `INSERT INTO customers (patient_id, name, phone, normalized_phone, preferred_slot, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [await require('../src/patient-link').resolvePatientId({ name: BROWSER_TEST_CALLER, phone }),
     BROWSER_TEST_CALLER, phone, null, 'browser', 'completed', new Date().toISOString()]
  );
  return result.lastID;
}

function buildSummary(transcript) {
  const extraction = extractCallFeedback(transcript);
  const fallbackCustomerText = transcript
    .filter((turn) => turn.role === 'CUSTOMER')
    .map((turn) => normalizeText(turn.text))
    .filter(Boolean)
    .slice(-4)
    .join(' ');
  const reviewText = extraction.reviewText || fallbackCustomerText || 'Browser test call ended with limited feedback.';
  const stars = Number.isInteger(extraction.stars) ? extraction.stars : null;
  return {
    reviewText,
    stars,
    sentiment: stars >= 4 ? 'positive' : stars && stars <= 2 ? 'negative' : 'neutral',
    turns: transcript.length
  };
}

async function startBrowserTestCall() {
  const promptConfig = await getOutboundPrompt();
  const customerId = await getOrCreateBrowserTestCustomer();
  const providerCallId = `test-ai-call-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();

  const callResult = await dbRun(
    `INSERT INTO calls (
       customer_id, called_at, outcome, provider_call_id, call_direction, call_source,
       transcript_status, analysis_status, call_script_version, agent_id, notes
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      customerId,
      now,
      'answered',
      providerCallId,
      'outbound',
      SOURCE,
      'in_progress',
      'pending',
      'browser-voice-test-v1',
      promptConfig.agentId,
      `Browser Test AI Call; prompt_source=${promptConfig.promptSource}`
    ]
  );

  const session = {
    id: providerCallId,
    callId: callResult.lastID,
    customerId,
    status: 'live',
    step: 0,
    systemPrompt: promptConfig.prompt,
    promptSource: promptConfig.promptSource,
    transcript: [{ role: 'AGENT', text: promptConfig.openingLine, at: now }],
    createdAt: now,
    summary: null
  };

  sessions.set(session.id, session);
  console.log(`[TEST AI CALL] started session=${session.id} callId=${session.callId} prompt=${session.promptSource}`);
  return serialize(session, { aiResponse: promptConfig.openingLine });
}

async function handleUserMessage({ sessionId, message }) {
  const session = sessions.get(sessionId);
  if (!session) {
    const error = new Error('Browser test call session not found');
    error.statusCode = 404;
    throw error;
  }
  if (session.status !== 'live') {
    const error = new Error('This browser test call is not live');
    error.statusCode = 409;
    throw error;
  }

  const text = normalizeText(message);
  if (!text) {
    const error = new Error('Speech transcript is required');
    error.statusCode = 400;
    throw error;
  }

  session.transcript.push({ role: 'CUSTOMER', text, at: new Date().toISOString() });

  let aiResponse = '';
  let llmFallback = false;
  try {
    aiResponse = await generateLlmReply(session, text);
    session.step += 1;
  } catch (error) {
    llmFallback = true;
    console.error(`[TEST AI CALL] LLM fallback session=${session.id}: ${error.message}`);
    aiResponse = scriptedReply(session);
  }

  session.transcript.push({ role: 'AGENT', text: aiResponse, at: new Date().toISOString() });

  await dbRun(
    `UPDATE calls
        SET transcript_text = ?,
            transcript_status = ?,
            outcome = ?
      WHERE id = ?`,
    [toPlainTranscript(session.transcript), 'in_progress', 'answered', session.callId]
  );

  return serialize(session, { aiResponse, llmFallback });
}

async function endBrowserTestCall({ sessionId }) {
  const session = sessions.get(sessionId);
  if (!session) {
    const error = new Error('Browser test call session not found');
    error.statusCode = 404;
    throw error;
  }

  session.status = 'completed';
  session.summary = buildSummary(session.transcript);
  const stars = Number.isInteger(session.summary.stars) ? session.summary.stars : 3;
  const categorization = await categorizeFeedback(session.summary.reviewText, stars);
  const now = new Date().toISOString();

  await dbRun(
    `UPDATE calls
        SET transcript_text = ?,
            transcript_status = ?,
            analysis_status = ?,
            extracted_rating = ?,
            extracted_review_text = ?,
            feedback_saved_at = ?,
            outcome = ?,
            ended_at = ?
      WHERE id = ?`,
    [
      toPlainTranscript(session.transcript),
      'completed',
      'completed',
      stars,
      session.summary.reviewText,
      now,
      'completed',
      now,
      session.callId
    ]
  );

  const feedbackResult = await dbRun(
    `INSERT INTO feedback (customer_id, call_id, review_text, category, stars, submitted_at, source)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [session.customerId, session.callId, session.summary.reviewText, categorization.category, stars, now, SOURCE]
  );

  sessions.delete(session.id);
  console.log(`[TEST AI CALL] completed session=${session.id} feedbackId=${feedbackResult.lastID}`);

  return serialize(session, {
    feedbackId: feedbackResult.lastID,
    saved: true
  });
}

module.exports = {
  SOURCE,
  BROWSER_TEST_CALLER,
  QUESTION_PLAN,
  startBrowserTestCall,
  handleUserMessage,
  endBrowserTestCall,
  _test: {
    buildSummary
  }
};
