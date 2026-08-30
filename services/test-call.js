const { dbRun, dbGet } = require('../db');
const { normalizePhoneLookupValue } = require('../src/helpers');
const { resolvePatientId } = require('../src/patient-link');
const { extractCallFeedback } = require('./call-feedback');
const { categorizeFeedback, generateGeminiReply } = require('./gemini');

const sessions = new Map();
const TEST_CALL_SOURCE = 'test_call';
const TEST_CALL_TYPE = 'Test Feedback Call';
const DEFAULT_CLIENT_NAME = process.env.CLIENT_NAME || 'Path Lab';

const QUESTION_PLAN = [
  {
    key: 'visit_experience',
    prompt: 'How was your visit experience at the lab?'
  },
  {
    key: 'staff_behavior',
    prompt: 'How was the staff behavior during your visit?'
  },
  {
    key: 'cleanliness',
    prompt: 'Was the lab clean and comfortable?'
  },
  {
    key: 'rating',
    prompt: 'What overall rating would you give from 1 to 5?'
  },
  {
    key: 'improvement',
    prompt: 'Is there anything we can improve for your next visit?'
  }
];

function normalizeText(value) {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

function validateName(name) {
  const normalized = normalizeText(name);
  if (!normalized) {
    return 'Patient name is required';
  }
  if (normalized.length < 2) {
    return 'Patient name should be at least 2 characters';
  }
  if (normalized.length > 100) {
    return 'Patient name must be 100 characters or fewer';
  }
  return '';
}

function validatePhone(phone) {
  const normalized = normalizeText(phone);
  if (!normalized) {
    return '';
  }
  if (!/^[+\d][\d\s()-]{6,19}$/.test(normalized)) {
    return 'Enter a valid phone number or leave it blank';
  }
  return '';
}

function buildFallbackOutboundFeedbackPrompt(clientName, patientName) {
  return `
You are Priya, a calm and friendly AI receptionist for ${clientName}.
This is an outbound feedback call simulation for ${patientName}.

Use a natural, concise Hindi/Hinglish or English tone based on the patient's language.
Ask one question at a time and do not sound like a form.
Follow this feedback flow:
1. Confirm you are speaking with ${patientName}, then ask for permission to take quick feedback.
2. Ask how their visit experience was.
3. Ask how staff behavior was.
4. Ask whether the lab was clean and comfortable.
5. Ask for an overall rating from 1 to 5.
6. Ask if they have any improvement suggestion.
7. Close politely and thank them.

Rules:
- Keep each assistant message under 35 words.
- Do not invent patient answers.
- Do not ask for sensitive medical information.
- If the patient is upset, acknowledge it and continue gently.
- When all questions are answered, close the call.
`.trim();
}

function applyAgentTemplate(template, values) {
  return String(template || '').replace(/\{\{\s*(client_name|customer_name|language|agent_name)\s*\}\}/g, (match, key) => values[key] || '');
}

async function getOutboundFeedbackPrompt(patientName) {
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
      prompt: applyAgentTemplate(agent.system_prompt, {
        client_name: clientName,
        customer_name: patientName,
        language: agent.language || 'hi',
        agent_name: agent.name || 'Priya'
      }),
      clientName,
      agentId: agent.id,
      promptSource: 'agent_system_prompt'
    };
  }

  return {
    prompt: buildFallbackOutboundFeedbackPrompt(clientName, patientName),
    clientName,
    agentId: agent?.id || null,
    promptSource: 'path_lab_feedback_fallback'
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
    const question = QUESTION_PLAN[session.step].prompt;
    session.step += 1;
    return question;
  }

  session.step += 1;
  return 'Thank you. I have captured your feedback and will share it with the lab team.';
}

