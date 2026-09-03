'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildAgentSystemPrompt, buildOpeningPrompt } = require('../src/prompt-builder');
const { YESTERDAY, eligibilityLabel } = require('./support/call-dates');

// Relative to today: the prompts say "kal" or name a date by comparing to now,
// so a fixed date passes on the day it is written and fails the day after.
const options = { lastVisitDate: YESTERDAY };

// agents.system_prompt and agents.opening_prompt have existed since the first
// migration and the Agents screen edits them, but nothing read them: every call
// used the built-in script while the screen appeared to configure it.
test('an agent with no saved prompt falls back to the built-in script', () => {
  const withoutAgent = buildAgentSystemPrompt('Client', 'Ankita', null, 'review_call', options);
  const blankAgent = buildAgentSystemPrompt('Client', 'Ankita', { system_prompt: '   ' }, 'review_call', options);

  assert.match(withoutAgent, /You are Priya/);
  assert.equal(blankAgent, withoutAgent);
});

test('a saved system prompt replaces the built-in script', () => {
  const prompt = buildAgentSystemPrompt('Client', 'Ankita', {
    system_prompt: 'You are Meera from {{client_name}}. Speak to {{patient_name}}.'
  }, 'review_call', options);

  assert.match(prompt, /^You are Meera from Apna Blood Centre\. Speak to Ankita\./);
  assert.doesNotMatch(prompt, /You are Priya/);
});

// A custom script used to replace the built-in prompt outright, so an edit that
// dropped the disclosure or the identity check went out on a live health call.
test('the safety rules survive a saved prompt that omits them', () => {
  const prompt = buildAgentSystemPrompt('Client', 'Ankita', {
    system_prompt: 'You are Meera. Ask how their visit was.'
  }, 'review_call', options);

  assert.match(prompt, /Rules that always apply/);
  assert.match(prompt, /automated call/i);
  assert.match(prompt, /Confirm you are speaking to the right person/i);
  assert.match(prompt, /Never state a fact you were not given/i);
  assert.match(prompt, /never promise a callback/i);
  assert.match(prompt, /Never say "sir" or "madam"/i);
});

// The opening is one spoken sentence, not instructions; appending rules to it
// would have the agent read them aloud.
test('the opening line is not given a rules block', () => {
  const opening = buildOpeningPrompt('Client', 'Ankita', {
    opening_prompt: 'Namaste, Meera bol rahi hoon.'
  }, 'review_call', options);

  assert.equal(opening, 'Namaste, Meera bol rahi hoon.');
});

test('a saved opening prompt is used and its placeholders filled', () => {
  const opening = buildOpeningPrompt('Client', 'Ankita', {
    opening_prompt: '[GREETING]. {{patient_name}} ji, aapne {{last_visit}} donate kiya. Agli baar {{next_eligible}}.'
  }, 'review_call', options);

  assert.match(opening, /Ankita ji, aapne kal donate kiya\./);
  assert.match(opening, new RegExp(`Agli baar ${eligibilityLabel(YESTERDAY)}\\.`));
  assert.doesNotMatch(opening, /\{\{|\[GREETING\]/);
});

// A placeholder nobody defined must not be read aloud to the donor.
test('an unknown placeholder resolves to nothing rather than leaking', () => {
  const prompt = buildAgentSystemPrompt('Client', 'Ankita', {
    system_prompt: 'Hello {{not_a_real_field}}.'
  }, 'review_call', options);

  assert.match(prompt, /^Hello \./);
  assert.doesNotMatch(prompt, /\{\{/);
});

test('the follow-up call honours a saved prompt too', () => {
  const prompt = buildAgentSystemPrompt('Client', 'Rajesh', {
    system_prompt: 'Custom follow-up for {{patient_name}}.'
  }, 'three_month_followup', options);

  assert.match(prompt, /^Custom follow-up for Rajesh\./);
  assert.match(prompt, /Rules that always apply/);
});
