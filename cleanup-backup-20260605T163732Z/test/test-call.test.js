const test = require('node:test');
const assert = require('node:assert/strict');
const { extractCallFeedback } = require('../services/call-feedback');
const { _test } = require('../services/test-call');

test('fallback test-call prompt includes required feedback topics', () => {
  const prompt = _test.buildFallbackOutboundFeedbackPrompt('KC Path Lab', 'Asha');

  assert.match(prompt, /visit experience/i);
  assert.match(prompt, /staff behavior/i);
  assert.match(prompt, /clean/i);
  assert.match(prompt, /rating from 1 to 5/i);
  assert.match(prompt, /improvement suggestion/i);
});

test('extracts feedback from test-call transcript wording', () => {
  const result = extractCallFeedback([
    { role: 'AGENT', text: 'How was your visit experience at the lab?' },
    { role: 'CUSTOMER', text: 'The visit was smooth and quick.' },
    { role: 'AGENT', text: 'How was the staff behavior during your visit?' },
    { role: 'CUSTOMER', text: 'Staff behavior was polite and helpful.' },
    { role: 'AGENT', text: 'Was the lab clean and comfortable?' },
    { role: 'CUSTOMER', text: 'Yes, the lab was clean.' },
    { role: 'AGENT', text: 'What overall rating would you give from 1 to 5?' },
    { role: 'CUSTOMER', text: '5 out of 5.' },
    { role: 'AGENT', text: 'Is there anything we can improve for your next visit?' },
    { role: 'CUSTOMER', text: 'Please make reports available faster.' }
  ]);

  assert.equal(result.stars, 5);
  assert.equal(result.hasFeedback, true);
  assert.match(result.reviewText, /Overall experience: The visit was smooth and quick/i);
  assert.match(result.reviewText, /Staff feedback: Staff behavior was polite and helpful/i);
  assert.match(result.reviewText, /Cleanliness feedback: Yes, the lab was clean/i);
  assert.match(result.reviewText, /Suggestion: Please make reports available faster/i);
});
