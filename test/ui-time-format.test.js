'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const publicFile = (name) => fs.readFileSync(path.join(__dirname, '..', 'public', name), 'utf8');

/**
 * Runs app-shell.js against a stub window so its formatters can be exercised
 * for real rather than grepped for.
 */
function loadAppShell() {
  const noop = () => {};
  const element = new Proxy({}, {
    get: (target, prop) => (prop in target ? target[prop] : (prop === 'style' || prop === 'classList' || prop === 'dataset' ? {} : noop)),
    set: () => true
  });
  const sandbox = {
    window: { location: { origin: 'https://example.test', pathname: '/admin.html', search: '' }, addEventListener: noop },
    document: {
      addEventListener: noop,
      querySelector: () => null,
      querySelectorAll: () => [],
      getElementById: () => null,
      createElement: () => element,
      body: element,
      documentElement: element
    },
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    navigator: { userAgent: 'node' },
    console,
    setTimeout,
    clearTimeout,
    fetch: noop
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(publicFile('app-shell.js'), sandbox, { filename: 'app-shell.js' });
  return sandbox.window.AppShell;
}

const HAS_MERIDIEM = /\b(AM|PM|am|pm)\b/;

test('formatDateTime shows whether a time is AM or PM', () => {
  const AppShell = loadAppShell();
  assert.match(AppShell.formatDateTime('2026-09-08T13:12:00.000Z'), HAS_MERIDIEM);
  assert.match(AppShell.formatDateTime('2026-09-08T01:12:00.000Z'), HAS_MERIDIEM);
});

test('formatDateTime does not depend on the viewer browser locale for that', () => {
  // toLocaleTimeString([]) follows the browser locale: en-GB viewers saw 24h
  // and en-US viewers saw AM/PM, from the same build.
  const shell = publicFile('app-shell.js');
  assert.doesNotMatch(shell, /toLocaleTimeString\(\[\], \{ hour: '2-digit', minute: '2-digit' \}\)/);
  assert.match(shell, /hour12: true/);
});

test('a time input still receives a 24-hour value', () => {
  // <input type="time"> takes HH:MM regardless of what it displays; an AM/PM
  // string there silently fails to populate the field.
  const shell = publicFile('app-shell.js');
  assert.match(shell, /time: `\$\{String\(parsed\.getHours\(\)\)\.padStart\(2, '0'\)\}:\$\{String\(parsed\.getMinutes\(\)\)\.padStart\(2, '0'\)\}`/);
});

test('the users list shows AM/PM on last sign-in', () => {
  assert.match(publicFile('users.html'), /hour12: true/);
});

test('transcript timestamps show AM/PM', () => {
  assert.match(publicFile('feedback-analysis.html'), /hour12: true/);
});

test('the customers page has no hand-rolled 24-hour clock strings', () => {
  // Three places built "HH:MM" from getHours()/getMinutes(), which can never
  // show a meridiem.
  const customers = publicFile('customers.html');
  assert.doesNotMatch(customers, /String\((?:date|dateVal)\.getHours\(\)\)\.padStart/);
});

test('formatTime also handles a bare HH:MM slot string', () => {
  // preferred_slot is stored as "10:00" / "16:30" and was rendered raw, so a
  // best-time-to-call of 16:30 never showed a meridiem.
  const AppShell = loadAppShell();
  assert.match(AppShell.formatTime('16:30'), /4:30\s*PM/i);
  assert.match(AppShell.formatTime('10:00'), /10:00\s*AM/i);
  assert.strictEqual(AppShell.formatTime(''), '');
});

test('the customers page formats the preferred slot instead of printing it raw', () => {
  assert.doesNotMatch(publicFile('customers.html'), /return customer\.preferred_slot;/);
});
