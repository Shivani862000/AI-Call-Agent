'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const shell = fs.readFileSync('public/app-shell.js', 'utf8');
const styles = fs.readFileSync('public/app-shell.css', 'utf8');

test('shared scheduling modal uses native keyboard controls and focus containment', () => {
  assert.match(shell, /<button id="\$\{ids\.existingPatientBtn\}"[^>]*type="button">/);
  assert.match(shell, /<button id="\$\{ids\.newPatientBtn\}"[^>]*type="button">/);
  assert.match(shell, /class="saas-call-type-radio visually-hidden" type="radio"/);
  assert.doesNotMatch(shell, /input type="radio"[^>]*style="display:none;"/);
  assert.match(shell, /function onModalKeydown\(event\)/);
  assert.match(shell, /previousFocus && document\.contains\(previousFocus\)/);
  assert.match(styles, /\.saas-campaign-card:focus-within/);
  assert.match(styles, /\.visually-hidden/);
});