async function createCustomerForTestCall(name, phone) {
  const normalizedPhone = normalizeText(phone) || `test-${Date.now()}`;
  const existing = await dbGet('SELECT id FROM customers WHERE phone = ?', [normalizedPhone]);
  if (existing) {
    return existing.id;
  }

  const result = await dbRun(
    `INSERT INTO customers (patient_id, name, phone, normalized_phone, preferred_slot, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (normalized_phone) WHERE normalized_phone IS NOT NULL
     DO UPDATE SET name = excluded.name, patient_id = excluded.patient_id`,
    [await resolvePatientId({ name, phone: normalizedPhone }), name, normalizedPhone,
     normalizePhoneLookupValue(normalizedPhone), 'test', 'completed', new Date().toISOString()]
  );

  return result.lastID;
}

function toPlainTranscript(transcript) {
  return transcript.map((turn) => `${turn.role}: ${turn.text}`).join('\n');
}

async function startTestCall({ patientName, phone }) {
  const nameError = validateName(patientName);
  const phoneError = validatePhone(phone);
  const fieldErrors = {};

  if (nameError) fieldErrors.patientName = nameError;
  if (phoneError) fieldErrors.phone = phoneError;
  if (Object.keys(fieldErrors).length) {
    const error = new Error('Please fix the highlighted fields');
    error.statusCode = 400;
    error.fieldErrors = fieldErrors;
    throw error;
  }

  const name = normalizeText(patientName);
  const normalizedPhone = normalizeText(phone);
  const promptConfig = await getOutboundFeedbackPrompt(name);
  const customerId = await createCustomerForTestCall(name, normalizedPhone);
  const providerCallId = `test-call-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const callResult = await dbRun(
    `INSERT INTO calls (
       customer_id, called_at, outcome, provider_call_id, call_direction, call_source,
       transcript_status, analysis_status, call_script_version, agent_id, notes
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      customerId,
      new Date().toISOString(),
      'initiated',
      providerCallId,
      'outbound',
      TEST_CALL_SOURCE,
      'in_progress',
      'pending',
      'test-feedback-v1',
      promptConfig.agentId,
      `${TEST_CALL_TYPE}; prompt_source=${promptConfig.promptSource}`
    ]
  );

  const session = {
    id: providerCallId,
    callId: callResult.lastID,
    customerId,
    patientName: name,
    phone: normalizedPhone,
    status: 'live',
    step: 1,
    systemPrompt: promptConfig.prompt,
    promptSource: promptConfig.promptSource,
    transcript: [{
      role: 'AGENT',
      text: `Hi ${name}, this is Priya from ${promptConfig.clientName}. I am placing a test feedback call. How was your visit experience at the lab?`,
      at: new Date().toISOString()
    }],
    createdAt: new Date().toISOString()
  };

  sessions.set(session.id, session);
  console.log(`[TEST CALL] started session=${session.id} callId=${session.callId} prompt=${session.promptSource}`);

  return serializeSession(session);
}

function serializeSession(session, extra = {}) {
  return {
    sessionId: session.id,
    callId: session.callId,
    status: session.status,
    callType: TEST_CALL_TYPE,
    transcript: session.transcript,
    ...extra
  };
}

async function sendUserResponse({ sessionId, message }) {
  const session = sessions.get(sessionId);
  if (!session) {
    const error = new Error('Test call session not found');
    error.statusCode = 404;
    throw error;
  }
  if (session.status !== 'live') {
    const error = new Error('This test call is no longer live');
    error.statusCode = 409;
    throw error;
  }

  const text = normalizeText(message);
  if (!text) {
    const error = new Error('Response is required');
    error.statusCode = 400;
    error.fieldErrors = { message: 'Please enter the patient response' };
    throw error;
  }
  if (text.length > 1000) {
    const error = new Error('Response must be 1000 characters or fewer');
    error.statusCode = 400;
    error.fieldErrors = { message: 'Response is too long' };
    throw error;
  }

  session.transcript.push({ role: 'CUSTOMER', text, at: new Date().toISOString() });

  let assistantText = '';
  let llmFallback = false;
  try {
    assistantText = await generateLlmReply(session, text);
    session.step += 1;
  } catch (error) {
    llmFallback = true;
    console.error(`[TEST CALL] LLM fallback session=${session.id}: ${error.message}`);
    assistantText = scriptedReply(session);
  }

  const isCompleted = session.step > QUESTION_PLAN.length;
  session.transcript.push({ role: 'AGENT', text: assistantText, at: new Date().toISOString() });

  await dbRun(
    `UPDATE calls
        SET transcript_text = ?,
            transcript_status = ?,
            analysis_status = ?,
            outcome = ?,
            ended_at = CASE WHEN ? THEN ? ELSE ended_at END
      WHERE id = ?`,
    [
      toPlainTranscript(session.transcript),
      isCompleted ? 'completed' : 'in_progress',
      isCompleted ? 'processing' : 'pending',
      isCompleted ? 'completed' : 'answered',
      isCompleted ? 1 : 0,
      isCompleted ? new Date().toISOString() : null,
      session.callId
    ]
  );

  let saveResult = null;
  if (isCompleted) {
    saveResult = await saveTestFeedback(session);
    session.status = 'completed';
    sessions.delete(session.id);
  }

  return serializeSession(session, {
    llmFallback,
    saved: Boolean(saveResult?.saved),
    feedbackId: saveResult?.feedbackId || null
  });
}

