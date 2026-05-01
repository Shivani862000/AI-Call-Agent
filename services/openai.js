const OpenAI = require('openai');
const fs = require('fs');

const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

function hasOpenAIAccess() {
  return Boolean(process.env.OPENAI_API_KEY);
}

function buildFallbackCallScript(customerName) {
  const safeName = customerName || 'there';
  return `Hi ${safeName}, thank you for choosing ${process.env.CLIENT_NAME || 'us'}. Press 1 to receive a review link, or press 2 to skip.`;
}

function categorizeFeedbackFallback(reviewText = '', stars) {
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

  const positiveWords = ['good', 'great', 'excellent', 'amazing', 'love', 'happy', 'satisfied', 'awesome', 'helpful', 'quick'];
  const negativeWords = ['bad', 'poor', 'terrible', 'awful', 'hate', 'slow', 'rude', 'disappointed', 'worst', 'issue'];

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

async function generateCallScript(customerName) {
  if (!hasOpenAIAccess()) {
    return buildFallbackCallScript(customerName);
  }

  try {
    if (!openai) {
      return buildFallbackCallScript(customerName);
    }

    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      max_tokens: 200,
      messages: [
        {
          role: 'system',
          content: `You are a polite customer service agent for ${process.env.CLIENT_NAME}. 
Generate a short, friendly phone intro asking the customer for feedback. 
End by asking them to press 1 to agree to leave a Google review, or press 2 to opt out.
Keep it under 30 words.`
        },
        {
          role: 'user',
          content: `Customer name: ${customerName}`
        }
      ]
    });

    const script = response.choices[0].message.content;
    console.log(`✓ Generated call script for ${customerName}`);
    return script;
  } catch (error) {
    console.error('Error generating call script:', error.message);
    return buildFallbackCallScript(customerName);
  }
}

async function categorizeFeedback(reviewText, stars) {
  if (!hasOpenAIAccess()) {
    return categorizeFeedbackFallback(reviewText, stars);
  }

  try {
    if (!openai) {
      return categorizeFeedbackFallback(reviewText, stars);
    }

    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      max_tokens: 100,
      messages: [
        {
          role: 'system',
          content: `You are a feedback categorisation engine. 
Given a customer review, respond with ONLY a JSON object: 
{ "category": "good" | "average" | "bad", "reason": "string (max 10 words)" }
Rules: 4-5 stars or positive sentiment = good. 
       3 stars or mixed = average. 
       1-2 stars or negative = bad.`
        },
        {
          role: 'user',
          content: `Review: ${reviewText}. Stars: ${stars}/5`
        }
      ]
    });

    const responseText = response.choices[0].message.content;
    const parsed = JSON.parse(responseText);
    
    console.log(`✓ Categorized feedback: ${parsed.category}`);
    return parsed;
  } catch (error) {
    console.error('Error categorizing feedback:', error.message);
    return categorizeFeedbackFallback(reviewText, stars);
  }
}

function buildTranscriptAnalysisFallback(transcriptText = '') {
  const normalized = String(transcriptText || '').toLowerCase();
  const positiveSignals = ['achha', 'accha', 'good', 'great', 'helpful', 'clean', 'theek', 'satisfied'];
  const negativeSignals = ['bad', 'poor', 'slow', 'issue', 'problem', 'rude', 'dirty', 'wait'];
  const positiveCount = positiveSignals.filter((word) => normalized.includes(word)).length;
  const negativeCount = negativeSignals.filter((word) => normalized.includes(word)).length;
  const sentiment = positiveCount >= negativeCount ? 'positive' : 'negative';

  return {
    summary: sentiment === 'positive'
      ? 'Customer shared mostly positive feedback during the call.'
      : 'Customer shared concerns during the call.',
    key_points: [],
    customer_sentiment: sentiment,
    rating: null,
    consent: null,
    language: normalized.includes('hindi') ? 'hi' : null,
    review_text: '',
    improvement_suggestions: [],
    report_excerpt: sentiment === 'positive'
      ? 'Mostly positive call feedback.'
      : 'Call included service concerns.'
  };
}

async function transcribeAudioFile(filePath, options = {}) {
  if (!hasOpenAIAccess() || !openai) {
    return null;
  }

  try {
    const response = await openai.audio.transcriptions.create({
      file: fs.createReadStream(filePath),
      model: options.model || 'gpt-4o-mini-transcribe',
      language: options.language || 'hi',
      prompt: options.prompt || 'This is a Hindi customer feedback call between an agent and a customer. Return accurate Hindi and Hinglish transcript text.'
    });

    return response.text || null;
  } catch (error) {
    console.error('Error transcribing audio file:', error.message);
    return null;
  }
}

async function analyzeCallTranscript(transcriptText, context = {}) {
  if (!hasOpenAIAccess() || !openai) {
    return buildTranscriptAnalysisFallback(transcriptText);
  }

  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      response_format: { type: 'json_object' },
      max_tokens: 600,
      messages: [
        {
          role: 'system',
          content: `You analyze customer feedback phone calls.
Return ONLY JSON with this exact shape:
{
  "summary": "string",
  "key_points": ["string"],
  "customer_sentiment": "positive|neutral|negative",
  "rating": 1|2|3|4|5|null,
  "consent": true|false|null,
  "language": "hi|en|mixed|null",
  "review_text": "string",
  "improvement_suggestions": ["string"],
  "report_excerpt": "string"
}
Rules:
- Use the actual customer meaning, not literal noisy STT mistakes.
- Prefer Hindi/Hinglish understanding.
- If rating is unclear, use null.
- Keep summary under 35 words.
- Keep report_excerpt under 20 words.
- review_text should be a short human-readable summary of the customer's actual feedback.`
        },
        {
          role: 'user',
          content: `Client: ${context.clientName || process.env.CLIENT_NAME || 'Client'}\nCustomer: ${context.customerName || 'Customer'}\nTranscript:\n${transcriptText}`
        }
      ]
    });

    const parsed = JSON.parse(response.choices[0].message.content);
    return {
      summary: parsed.summary || '',
      key_points: Array.isArray(parsed.key_points) ? parsed.key_points : [],
      customer_sentiment: parsed.customer_sentiment || 'neutral',
      rating: Number.isInteger(parsed.rating) ? parsed.rating : null,
      consent: typeof parsed.consent === 'boolean' ? parsed.consent : null,
      language: parsed.language || null,
      review_text: parsed.review_text || '',
      improvement_suggestions: Array.isArray(parsed.improvement_suggestions) ? parsed.improvement_suggestions : [],
      report_excerpt: parsed.report_excerpt || ''
    };
  } catch (error) {
    console.error('Error analyzing call transcript:', error.message);
    return buildTranscriptAnalysisFallback(transcriptText);
  }
}

module.exports = {
  hasOpenAIAccess,
  generateCallScript,
  categorizeFeedback,
  transcribeAudioFile,
  analyzeCallTranscript
};
