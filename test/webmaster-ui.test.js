'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const read = (file) => fs.readFileSync(path.join(__dirname, '..', 'public', file), 'utf8');

test('webmaster shell exposes all required sections without export controls', () => {
  const html = read('webmaster.html');
  for (const section of ['overview', 'tenants', 'users', 'platform-team', 'integrations', 'policies', 'audit']) {
    assert.match(html, new RegExp(`data-section="${section}"`));
  }
  assert.doesNotMatch(html, /export|csv/i);
});

test('webmaster styles include accessible responsive foundations', () => {
  const css = read('webmaster.css');
  assert.match(css, /@media\s*\(max-width:\s*1024px\)/);
  assert.match(css, /@media\s*\(max-width:\s*640px\)/);
  assert.match(css, /:focus-visible/);
  assert.match(css, /prefers-reduced-motion/);
});

test('webmaster client keeps sensitive values write-only', () => {
  const source = read('webmaster.js');
  assert.match(source, /input\.value\s*=\s*''/);
  assert.doesNotMatch(source, /ciphertext|password_hash/);
});

test('webmaster client implements every management section and lifecycle actions', () => {
  const source = read('webmaster.js');
  for (const handler of ['renderTenants', 'renderUsers', 'renderPlatformTeam', 'renderIntegrations', 'renderPolicies', 'renderAudit']) assert.match(source, new RegExp(`function\\s+${handler}`));
  for (const transition of ['suspend', 'archive', 'restore']) assert.match(source, new RegExp(transition));
  assert.match(source, /data-owner-only/);
  assert.doesNotMatch(source, /deleteTenant|deleteUser|method:\s*['"]DELETE/i);
});

test('integration controls show metadata and clear write-only secret inputs', () => {
  const source = read('webmaster.js');
  assert.match(source, /configured/);
  assert.match(source, /secretInput\.value\s*=\s*''/);
  assert.doesNotMatch(source, /secret\.(value|ciphertext|suffix)/);
});

test('tenant and user estate views use server pagination and reset filtered pages', () => {
  const source = read('webmaster.js');
  assert.match(source, /tenantPage/);
  assert.match(source, /userPage/);
  assert.match(source, /tenant-page:next/);
  assert.match(source, /user-page:next/);
  assert.match(source, /pageSize:\s*'25'/);
});
