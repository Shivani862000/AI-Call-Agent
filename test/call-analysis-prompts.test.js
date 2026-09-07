'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { heuristicAnalysis, transcriptHasCustomerSpeech } = require('../services/gemini');

// Deepgram returns Devanagari for hi-IN. The old word lists were ASCII-only and
// carried no Hindi negatives at all, so every Hindi call reaching the fallback
// -- complaints included -- was filed as neutral, 3 stars.
test('the fallback reads Hindi in both scripts', () => {
  const cases = [
    ['बहुत बुरा अनुभव था, स्टाफ ने ठीक से बात नहीं की', 'negative'],
    ['बहुत अच्छा था', 'positive'],
    ['experience bahut bura tha, kaafi der wait karna pada', 'negative'],
    ['achha tha, staff supportive tha', 'positive'],
    ['the staff was rude and the place was dirty', 'negative']
  ];
  for (const [text, expected] of cases) {
    assert.equal(heuristicAnalysis(text).customer_sentiment, expected, `misread: ${text}`);
  }
});

// It used to score 4, 2 or 3 stars from keyword counts and store them exactly
// like a rating the patient gave.
test('the fallback never invents a rating', () => {
  for (const text of ['बहुत अच्छा था', 'bahut bura tha', 'haan theek hai', '']) {
    assert.equal(heuristicAnalysis(text).rating, null, `invented a rating for: ${text}`);
  }
});

test('the fallback says plainly that it is a fallback', () => {
  assert.match(heuristicAnalysis('achha tha').summary, /Automatic analysis unavailable/);
  assert.match(heuristicAnalysis('achha tha').report_excerpt, /not yet reviewed/);
});

test('romanised Hindi is not reported as English', () => {
  assert.equal(heuristicAnalysis('experience bahut bura tha').language, 'hi');
  assert.equal(heuristicAnalysis('बहुत अच्छा था').language, 'hi');
  assert.equal(heuristicAnalysis('the staff was rude and slow').language, 'en');
});

// Live transcripts label each line; transcripts recovered from the recording do
// not, so filtering on the "AGENT:" prefix removed nothing and a call where
// only the agent spoke was analysed as though the patient had answered.
test('a call where only the agent spoke is recognised as having no feedback', () => {
  assert.equal(transcriptHasCustomerSpeech('AGENT: namaste\nAGENT: dhanyavaad'), false);
  assert.equal(transcriptHasCustomerSpeech('AI: namaste'), false);
  assert.equal(transcriptHasCustomerSpeech(''), false);
  assert.equal(transcriptHasCustomerSpeech('   \n  '), false);
});

test('a patient reply is recognised whatever the label', () => {
  assert.equal(transcriptHasCustomerSpeech('AGENT: namaste\nCUSTOMER: haan ji'), true);
  assert.equal(transcriptHasCustomerSpeech('AI: namaste\nPATIENT: achha tha'), true);
});

// An unlabelled transcript gives no way to tell whose speech it is, so it is
// analysed rather than silently discarded as "no feedback".
test('an unlabelled transcript is analysed rather than discarded', () => {
  assert.equal(transcriptHasCustomerSpeech('namaste ji, experience achha tha'), true);
});

// From a real UAT call. The donor said "बहुत बेकार" and described waiting a
// long time with nobody attending, and it scored neutral -- the exact call this
// analysis exists to catch. "bekaar" is as common as "bura", and waiting is the
// commonest complaint a blood centre gets; neither was in the vocabulary.
const { buildCallAnalysis } = require('../services/call-analysis');

const sentimentOf = (said) => buildCallAnalysis({
  transcript_text: `AGENT: Aapka experience kaisa raha?\nCUSTOMER: ${said}`,
  call_type: 'REVIEW_CALL'
}).sentiment;

test('a complaint about the service is read as negative', () => {
  const cases = [
    'बहुत बेकार. वहां पर बहुत देर wait करना पड़ा उसके बाद देखने के लिए कोई नहीं था.',
    'bahut bekaar tha',
    'bahut der wait karna pada',
    'बहुत बुरा था',
    'staff was rude and slow'
  ];
  for (const said of cases) {
    assert.equal(sentimentOf(said), 'negative', `read as ${sentimentOf(said)}: ${said}`);
  }
});

test('praise is still read as positive', () => {
  for (const said of ['बहुत अच्छा था', 'ठीक है', 'achha tha', 'koi dikkat nahi hui']) {
    assert.equal(sentimentOf(said), 'positive', `read as ${sentimentOf(said)}: ${said}`);
  }
});

// "haan ji" is how anyone confirms who they are when the call opens. It is not
// an opinion of the service and must not colour the sentiment.
test('confirming your own name is not praise', () => {
  assert.equal(sentimentOf('हां जी'), 'neutral');
  assert.equal(sentimentOf('haan ji'), 'neutral');
});
