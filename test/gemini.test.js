const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildGeminiConversationContents,
  extractGeminiText
} = require('../services/gemini');

test('builds Gemini multi-turn contents from call transcript', () => {
  const contents = buildGeminiConversationContents([
    { role: 'AGENT', text: 'Namaste.' },
    { role: 'CUSTOMER', text: 'Haan ji.' },
    { role: 'CUSTOMER', text: 'Main available hoon.' }
  ], 'Feedback achha tha.');

  assert.deepEqual(contents, [
    { role: 'model', parts: [{ text: 'Namaste.' }] },
    { role: 'user', parts: [{ text: 'Haan ji. Main available hoon. Feedback achha tha.' }] }
  ]);
});

test('extracts text from Gemini response payload', () => {
  const text = extractGeminiText({
    candidates: [
      {
        content: {
          parts: [
            { text: 'Dhanyavaad. ' },
            { text: 'Aapka feedback note kar liya.' }
          ]
        }
      }
    ]
  });

  assert.equal(text, 'Dhanyavaad. Aapka feedback note kar liya.');
});
