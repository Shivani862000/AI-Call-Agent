const DEFAULT_GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const GEMINI_API_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

function normalizeTurnText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function mapTranscriptRole(role) {
  return String(role || '').toUpperCase() === 'AGENT' ? 'model' : 'user';
}

function buildGeminiConversationContents(transcript = [], userText = '') {
  const contents = [];

  transcript.forEach((turn) => {
    const text = normalizeTurnText(turn?.text);
    if (!text) return;

    const last = contents[contents.length - 1];
    const role = mapTranscriptRole(turn?.role);
    if (last?.role === role) {
      last.parts[0].text = `${last.parts[0].text} ${text}`.replace(/\s+/g, ' ').trim();
      return;
    }

    contents.push({
      role,
      parts: [{ text }]
    });
  });

  const nextUserText = normalizeTurnText(userText);
  if (nextUserText) {
    const last = contents[contents.length - 1];
    if (last?.role === 'user') {
      last.parts[0].text = `${last.parts[0].text} ${nextUserText}`.replace(/\s+/g, ' ').trim();
    } else {
      contents.push({
        role: 'user',
        parts: [{ text: nextUserText }]
      });
    }
  }

  if (!contents.length) {
    contents.push({
      role: 'user',
      parts: [{ text: 'Start the call now.' }]
    });
  }

  return contents;
}

function extractGeminiText(payload) {
  const parts = payload?.candidates?.[0]?.content?.parts || [];
  return parts
    .map((part) => part?.text || '')
    .join('')
    .replace(/\bEND_CALL\b/g, '')
    .trim();
}

async function generateGeminiReply({
  systemPrompt,
  transcript = [],
  userText = '',
  model = DEFAULT_GEMINI_MODEL,
  apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY
} = {}) {
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY or GOOGLE_API_KEY is not configured');
  }

  const url = `${GEMINI_API_BASE_URL}/models/${encodeURIComponent(model)}:generateContent`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey
    },
    body: JSON.stringify({
      system_instruction: {
        parts: [{ text: String(systemPrompt || '').trim() }]
      },
      contents: buildGeminiConversationContents(transcript, userText),
      generationConfig: {
        temperature: Number(process.env.GEMINI_TEMPERATURE || process.env.LIVE_TEMPERATURE || 0.3),
        maxOutputTokens: Number(process.env.GEMINI_MAX_OUTPUT_TOKENS || process.env.LIVE_MAX_RESPONSE_TOKENS || 60),
        thinkingConfig: {
          thinkingBudget: Number(process.env.GEMINI_THINKING_BUDGET || 0)
        }
      }
    })
  });

  const rawText = await response.text();
  let payload = {};
  try {
    payload = rawText ? JSON.parse(rawText) : {};
  } catch (error) {
    payload = { rawText };
  }

  if (!response.ok) {
    throw new Error(`Gemini request failed (${response.status}): ${rawText || response.statusText}`);
  }

  const text = extractGeminiText(payload);
  if (!text) {
    throw new Error('Gemini returned an empty response');
  }
  return text;
}

function categorizeFeedback(reviewText = '', stars) {
  const normalizedText = String(reviewText).toLowerCase();
  const numericStars = Number(stars);

  if (!Number.isNaN(numericStars)) {
    if (numericStars >= 4) {
      return { category: 'good', reason: 'High star rating' };
    }

    if (numericStars <= 2) {
      return { category: 'bad', reason: 'Low star rating' };
    }
  }

  const positiveWords = ['good', 'great', 'excellent', 'amazing', 'love', 'happy', 'satisfied', 'awesome', 'helpful', 'quick', 'achha', 'accha', 'clean'];
  const negativeWords = ['bad', 'poor', 'terrible', 'awful', 'hate', 'slow', 'rude', 'disappointed', 'worst', 'issue', 'wait', 'dirty'];

  const positiveMatches = positiveWords.filter((word) => normalizedText.includes(word)).length;
  const negativeMatches = negativeWords.filter((word) => normalizedText.includes(word)).length;

  if (positiveMatches > negativeMatches) {
    return { category: 'good', reason: 'Positive review language' };
  }

  if (negativeMatches > positiveMatches) {
    return { category: 'bad', reason: 'Negative review language' };
  }

  return { category: 'average', reason: 'Mixed or neutral feedback' };
}

function analyzeCallTranscript(transcriptText, context = {}) {
  const normalized = String(transcriptText || '').toLowerCase();
  const positiveSignals = ['achha', 'accha', 'good', 'great', 'helpful', 'clean', 'theek', 'satisfied'];
  const negativeSignals = ['bad', 'poor', 'slow', 'issue', 'problem', 'rude', 'dirty', 'wait'];
  const positiveCount = positiveSignals.filter((word) => normalized.includes(word)).length;
  const negativeCount = negativeSignals.filter((word) => normalized.includes(word)).length;
  const sentiment = positiveCount > negativeCount ? 'positive' : negativeCount > positiveCount ? 'negative' : 'neutral';

  const summary = sentiment === 'positive'
    ? `Customer shared mostly positive feedback about ${context.clientName || process.env.CLIENT_NAME || 'the service'}.`
    : sentiment === 'negative'
      ? `Customer shared concerns about ${context.clientName || process.env.CLIENT_NAME || 'the service'}.`
      : 'Customer shared mixed or limited feedback during the call.';

  return {
    summary,
    key_points: [],
    customer_sentiment: sentiment,
    rating: null,
    consent: null,
    language: /\b(hindi|haan|ji|achha|theek)\b/.test(normalized) ? 'hi' : /\b(english|staff|process|waiting)\b/.test(normalized) ? 'en' : null,
    review_text: '',
    improvement_suggestions: [],
    report_excerpt: sentiment === 'positive'
      ? 'Mostly positive call feedback.'
      : sentiment === 'negative'
        ? 'Call included service concerns.'
        : 'Mixed call feedback.'
  };
}

async function transcribeAudioFile() {
  return null;
}

module.exports = {
  DEFAULT_GEMINI_MODEL,
  buildGeminiConversationContents,
  extractGeminiText,
  generateGeminiReply,
  categorizeFeedback,
  analyzeCallTranscript,
  transcribeAudioFile
};
