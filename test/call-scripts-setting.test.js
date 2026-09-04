'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildAgentSystemPrompt, buildOpeningPrompt } = require('../src/prompt-builder');
const { validateSetting, createSettingsStore, MAX_SCRIPT_LENGTH } = require('../src/app-settings');
const { SCRIPT_PLACEHOLDERS } = require('../prompts/safety-rules.ts');
const { YESTERDAY } = require('./support/call-dates');

const options = (callScripts) => ({ lastVisitDate: YESTERDAY, callScripts });

const scripts = (overrides) => ({
  review_call: { system_prompt: '', opening_prompt: '', ...overrides }
});

test('no custom script leaves the built-in one in place', () => {
  for (const value of [undefined, null, {}, scripts({})]) {
    const prompt = buildAgentSystemPrompt('C', 'Ankita', null, 'review_call', options(value));
    assert.match(prompt, /You are Priya/);
  }
});

test('a script written in settings is used', () => {
  const prompt = buildAgentSystemPrompt('C', 'Ankita', null, 'review_call', options(
    scripts({ system_prompt: 'You are Meera from {{client_name}}, {{client_city}}. Ask {{patient_name}} about their visit.' })
  ));

  assert.match(prompt, /You are Meera from Apna Blood Centre, Palwal\. Ask Ankita about their visit\./);
  assert.doesNotMatch(prompt, /You are Priya/);
});

// An admin editing the wording must not be able to remove the disclosure, the
// identity check, or the ban on inventing facts.
test('the safety rules are appended to whatever is written', () => {
  const prompt = buildAgentSystemPrompt('C', 'Ankita', null, 'review_call', options(
    scripts({ system_prompt: 'Just ask how it went.' })
  ));

  assert.match(prompt, /Rules that always apply/);
  assert.match(prompt, /automated call/i);
  assert.match(prompt, /Confirm you are speaking to the right person/i);
  assert.match(prompt, /never promise a callback/i);
});

test('settings win over an agent row, which an admin does not edit', () => {
  const prompt = buildAgentSystemPrompt('C', 'Ankita',
    { system_prompt: 'From the agent row.' },
    'review_call',
    options(scripts({ system_prompt: 'From the settings screen.' })));

  assert.match(prompt, /^From the settings screen\./);
});

test('each call type has its own script', () => {
  const both = {
    review_call: { system_prompt: 'Review script.' },
    three_month_followup: { system_prompt: 'Follow-up script.' }
  };
  assert.match(buildAgentSystemPrompt('C', 'A', null, 'review_call', options(both)), /^Review script\./);
  assert.match(buildAgentSystemPrompt('C', 'A', null, 'three_month_followup', options(both)), /^Follow-up script\./);
});

test('a custom opening is spoken as written, with no rules block', () => {
  const opening = buildOpeningPrompt('C', 'Ankita', null, 'review_call', options(
    scripts({ system_prompt: 'x', opening_prompt: '{{greeting}}. Kya main {{patient_name}} ji se baat kar rahi hoon?' })
  ));

  assert.match(opening, /Kya main Ankita ji se baat kar rahi hoon\?$/);
  assert.doesNotMatch(opening, /Rules that always apply/);
});

// A misspelled placeholder resolves to nothing and is read out as a gap in the
// sentence, which would only be discovered on a live call.
test('a misspelled placeholder is refused on save', () => {
  assert.equal(validateSetting('call_scripts', scripts({ system_prompt: 'Hi {{patient_name}}' })), null);

  const problem = validateSetting('call_scripts', scripts({ system_prompt: 'Hi {{patient_nam}}' }));
  assert.match(String(problem), /unknown placeholder \{\{patient_nam\}\}/);
  assert.match(String(problem), /\{\{patient_name\}\}/);
});

test('every advertised placeholder actually resolves', () => {
  const template = SCRIPT_PLACEHOLDERS.map((name) => `{{${name}}}`).join(' | ');
  assert.equal(validateSetting('call_scripts', scripts({ system_prompt: template })), null);

  const prompt = buildAgentSystemPrompt('C', 'Ankita', null, 'review_call', options(
    scripts({ system_prompt: template })
  ));
  assert.doesNotMatch(prompt, /\{\{/);
  for (const value of ['Apna Blood Centre', 'Palwal', 'Ankita', 'kal']) {
    assert.match(prompt, new RegExp(value), `placeholder did not resolve: ${value}`);
  }
});

// An opening with no script behind it greets the patient and then drops into
// the built-in flow mid-call.
test('an opening line without a script is refused', () => {
  const problem = validateSetting('call_scripts', scripts({ opening_prompt: 'Namaste.' }));
  assert.match(String(problem), /needs a script to go with it/);
});

test('an over-long script is refused', () => {
  const problem = validateSetting('call_scripts', scripts({ system_prompt: 'x'.repeat(MAX_SCRIPT_LENGTH + 1) }));
  assert.match(String(problem), new RegExp(`longer than ${MAX_SCRIPT_LENGTH}`));
});

test('the shipped default is no custom script at all', async () => {
  const store = createSettingsStore({ dbGet: async () => null, dbRun: async () => {} });
  const config = await store.get('call_scripts');

  for (const callType of ['review_call', 'three_month_followup']) {
    assert.equal(config[callType].system_prompt, '');
    assert.equal(config[callType].opening_prompt, '');
  }
});

// The built-in prompt is built by filling values in. Showing the rendered form
// in the editor would put a literal patient name, greeting and date into the
// box, and saving that would greet every patient as "Ankita" at "Good Afternoon".
test('the editor is offered the template, not a rendered sample', async () => {
  const express = require('express');
  const request = require('node:http');
  const app = express();
  app.use((req, _res, next) => { req.user = { role: 'ADMIN' }; next(); });
  app.use('/api/settings', require('../routes/settings'));

  const server = app.listen(0);
  const { port } = server.address();

  const get = (path) => new Promise((resolve, reject) => {
    request.get({ port, path }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve(JSON.parse(body)));
    }).on('error', reject);
  });

  try {
    for (const callType of ['review_call', 'three_month_followup']) {
      const built = await get(`/api/settings/scripts/builtin?call_type=${callType}`);
      const both = `${built.opening_prompt}\n${built.system_prompt}`;

      assert.match(both, /\{\{patient_name\}\}/, `${callType} lost the patient placeholder`);
      assert.match(both, /\{\{greeting\}\}/, `${callType} lost the greeting placeholder`);
      assert.match(both, /\{\{client_name\}\}/, `${callType} lost the client placeholder`);

      // The sample values must not survive into what an admin would save.
      assert.doesNotMatch(both, /\bAnkita\b/, `${callType} leaked the sample patient name`);
      assert.doesNotMatch(both, /\bGood (Morning|Afternoon|Evening)\b/, `${callType} leaked a fixed greeting`);
    }
  } finally {
    server.close();
  }
});
