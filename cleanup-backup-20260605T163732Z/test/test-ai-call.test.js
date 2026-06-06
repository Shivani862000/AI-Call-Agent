const test = require('node:test');
const assert = require('node:assert/strict');
const { extractCallFeedback } = require('../services/call-feedback');
const { OPENING_LINE, _test } = require('../services/test-ai-call');

test('browser AI call opening line matches required script', () => {
  assert.equal(
    OPENING_LINE,
    'नमस्ते, मैं केसी प्रशांत पैथ लैब से प्रिया बोल रही हूं। आपके हाल के लैब विजिट का छोटा सा फीडबैक लेना है। क्या मैं एक मिनट ले सकती हूं?'
  );
});

test('browser AI call prompt does not request identity fields', () => {
  const prompt = _test.buildBrowserFeedbackPrompt('KC Prashant Path Lab');

  assert.match(prompt, /Do not ask for patient name, phone number/i);
  assert.match(prompt, /visit experience/i);
  assert.match(prompt, /staff behavior/i);
  assert.match(prompt, /lab cleanliness/i);
  assert.match(prompt, /overall rating/i);
});

test('extracts Hindi browser-call feedback transcript', () => {
  const result = extractCallFeedback([
    { role: 'AGENT', text: 'Aapka visit experience kaisa raha?' },
    { role: 'CUSTOMER', text: 'Visit bahut smooth tha.' },
    { role: 'AGENT', text: 'Staff behavior kaisa tha?' },
    { role: 'CUSTOMER', text: 'Staff helpful tha.' },
    { role: 'AGENT', text: 'Lab cleanliness kaisi lagi?' },
    { role: 'CUSTOMER', text: 'Lab clean tha.' },
    { role: 'AGENT', text: 'Overall rating 1 se 5 ke beech kya denge?' },
    { role: 'CUSTOMER', text: '5.' },
    { role: 'AGENT', text: 'Koi suggestion ya improvement batana chahenge?' },
    { role: 'CUSTOMER', text: 'Reports thode fast milne chahiye.' }
  ]);

  assert.equal(result.stars, 5);
  assert.equal(result.hasFeedback, true);
  assert.match(result.reviewText, /Overall experience: Visit bahut smooth tha/i);
  assert.match(result.reviewText, /Cleanliness feedback: Lab clean tha/i);
  assert.match(result.reviewText, /Suggestion: Reports thode fast milne chahiye/i);
});

test('browser call summary uses captured speech for partial calls', () => {
  const summary = _test.buildSummary([
    { role: 'AGENT', text: OPENING_LINE },
    { role: 'CUSTOMER', text: 'Haan ji, visit experience achha tha.' }
  ]);

  assert.equal(summary.reviewText, 'Haan ji, visit experience achha tha.');
  assert.equal(summary.sentiment, 'neutral');
});
