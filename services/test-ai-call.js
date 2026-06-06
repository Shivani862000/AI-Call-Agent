const { dbRun } = require('../db');
const { extractCallFeedback } = require('./call-feedback');
const { categorizeFeedback } = require('./gemini');

const sessions = new Map();
const DEFAULT_CLIENT_NAME = process.env.CLIENT_NAME || 'KC Prashant Path Lab';
const DEEPGRAM_MODEL = process.env.TEST_CALL_DEEPGRAM_MODEL || process.env.DEEPGRAM_MODEL || 'nova-3';
const DEEPGRAM_LANGUAGE = process.env.TEST_CALL_DEEPGRAM_LANGUAGE || process.env.DEEPGRAM_LANGUAGE || 'hi';

const QUESTION_PLAN = [
  { key: 'visit_experience', prompt: 'आपका लैब विजिट कैसा रहा?' },
  { key: 'staff_behavior', prompt: 'स्टाफ का व्यवहार कैसा था?' },
  { key: 'cleanliness', prompt: 'लैब की सफाई कैसी लगी?' },
  { key: 'rating', prompt: 'कुल मिलाकर आप 1 से 5 में कितनी रेटिंग देंगे?' },
  { key: 'improvement', prompt: 'कोई सुझाव या सुधार बताना चाहेंगे?' }
];

function makeSession() {
  const id = `sess_${Date.now().toString(36)}_${Math.floor(Math.random() * 10000)}`;
  const session = {
    id,
    callId: null,
    status: 'started',
    step: 0,
    transcript: []
  };
  sessions.set(id, session);
  return session;
}

async function startBrowserTestCall() {
  const session = makeSession();
  // initial agent prompt
  const opening = process.env.TEST_CALL_OPENING_LINE || 'नमस्ते, क्या मैं एक मिनट ले सकती हूं?';
  session.transcript.push({ role: 'AGENT', text: opening, at: new Date().toISOString() });
  return { sessionId: session.id, prompt: opening };
}

async function handleUserMessage({ sessionId, message }) {
  const session = sessions.get(sessionId);
  if (!session) throw new Error('session not found');
  const text = String(message || '').trim();
  session.transcript.push({ role: 'CUSTOMER', text, at: new Date().toISOString() });

  // simple deterministic agent: ask next question or close
  let reply;
  if (session.step < QUESTION_PLAN.length) {
    reply = QUESTION_PLAN[session.step].prompt;
    session.step += 1;
  } else {
    reply = 'धन्यवाद। आपका फीडबैक रिकॉर्ड हो गया है।';
    session.status = 'completed';
  }

  session.transcript.push({ role: 'AGENT', text: reply, at: new Date().toISOString() });
  return { sessionId: session.id, reply, transcript: session.transcript };
}

async function handleUserAudio({ sessionId, audioBuffer, mimeType }) {
  const session = sessions.get(sessionId);
  if (!session) throw new Error('session not found');
  if (!audioBuffer || !audioBuffer.length) throw new Error('audio missing');

  // If Deepgram configured, attempt to call it; otherwise use a placeholder
  let transcript = '';
  if (process.env.DEEPGRAM_API_KEY) {
    const url = new URL('https://api.deepgram.com/v1/listen');
    url.searchParams.set('model', DEEPGRAM_MODEL);
    url.searchParams.set('language', DEEPGRAM_LANGUAGE);
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Token ${process.env.DEEPGRAM_API_KEY}`,
        'Content-Type': mimeType || 'audio/webm'
      },
      body: audioBuffer
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Deepgram failed: ${response.status} ${text}`);
    }
    const payload = await response.json();
    transcript = String(payload?.results?.channels?.[0]?.alternatives?.[0]?.transcript || '').trim();
  } else {
    transcript = '[audio received]';
  }

  session.transcript.push({ role: 'CUSTOMER', text: transcript, at: new Date().toISOString() });
  // respond with next question
  const reply = session.step < QUESTION_PLAN.length ? QUESTION_PLAN[session.step].prompt : 'धन्यवाद। आपका फीडबैक रिकॉर्ड हो गया है।';
  if (session.step < QUESTION_PLAN.length) session.step += 1; else session.status = 'completed';
  session.transcript.push({ role: 'AGENT', text: reply, at: new Date().toISOString() });

  return { sessionId: session.id, transcript: session.transcript, reply };
}

async function endBrowserTestCall({ sessionId }) {
  const session = sessions.get(sessionId);
  if (!session) throw new Error('session not found');
  session.status = 'ended';

  const extraction = extractCallFeedback(session.transcript);
  const reviewText = extraction.reviewText || session.transcript.filter(t => t.role === 'CUSTOMER').map(t => t.text).join(' ');
  const stars = Number.isInteger(extraction.stars) ? extraction.stars : null;
  const categorization = categorizeFeedback(reviewText, stars);

  // persist a minimal record if DB available
  try {
    await dbRun(`INSERT INTO calls (status, transcript_text, created_at) VALUES (?, ?, ?)`, [
      'completed', session.transcript.map(t => `${t.role}: ${t.text}`).join('\n'), new Date().toISOString()
    ]);
  } catch (err) {
    // ignore DB errors for test endpoint
  }

  return { sessionId: session.id, extraction, categorization };
}

module.exports = {
  startBrowserTestCall,
  handleUserMessage,
  handleUserAudio,
  endBrowserTestCall
};
