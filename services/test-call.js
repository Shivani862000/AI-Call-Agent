const supabase = require('../src/supabase');
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

async function buildTestPrompt(patientName) {
  const { data: agents } = await supabase.from('agents').select('*').eq('is_active', 1).order('is_default', { ascending: false }).order('id', { ascending: true }).limit(1);
  const agent = agents && agents.length > 0 ? agents[0] : null;
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
  const { data: existing } = await supabase.from('customers').select('id').eq('phone', normalizedPhone).single();
  if (existing) {
    return existing.id;
  }

  const { data: result } = await supabase.from('customers').insert([{
    name: name,
    phone: normalizedPhone,
    preferred_slot: 'test',
    status: 'completed',
    created_at: new Date().toISOString()
  }]).select('id').single();

  return result.id;
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
  const { data: callResult } = await supabase.from('calls').insert([{
    customer_id: customerId,
    called_at: new Date().toISOString(),
    outcome: 'initiated',
    provider_call_id: providerCallId,
    call_direction: 'outbound',
    call_source: TEST_CALL_SOURCE,
    transcript_status: 'in_progress',
    analysis_status: 'pending',
    call_script_version: 'test-feedback-v1',
    agent_id: promptConfig.agentId,
    notes: `${TEST_CALL_TYPE}; prompt_source=${promptConfig.promptSource}`
  }]).select('id').single();

  const session = {
    id: providerCallId,
    callId: callResult.id,
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

  await supabase.from('calls').update({
    transcript_text: toPlainTranscript(session.transcript),
    transcript_status: isCompleted ? 'completed' : 'in_progress',
    analysis_status: isCompleted ? 'processing' : 'pending',
    outcome: isCompleted ? 'completed' : 'answered',
    ended_at: isCompleted ? new Date().toISOString() : undefined
  }).eq('id', session.callId);

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
  const { data: existingFeedback } = await supabase.from('feedback').select('id').eq('call_id', session.callId).single();

  await supabase.from('calls').update({
    transcript_text: toPlainTranscript(session.transcript),
    transcript_status: 'completed',
    analysis_status: 'completed',
    extracted_rating: stars,
    extracted_review_text: reviewText,
    feedback_saved_at: new Date().toISOString(),
    outcome: 'completed'
  }).eq('id', session.callId);

  if (existingFeedback) {
    await supabase.from('feedback').update({
      review_text: reviewText, category: categorization.category, stars: stars, submitted_at: new Date().toISOString(), source: TEST_CALL_SOURCE
    }).eq('id', existingFeedback.id);
    return { saved: true, feedbackId: existingFeedback.id, updated: true };
  }

  const { data: result } = await supabase.from('feedback').insert([{
    customer_id: session.customerId, call_id: session.callId, review_text: reviewText, category: categorization.category, stars: stars, submitted_at: new Date().toISOString(), source: TEST_CALL_SOURCE
  }]).select('id').single();

  console.log(`[TEST CALL] saved feedback session=${session.id} feedbackId=${result.id}`);
  return { saved: true, feedbackId: result.id, updated: false };
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

  const { data: callInfo } = await supabase.from('calls').select('notes').eq('id', session.callId).single();
  const existingNotes = callInfo?.notes || '';
  await supabase.from('calls').update({
    transcript_text: toPlainTranscript(session.transcript),
    transcript_status: 'completed',
    analysis_status: 'completed',
    outcome: 'completed',
    ended_at: new Date().toISOString(),
    notes: `${existingNotes}; ${reason}`
  }).eq('id', session.callId);

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
