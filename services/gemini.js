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
  apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY,
  responseMimeType = null,
  maxTokens = null
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
        maxOutputTokens: maxTokens || Number(process.env.GEMINI_MAX_OUTPUT_TOKENS || process.env.LIVE_MAX_RESPONSE_TOKENS || 60),
        thinkingConfig: {
          thinkingBudget: Number(process.env.GEMINI_THINKING_BUDGET || 0)
        },
        ...(responseMimeType ? { responseMimeType } : {})
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

// Deepgram returns Devanagari for hi-IN, and donors speak romanised Hindi too.
// The old lists were ASCII-only and carried no Hindi negatives at all, so every
// Hindi call reaching the fallback -- complaints included -- came out neutral.
const POSITIVE_SIGNALS = [
  'achha', 'accha', 'acha', 'badhiya', 'badiya', 'sahi', 'santusht', 'satisfied',
  'good', 'great', 'excellent', 'helpful', 'clean', 'supportive',
  'अच्छा', 'अच्छी', 'बढ़िया', 'सही', 'संतुष्ट'
];

const NEGATIVE_SIGNALS = [
  'bura', 'buri', 'kharab', 'kharaab', 'ganda', 'bekar', 'bakwas',
  'pareshani', 'dikkat', 'samasya', 'shikayat', 'intezar', 'der',
  'bad', 'poor', 'slow', 'issue', 'problem', 'rude', 'dirty', 'complaint',
  'बुरा', 'बुरी', 'खराब', 'गंदा', 'बेकार', 'परेशानी', 'दिक्कत', 'समस्या', 'शिकायत'
];

/** Devanagari, or common Hindi words written in Roman script. */
function isHindi(text) {
  if (/[\u0900-\u097F]/.test(String(text))) return true;
  return /\b(hindi|haan|nahi|nahin|ji|hai|tha|thi|kya|aap|mera|hum|bahut|achha|accha|acha|theek|bura|kharab)\b/i
    .test(String(text));
}

/**
 * A rough read of the transcript when the model is unavailable.
 *
 * It deliberately returns no rating. The old version scored 4, 2 or 3 stars
 * from keyword counts and stored them exactly like a rating the patient gave,
 * so an outage quietly filled the reports with invented numbers that nothing
 * downstream could tell apart from real ones.
 */
function heuristicAnalysis(transcriptText) {
  const text = String(transcriptText || '');
  const normalized = text.toLowerCase();
  const count = (words) => words.filter((word) => normalized.includes(word)).length;

  const positive = count(POSITIVE_SIGNALS);
  const negative = count(NEGATIVE_SIGNALS);
  const sentiment = positive > negative ? 'positive' : negative > positive ? 'negative' : 'neutral';

  const summary = sentiment === 'positive'
    ? 'Automatic analysis unavailable; the wording suggests mostly positive feedback.'
    : sentiment === 'negative'
      ? 'Automatic analysis unavailable; the wording suggests the patient raised concerns.'
      : 'Automatic analysis unavailable; the transcript needs reading.';

  return {
    summary,
    key_points: [],
    customer_sentiment: sentiment,
    // Never guessed. A missing rating is honest; an invented one is not.
    rating: null,
    consent: null,
    language: isHindi(text) ? 'hi' : 'en',
    review_text: '',
    improvement_suggestions: [],
    report_excerpt: 'Automatic analysis unavailable; transcript not yet reviewed.'
  };
}

/**
 * Whether the patient said anything at all.
 *
 * Live transcripts label every line "AGENT:" or "CUSTOMER:". Transcripts
 * recovered from the recording have no labels, so filtering on the "AGENT:"
 * prefix removed nothing and a call where only the agent spoke was analysed as
 * though the patient had answered. An unlabelled transcript is treated as
 * containing speech, because there is no way to tell whose it is.
 */
function transcriptHasCustomerSpeech(transcriptText) {
  const lines = String(transcriptText || '').split('\n').map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return false;

  const labelled = lines.filter((line) => /^(AGENT|AI|CUSTOMER|PATIENT)\s*:/i.test(line));
  if (!labelled.length) return true;

  return labelled.some((line) => /^(CUSTOMER|PATIENT)\s*:\s*\S/i.test(line));
}

