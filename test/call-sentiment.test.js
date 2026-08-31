'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { buildCallAnalysis, parseTranscriptTurns } = require('../services/call-analysis');

// Verbatim from the first successful production call, which stored
// sentiment "neutral" while the patient said their experience was very bad.
const REAL_TRANSCRIPT = [
  'AGENT: Good Afternoon. Main Apna Blood Centre se baat kar rahi hoon.',
  'CUSTOMER: Hello.',
  'AGENT: Aapne Sir, blood donate karne ka aapka experience achha tha ya koi pareshani hui thi?',
  'CUSTOMER: मेरा experience बहुत बुरा था.',
  'AGENT: Maaf kijiye Sir. Kripya batayein aapko kya pareshani hui thi?',
  'CUSTOMER: Blood donation camp आपका बहुत ज़्यादा डरती'
].join('\n');

const callFor = (transcript) => ({
  id: 1, transcript_text: transcript, call_type: 'REVIEW_CALL',
  called_at: new Date().toISOString(), ended_at: new Date().toISOString()
});

test('the patient is heard when their turns are labelled CUSTOMER', () => {
  // The media bridge writes CUSTOMER; the analyser only looked for PATIENT, so
  // every patient turn was invisible and sentiment sat on its default.
  const turns = parseTranscriptTurns(REAL_TRANSCRIPT);
  const patientTurns = turns.filter((t) => ['PATIENT', 'CUSTOMER'].includes(String(t.role).toUpperCase()));
  assert.ok(patientTurns.length >= 3, `expected the patient's turns, got ${patientTurns.length}`);
});

test('the call that was scored neutral is scored negative', () => {
  const analysis = buildCallAnalysis(callFor(REAL_TRANSCRIPT));
  assert.strictEqual(analysis.sentiment, 'negative',
    'a patient saying their experience was very bad is not neutral');
});

test('common Hindi and romanised negatives are recognised', () => {
  for (const said of ['मेरा experience बहुत बुरा था', 'सर्विस बहुत खराब थी', 'bahut bura experience tha', 'service kharab thi']) {
    const analysis = buildCallAnalysis(callFor(`AGENT: Kaisa raha?\nCUSTOMER: ${said}`));
    assert.strictEqual(analysis.sentiment, 'negative', `"${said}" should read as negative`);
  }
});

test('genuine praise still reads as positive', () => {
  for (const said of ['bahut achha experience tha', 'सब कुछ अच्छा था', 'koi dikkat nahi hui']) {
    const analysis = buildCallAnalysis(callFor(`AGENT: Kaisa raha?\nCUSTOMER: ${said}`));
    assert.notStrictEqual(analysis.sentiment, 'negative', `"${said}" should not read as negative`);
  }
});

test('the stored score agrees in sign with the label', () => {
  const negative = buildCallAnalysis(callFor(REAL_TRANSCRIPT));
  assert.ok(negative.sentiment_score < 0,
    `negative sentiment stored ${negative.sentiment_score}; a positive number next to "negative" is misleading`);

  const positive = buildCallAnalysis(callFor('AGENT: Kaisa raha?\nCUSTOMER: bahut achha tha, koi dikkat nahi'));
  if (positive.sentiment === 'positive') assert.ok(positive.sentiment_score > 0);
});
