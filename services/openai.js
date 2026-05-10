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

async function transcribeAudioFile() {
  return null;
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