async function saveTestFeedback(session) {
  const extraction = extractCallFeedback(session.transcript);
  const reviewText = extraction.reviewText || 'Patient completed a test feedback call.';
  const stars = Number.isInteger(extraction.stars) ? extraction.stars : 3;
  const categorization = await categorizeFeedback(reviewText, stars);
  const existingFeedback = await dbGet('SELECT id FROM feedback WHERE call_id = ?', [session.callId]);

  await dbRun(
    `UPDATE calls
        SET transcript_text = ?,
            transcript_status = ?,
            analysis_status = ?,
            extracted_rating = ?,
            extracted_review_text = ?,
            feedback_saved_at = ?,
            outcome = ?
      WHERE id = ?`,
    [
      toPlainTranscript(session.transcript),
      'completed',
      'completed',
      stars,
      reviewText,
      new Date().toISOString(),
      'completed',
      session.callId
    ]
  );

  if (existingFeedback) {
    await dbRun(
      `UPDATE feedback
          SET review_text = ?, category = ?, stars = ?, submitted_at = ?, source = ?
        WHERE id = ?`,
      [reviewText, categorization.category, stars, new Date().toISOString(), TEST_CALL_SOURCE, existingFeedback.id]
    );
    return { saved: true, feedbackId: existingFeedback.id, updated: true };
  }

  const result = await dbRun(
    `INSERT INTO feedback (customer_id, call_id, review_text, category, stars, submitted_at, source)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [session.customerId, session.callId, reviewText, categorization.category, stars, new Date().toISOString(), TEST_CALL_SOURCE]
  );

  console.log(`[TEST CALL] saved feedback session=${session.id} feedbackId=${result.lastID}`);
  return { saved: true, feedbackId: result.lastID, updated: false };
}

async function endTestCall({ sessionId, reason = 'ended_by_admin' }) {
  const session = sessions.get(sessionId);
  if (!session) {
    const error = new Error('Test call session not found');
    error.statusCode = 404;
    throw error;
  }

  session.status = 'completed';
  session.transcript.push({
    role: 'AGENT',
    text: 'The test call has been ended.',
    at: new Date().toISOString()
  });

  await dbRun(
    `UPDATE calls
        SET transcript_text = ?,
            transcript_status = ?,
            analysis_status = ?,
            outcome = ?,
            ended_at = ?,
            notes = COALESCE(notes, '') || ?
      WHERE id = ?`,
    [
      toPlainTranscript(session.transcript),
      'completed',
      'completed',
      'completed',
      new Date().toISOString(),
      `; ${reason}`,
      session.callId
    ]
  );

  const saveResult = await saveTestFeedback(session);
  sessions.delete(session.id);
  console.log(`[TEST CALL] ended session=${session.id} reason=${reason}`);

  return serializeSession(session, {
    saved: saveResult.saved,
    feedbackId: saveResult.feedbackId
  });
}

module.exports = {
  startTestCall,
  sendUserResponse,
  endTestCall,
  saveTestFeedback,
  _test: {
    buildFallbackOutboundFeedbackPrompt
  }
};
