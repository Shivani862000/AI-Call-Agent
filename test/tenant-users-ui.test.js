'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { PROTECTED_HTML_PATHS } = require('../src/auth');

const publicFile = name => fs.readFileSync(path.join(__dirname, '..', 'public', name), 'utf8');

test('tenant user page exposes filters, results, and management dialogs', () => {
  const html = publicFile('users.html');
  for (const id of [
    'userSearch', 'userRoleFilter', 'userStatusFilter', 'userResults',
    'userFormModal', 'userPasswordModal', 'userLifecycleModal'
  ]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(html, /users\.css/);
  assert.match(html, /app-shell\.js/);
  assert.match(html, /users\.js/);
});

test('tenant user client uses scoped APIs and optimistic versions without rendering credentials', () => {
  const source = publicFile('users.js');
  assert.match(source, /\/api\/users/);
  assert.match(source, /expectedVersion/);
  assert.match(source, /CLIENT_ADMIN/);
  assert.match(source, /CLIENT_AGENT/);
  assert.match(source, /escapeHtml/);
  assert.match(source, /session\.username/);
  assert.doesNotMatch(source, /password_hash|innerHTML\s*=.*password/i);
});

test('tenant user styles include responsive and accessible foundations', () => {
  const css = publicFile('users.css');
  assert.match(css, /@media\s*\(max-width:\s*720px\)/);
  assert.match(css, /:focus-visible/);
  assert.match(css, /prefers-reduced-motion/);
});

test('tenant user page is protected and navigation is client-admin gated', () => {
  assert.ok(PROTECTED_HTML_PATHS.has('/users.html'));
  const source = publicFile('app-shell.js');
  assert.match(source, /session\.role\s*===\s*['"]CLIENT_ADMIN['"]/);
  assert.match(source, /href:\s*['"]\/users\.html['"]/);
  assert.match(source, /addTenantUserNavigation/);
});
