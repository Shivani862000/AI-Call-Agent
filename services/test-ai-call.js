const { dbRun, dbGet } = require('../db');
const { extractCallFeedback } = require('./call-feedback');
const { categorizeFeedback } = require('./openai');

const sessions = new Map();
const SOURCE = 'test_ai_call';
const DEFAULT_CLIENT_NAME = process.env.CLIENT_NAME || 'KC Prashant Path Lab';
const TEXT_MODEL = process.env.TEST_CALL_GEMINI_MODEL || process.env.GEMINI_TEXT_MODEL || 'gemini-2.5-flash';
const BROWSER_TEST_CALLER = 'Browser Test Caller';
const OPENING_LINE = 'Namaste, main KC Prashant Path Lab se AI assistant bol rahi hoon. Main aapse aapke recent lab visit ka feedback lena chahti hoon. Kya main 1 minute le sakti hoon?';

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

function buildBrowserFeedbackPrompt(clientName = DEFAULT_CLIENT_NAME) {
  return `
You are Priya, a premium AI receptionist for ${clientName}.
This is a browser-based AI voice call test for the admin dashboard.

Conversation rules:
- Speak naturally in Hindi/Hinglish.
- Ask one short question at a time.
- Do not ask for patient name, phone number, address, or medical details.
- Start by asking permission for quick feedback.
- If the user agrees, ask naturally about visit experience, staff behavior, lab cleanliness, overall rating from 1 to 5, and improvement suggestions.
- If the user refuses, politely thank them and close.
- Keep responses under 35 words.
- When the feedback is complete, close the call politely.
`.trim();
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

  if (agent?.system_prompt) {
    return {
      prompt: `${applyAgentTemplate(agent.system_prompt, {
        client_name: clientName,
        customer_name: BROWSER_TEST_CALLER,
        language: agent.language || 'hi',
        agent_name: agent.name || 'Priya'
      })}

Browser test-call override:
- Do not ask for name or phone number.
- Use the Path Lab feedback flow.
- Ask one short voice-call question at a time.`,
      agentId: agent.id,
      clientName,
      promptSource: 'agent_system_prompt'
    };
  }

  return {
    prompt: buildBrowserFeedbackPrompt(clientName),
    agentId: agent?.id || null,
    clientName,
    promptSource: 'browser_feedback_fallback'
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

function buildGeminiContents(session, userText) {
  const contents = session.transcript.map((turn) => ({
    role: turn.role === 'AGENT' ? 'model' : 'user',
    parts: [{ text: turn.text }]
  }));

  if (userText) {
    contents.push({ role: 'user', parts: [{ text: userText }] });
  }

  return contents;
}

function extractGeminiText(payload) {
  const candidates = Array.isArray(payload?.candidates) ? payload.candidates : [];
  return candidates
    .flatMap((candidate) => Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [])
    .map((part) => typeof part?.text === 'string' ? part.text : '')
    .join('')
    .trim();
}

async function generateLlmReply(session, userText) {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY is not configured');
  }

  const nextQuestion = QUESTION_PLAN[Math.min(session.step, QUESTION_PLAN.length - 1)];
  const modelPath = encodeURIComponent(String(TEXT_MODEL).replace(/^models\//, ''));
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${modelPath}:generateContent?key=${encodeURIComponent(process.env.GEMINI_API_KEY)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: {
        parts: [{
          text: `${session.systemPrompt}

Current required topic: ${nextQuestion?.key || 'closing'}.
If the previous user answer completed the current topic, ask the next topic naturally.
Never ask for typed input, name, or phone number.`
        }]
      },
      generationConfig: {
        temperature: 0.35,
        maxOutputTokens: 120
      },
      contents: buildGeminiContents(session, userText)
    })
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new Error(`Gemini request failed (${response.status}): ${errorText || response.statusText}`);
  }

  const payload = await response.json();
  const text = extractGeminiText(payload);
  if (!text) {
    throw new Error('Gemini returned an empty response');
  }

  return text;
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
    `INSERT INTO customers (name, phone, preferred_slot, status, created_at)
     VALUES (?, ?, ?, ?, ?)`,
    [BROWSER_TEST_CALLER, phone, 'browser', 'completed', new Date().toISOString()]
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
    transcript: [{ role: 'AGENT', text: OPENING_LINE, at: now }],
    createdAt: now,
    summary: null
  };

  sessions.set(session.id, session);
  console.log(`[TEST AI CALL] started session=${session.id} callId=${session.callId} prompt=${session.promptSource}`);
  return serialize(session, { aiResponse: OPENING_LINE });
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
  OPENING_LINE,
  startBrowserTestCall,
  handleUserMessage,
  endBrowserTestCall,
  _test: {
    buildBrowserFeedbackPrompt,
    buildSummary
  }
};