async function analyzeCallTranscript(transcriptText, context = {}) {
  const hasCustomerSpeech = transcriptHasCustomerSpeech(transcriptText);

  if (!hasCustomerSpeech) {
    return {
      summary: 'Call ended before the customer could provide any feedback.',
      customer_sentiment: 'neutral',
      rating: null,
      consent: null,
      language: 'en',
      review_text: '',
      report_excerpt: 'No customer response.',
      key_points: [],
      improvement_suggestions: []
    };
  }

  const isFollowUp = String(context.callType || '').toUpperCase() === 'THREE_MONTH_FOLLOWUP';

  const systemPrompt = isFollowUp
    ? `You are an expert patient care call analyst. Analyze the following call transcript and generate a JSON response strictly following this schema:
{
  "summary": "1-2 sentences summarizing the call",
  "sentiment": "positive", "neutral", or "negative",
  "blood_donated_last_3_months": "Yes", "No", or null (if unknown),
  "willing_to_donate_future": "Yes", "No", or null (if not asked or unknown),
  "reported_donation_date": "the donor's own words for when they last donated, or null",
  "reported_donation_place": "the donor's own words for where they donated, or null",
  "intended_visit": "the donor's own words for when they said they will come in, or null",
  "language": "en" or "hi",
  "report_excerpt": "1 sentence high-level excerpt"
}

RULES:
- Most calls are in Hindi or Hinglish, in Roman or Devanagari script. Judge the meaning, not the script.
- Quote the donor for the date, place and intended visit rather than converting them. They say "pichle mahine" and "agle mahine ki 5 tareekh"; a guessed calendar date would be acted on as though they had committed to it.
- Never infer an answer the donor did not give. Return null instead.`
    : `You are an expert patient care call analyst. Analyze the following call transcript and generate a JSON response strictly following this schema:
{
  "summary": "1-2 sentences summarizing the call",
  "sentiment": "positive", "neutral", or "negative",
  "rating": integer from 1 to 5, or null if the patient never expressed how the experience was,
  "review_text": "EXACT quote or concise summary of the patient's feedback on their experience (e.g., 'experience bhot acha tha'). Empty string when the patient gave no feedback.",
  "language": "en" or "hi",
  "report_excerpt": "1 sentence high-level excerpt"
}

RATING SCALE GUIDELINES:
1/5: Very unhappy, explicit complaint, strong negative sentiment (e.g. "Bahut bura experience tha", "बहुत बुरा था")
2/5: Poor experience, a real problem (e.g. "Problem hui thi", "Kaafi wait karna pada", "दिक्कत हुई थी")
3/5: Genuinely indifferent, neither praise nor complaint (e.g. "Theek tha", "Chalta hai", "ठीक था")
4/5: Good experience, plain praise (e.g. "Achha tha", "Experience achha tha", "Staff supportive tha", "अच्छा था")
5/5: Excellent, emphatic or effusive praise (e.g. "Bahut achha tha", "Bahut hi badhiya", "Excellent", "बहुत अच्छा था")

RULES:
- Most calls are in Hindi or Hinglish, in Roman or Devanagari script. Judge the meaning, not the script.
- "Achha tha" is praise, not indifference. Reserve 3/5 for answers that are genuinely neither good nor bad.
- Never infer a rating the patient did not express. If they gave no view of their experience -- they only confirmed who they were, said "haan", or hung up -- return null. A guessed rating is worse than no rating, because nothing downstream can tell the two apart.`;

  try {
    const rawAiResponse = await generateGeminiReply({
      systemPrompt,
      userText: transcriptText || '(No transcript provided)',
      responseMimeType: 'application/json',
      model: DEFAULT_GEMINI_MODEL,
      maxTokens: 800
    });

    const analysis = JSON.parse(rawAiResponse);
    return {
      summary: analysis.summary || 'Customer shared feedback during the call.',
      customer_sentiment: analysis.sentiment || 'neutral',
      rating: analysis.rating || null,
      consent: null,
      language: analysis.language || 'en',
      review_text: analysis.review_text || '',
      report_excerpt: analysis.report_excerpt || 'Call completed.',
      blood_donated_last_3_months: analysis.blood_donated_last_3_months || null,
      willing_to_donate_future: analysis.willing_to_donate_future || null,
      key_points: [],
      improvement_suggestions: []
    };
  } catch (err) {
    console.error('[AI ANALYSIS ERROR]', err.message);
    return heuristicAnalysis(transcriptText);
  }
}

const fs = require('fs');

async function transcribeAudioFile(filePath, options = {}) {
  try {
    if (!fs.existsSync(filePath)) {
      return null;
    }
    const audioData = fs.readFileSync(filePath);
    
    if (process.env.DEEPGRAM_API_KEY) {
      const url = `https://api.deepgram.com/v1/listen?smart_format=true&language=${options.language || 'hi'}&model=nova-2&diarize=true`;
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Token ${process.env.DEEPGRAM_API_KEY}`,
          'Content-Type': 'audio/mpeg' // fallback content type
        },
        body: audioData
      });
      if (response.ok) {
        const result = await response.json();
        const paragraphs = result?.results?.channels?.[0]?.alternatives?.[0]?.paragraphs?.transcript;
        if (paragraphs) return paragraphs;
        return result?.results?.channels?.[0]?.alternatives?.[0]?.transcript || null;
      }
      const errText = await response.text();
      console.error('[DEEPGRAM TRANSCRIBE ERROR]', response.status, errText);
    }
    
    return null;
  } catch (error) {
    console.error('[TRANSCRIBE AUDIO ERROR]', error.message);
    return null;
  }
}

module.exports = {
  DEFAULT_GEMINI_MODEL,
  buildGeminiConversationContents,
  extractGeminiText,
  generateGeminiReply,
  categorizeFeedback,
  analyzeCallTranscript,
  heuristicAnalysis,
  transcriptHasCustomerSpeech,
  transcribeAudioFile
};
