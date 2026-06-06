const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildReviewCallingPrompt,
  buildReviewCallingOpeningPrompt
} = require('../prompts/review-calling.ts');
const {
  buildThreeMonthFollowupPrompt,
  buildThreeMonthFollowupOpeningPrompt
} = require('../prompts/three-month-followup.ts');

test('review calling prompt covers yes and no problem flows', () => {
  const prompt = buildReviewCallingPrompt({ clientName: 'Apna Blood Centre' });
  const opening = buildReviewCallingOpeningPrompt({ clientName: 'Apna Blood Centre' });

  assert.match(prompt, /post-donation feedback/i);
  assert.match(prompt, /koi dikkat ya problem hui thi/i);
  assert.match(prompt, /Kripya batayein aapko kya problem hui thi/i);
  assert.match(opening, /Blood donate karne ke baad/i);
});

test('three month follow-up prompt covers donated again yes and no flows', () => {
  const prompt = buildThreeMonthFollowupPrompt({
    clientName: 'Apna Blood Centre',
    donorName: 'Rahul Sharma'
  });
  const opening = buildThreeMonthFollowupOpeningPrompt({
    clientName: 'Apna Blood Centre',
    donorName: 'Rahul Sharma'
  });

  assert.match(prompt, /3 mahine poore ho gaye hain/i);
  assert.match(prompt, /Kab donate kiya tha/i);
  assert.match(prompt, /Kahan donate kiya tha/i);
  assert.match(prompt, /thalassemia/i);
  assert.match(opening, /Rahul Sharma ji/i);
});
