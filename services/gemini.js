const fs = require('fs/promises');
const path = require('path');

const GEMINI_TRANSCRIPTION_ENDPOINT = process.env.GEMINI_TRANSCRIPTION_ENDPOINT || 'https://api.gemini.example/v1/audio/transcriptions';
const GEMINI_BATCH_TRANSCRIPTION_MODEL = process.env.GEMINI_BATCH_TRANSCRIPTION_MODEL || process.env.GEMINI_MODEL || 'models/gemini-2.5-flash-native-audio-preview-12-2025';

function getAudioMimeType(filePath = '') {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === '.mp3') return 'audio/mpeg';
  if (extension === '.mp4') return 'audio/mp4';
  if (extension === '.mpeg') return 'audio/mpeg';
  if (extension === '.mpga') return 'audio/mpeg';
  if (extension === '.m4a') return 'audio/mp4';
  if (extension === '.wav') return 'audio/wav';
  if (extension === '.webm') return 'audio/webm';
  return 'application/octet-stream';
}

function buildFallbackCallScript(customerName) {
  const safeName = customerName || 'there';
  return `Hi ${safeName}, thank you for choosing ${process.env.CLIENT_NAME || 'us'}. Press 1 to receive a review link, or press 2 to skip.`;
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

async function transcribeAudioFile(filePath, options = {}) {
  if (!filePath) return null;

  if (!process.env.GEMINI_API_KEY) {
    console.warn('[GEMINI STT] Missing GEMINI_API_KEY; recording transcription skipped.');
    return null;
  }

  const audioBuffer = await fs.readFile(filePath);
  // Minimal compatibility: send multipart/form-data if endpoint expects it.
  const form = new FormData();
  form.append('model', options.model || GEMINI_BATCH_TRANSCRIPTION_MODEL);
  form.append('response_format', 'text');
  if (options.language) form.append('language', options.language);
  form.append('file', new Blob([audioBuffer], { type: getAudioMimeType(filePath) }), path.basename(filePath));

  const response = await fetch(GEMINI_TRANSCRIPTION_ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.GEMINI_API_KEY}`
    },
    body: form
  });

  const responseText = await response.text();
  if (!response.ok) {
    throw new Error(`Gemini transcription failed (${response.status}): ${responseText || response.statusText}`);
  }

  return responseText.trim();
}

async function generateCallScript(customerName) {
  return buildFallbackCallScript(customerName);
}

module.exports = {
  generateCallScript,
  categorizeFeedback,
  transcribeAudioFile,
  analyzeCallTranscript
};
