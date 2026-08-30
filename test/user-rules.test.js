'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { checkAdminSafety, validatePassword, validateUsername, normalizeRole } = require('../src/user-rules');

const admin = { id: 1, role: 'ADMIN', is_active: 1 };
const otherAdmin = { id: 2, role: 'ADMIN', is_active: 1 };
const agent = { id: 3, role: 'AGENT', is_active: 1 };

test('you cannot delete or deactivate yourself', () => {
  assert.match(checkAdminSafety({ actor: admin, target: admin, change: { deleting: true }, activeAdminCount: 5 }), /own account/);
  assert.match(checkAdminSafety({ actor: admin, target: admin, change: { isActive: false }, activeAdminCount: 5 }), /own account/);
});

test('you cannot demote yourself out of admin', () => {
  assert.match(checkAdminSafety({ actor: admin, target: admin, change: { role: 'AGENT' }, activeAdminCount: 5 }), /own admin role/);
});

test('the last active admin cannot be removed by any route', () => {
  for (const change of [{ deleting: true }, { isActive: false }, { role: 'AGENT' }]) {
    assert.match(
      checkAdminSafety({ actor: otherAdmin, target: admin, change, activeAdminCount: 1 }),
      /last active admin/,
      `change ${JSON.stringify(change)} must be blocked`
    );
  }
});

test('removing an admin is fine when another remains', () => {
  assert.strictEqual(checkAdminSafety({ actor: otherAdmin, target: admin, change: { deleting: true }, activeAdminCount: 2 }), null);
});

test('agents are never protected by the last-admin rule', () => {
  assert.strictEqual(checkAdminSafety({ actor: admin, target: agent, change: { deleting: true }, activeAdminCount: 1 }), null);
});

test('an already-inactive admin does not count as the last one', () => {
  const inactive = { id: 4, role: 'ADMIN', is_active: 0 };
  assert.strictEqual(checkAdminSafety({ actor: admin, target: inactive, change: { deleting: true }, activeAdminCount: 1 }), null);
});

test('a missing target is reported, not crashed on', () => {
  assert.match(checkAdminSafety({ actor: admin, target: null, change: {}, activeAdminCount: 2 }), /not found/);
});

test('password rules reject the trivial and accept a passphrase', () => {
  assert.match(validatePassword('short'), /at least 12/);
  assert.match(validatePassword('aaaaaaaaaaaaaaa'), /repeated character/);
  assert.strictEqual(validatePassword('correct horse battery staple'), null);
  assert.strictEqual(validatePassword('zBXt4echQ=jmFdjdBSd^nRKz'), null);
});

test('username rules', () => {
  assert.match(validateUsername('ab'), /at least 3/);
  assert.match(validateUsername('has space'), /spaces/);
  assert.strictEqual(validateUsername('vikrant@vikitechsolutions.in'), null);
});

test('roles normalize case and reject anything else', () => {
  assert.strictEqual(normalizeRole('admin'), 'ADMIN');
  assert.strictEqual(normalizeRole('AGENT'), 'AGENT');
  assert.strictEqual(normalizeRole('superuser'), null);
});
