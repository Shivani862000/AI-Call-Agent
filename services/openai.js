const OpenAI = require('openai');

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

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

module.exports = {
  generateCallScript,
  categorizeFeedback
};
