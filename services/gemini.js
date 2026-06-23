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
  responseMimeType = null
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

async function analyzeCallTranscript(transcriptText, context = {}) {
  const userTurns = String(transcriptText || '').split('\n').filter(line => !line.toUpperCase().startsWith('AGENT:'));
  const hasCustomerSpeech = userTurns.some(line => line.trim().length > 0);

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
  "willing_to_donate_future": "Yes", "No", or null (if Q1 is Yes or unknown),
  "language": "en" or "hi",
  "report_excerpt": "1 sentence high-level excerpt"
}`
    : `You are an expert patient care call analyst. Analyze the following call transcript and generate a JSON response strictly following this schema:
{
  "summary": "1-2 sentences summarizing the call",
  "sentiment": "positive", "neutral", or "negative",
  "rating": integer from 1 to 5,
  "review_text": "EXACT quote or concise summary of the patient's feedback on their experience (e.g., 'experience bhot acha tha'). Must not be empty if rating is >3 or <3.",
  "language": "en" or "hi",
  "report_excerpt": "1 sentence high-level excerpt"
}

RATING SCALE GUIDELINES:
1/5: Customer very unhappy, explicit complaint, strong negative sentiment (e.g. "Bahut bura experience tha")
2/5: Poor experience, minor issue, negative tone (e.g. "Problem hui thi")
3/5: Neutral, experience was okay, no complaint but no strong praise (e.g. "Theek tha", "Experience acha tha")
4/5: Very good experience, positive feedback (e.g. "Bahut acha tha", "Experience kaafi acha tha", "Staff supportive tha")
5/5: Excellent experience, strong recommendation, highly satisfied (e.g. "Excellent", "Outstanding", "Bahut hi badhiya")`;

  try {
    const rawAiResponse = await generateGeminiReply({
      systemPrompt,
      userText: transcriptText || '(No transcript provided)',
      responseMimeType: 'application/json',
      model: 'gemini-2.5-flash'
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
    // Fallback to basic heuristics if API fails or isn't configured
    const normalized = String(transcriptText || '').toLowerCase();
    const positiveSignals = ['achha', 'accha', 'good', 'great', 'helpful', 'clean', 'theek', 'satisfied'];
    const negativeSignals = ['bad', 'poor', 'slow', 'issue', 'problem', 'rude', 'dirty', 'wait'];
    const positiveCount = positiveSignals.filter((word) => normalized.includes(word)).length;
    const negativeCount = negativeSignals.filter((word) => normalized.includes(word)).length;
    const sentiment = positiveCount > negativeCount ? 'positive' : negativeCount > positiveCount ? 'negative' : 'neutral';
    
    return {
      summary: sentiment === 'positive' ? 'Customer shared mostly positive feedback.' : sentiment === 'negative' ? 'Customer shared concerns.' : 'Customer shared mixed feedback.',
      key_points: [],
      customer_sentiment: sentiment,
      rating: sentiment === 'positive' ? 4 : sentiment === 'negative' ? 2 : 3,
      consent: null,
      language: /\b(hindi|haan|ji|achha|theek)\b/.test(normalized) ? 'hi' : 'en',
      review_text: '',
      improvement_suggestions: [],
      report_excerpt: sentiment === 'positive' ? 'Mostly positive call feedback.' : sentiment === 'negative' ? 'Call included service concerns.' : 'Mixed call feedback.'
    };
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
  transcribeAudioFile
};
