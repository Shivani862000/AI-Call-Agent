/**
 * src/speech-utils.js
 * Audio processing, speech detection, Deepgram URL construction.
 */

'use strict';

const { DEEPGRAM_ENDPOINTING_MS, DEEPGRAM_TTS_MODEL } = require('./config');

// ── Speech normalization ───────────────────────────────────────────────────────

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

// ── Affirmative / language detection ───────────────────────────────────────────

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

// ── Audio resampling ───────────────────────────────────────────────────────────

function resamplePcm16(buffer, fromRate, toRate) {
  if (!buffer.length || fromRate === toRate) {
    return buffer;
  }

  if (fromRate === 24000 && toRate === 8000) {
    const inputSamples = Math.floor(buffer.length / 2);
    const outputSamples = Math.floor(inputSamples / 3);
    const output = Buffer.alloc(outputSamples * 2);
    for (let i = 0; i < outputSamples; i++) {
      const s1 = buffer.readInt16LE(i * 6);
      const s2 = buffer.readInt16LE(i * 6 + 2);
      const s3 = buffer.readInt16LE(i * 6 + 4);
      const avg = Math.round((s1 + s2 + s3) / 3);
      output.writeInt16LE(avg, i * 2);
    }
    return output;
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

// ── Deepgram URL builders ──────────────────────────────────────────────────────

function createDeepgramListenUrl() {
  const url = new URL('wss://api.deepgram.com/v1/listen');
  url.searchParams.set('model', 'nova-2');
  url.searchParams.set('language', 'hi');
  url.searchParams.set('interim_results', 'true');
  url.searchParams.set('endpointing', String(DEEPGRAM_ENDPOINTING_MS));
  url.searchParams.set('utterance_end_ms', String(Math.max(DEEPGRAM_ENDPOINTING_MS + 820, 1000)));
  url.searchParams.set('smart_format', 'true');
  url.searchParams.set('encoding', 'linear16');
  url.searchParams.set('sample_rate', '8000');
  url.searchParams.set('channels', '1');
  return url.toString();
}

function createDeepgramSpeakUrl() {
  const url = new URL('wss://api.deepgram.com/v1/speak');
  url.searchParams.set('model', DEEPGRAM_TTS_MODEL);
  url.searchParams.set('encoding', 'linear16');
  url.searchParams.set('sample_rate', '8000');
  return url.toString();
}

// ── Speech segment detection ───────────────────────────────────────────────────

function shouldFlushSpeechSegment(buffer) {
  const text = String(buffer || '').trim();
  if (!text) {
    return false;
  }

  return /[.!?,;:।]\s*$/.test(text) || text.length >= 80;
}

// ── Customer intent detection ──────────────────────────────────────────────────

function isCustomerHangupIntent(text) {
  const normalized = String(text || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!normalized) {
    return false;
  }

  const patterns = [
    /\b(phone|call)\s+(kaat\s+do|kat\s+do|cut\s+do|band\s+karo|disconnect\s+karo|rakh\s+do)\b/i,
    /\b(kat|cut|disconnect|hang\s*up|band)\s+(the\s+)?(call|phone)\b/i,
    /\b(call|phone)\s+(band|close|disconnect|hangup)\s+(kar\s+do|karo)\b/i,
    /\bmain\s+(call|phone)\s+(rakh\s+raha|rakh\s+rahi)\s+(hoon|hu)\b/i,
    /\bbaad\s+mein\s+baat\s+karte\s+hai?n?\b/i,
    /\bnot\s+interested\b/i,
    /\bcall\s+mat\s+karo\b/i
  ];

  return patterns.some((pattern) => pattern.test(normalized));
}

function isAffirmativeAvailabilityResponse(text) {
  const normalized = String(text || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!normalized) {
    return false;
  }

  return /\b(haan|ha|han|yes|ji|bilkul|available|bolo|continue|sure)\b/.test(normalized)
    || /ho\s+sakti\s+hai/.test(normalized)
    || /ho\s+sakta\s+hai/.test(normalized)
    || /kar\s+sakte\s+hai/.test(normalized)
    || /kar\s+sakti\s+hoon/.test(normalized);
}

module.exports = {
  normalizeSpeech,
  inferDtmfUtterance,
  isAffirmativeResponse,
  detectLanguageChoice,
  resamplePcm16,
  parsePcmRate,
  createDeepgramListenUrl,
  createDeepgramSpeakUrl,
  shouldFlushSpeechSegment,
  isCustomerHangupIntent,
  isAffirmativeAvailabilityResponse
};
