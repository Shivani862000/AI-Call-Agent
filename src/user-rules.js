'use strict';

/**
 * Validation and safety rules for user administration.
 *
 * Pure functions, no I/O, so the lockout guards can be tested directly — they
 * are the part where a mistake locks everyone out of the application.
 */

const VALID_ROLES = new Set(['ADMIN', 'AGENT']);
const MIN_PASSWORD_LENGTH = 12;
const MAX_PASSWORD_LENGTH = 200;

function normalizeRole(value) {
  const role = String(value || '').trim().toUpperCase();
  return VALID_ROLES.has(role) ? role : null;
}

/** Returns a problem description, or null when the password is acceptable. */
function validatePassword(value) {
  const password = String(value == null ? '' : value);
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters`;
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    return `Password must be ${MAX_PASSWORD_LENGTH} characters or fewer`;
  }
  // Length is the property that matters most; a long passphrase should not be
  // rejected for lacking a symbol. Only reject the genuinely trivial.
  if (/^(.)\1+$/.test(password)) {
    return 'Password must not be a single repeated character';
  }
  return null;
}

/** Returns a problem description, or null when the username is acceptable. */
function validateUsername(value) {
  const username = String(value || '').trim();
  if (username.length < 3) return 'Username must be at least 3 characters';
  if (username.length > 100) return 'Username must be 100 characters or fewer';
  if (/\s/.test(username)) return 'Username must not contain spaces';
  return null;
}

/**
 * Guards every change that could remove the last way into the application.
 *
 * `actor`  - the signed-in user making the change
 * `target` - the user being changed
 * `change` - { role, isActive, deleting }
 * `activeAdminCount` - active admins BEFORE the change
 */
function checkAdminSafety({ actor, target, change = {}, activeAdminCount }) {
  if (!target) return 'User not found';

  const isSelf = Number(actor?.id) === Number(target.id);
  const targetWasActiveAdmin = String(target.role).toUpperCase() === 'ADMIN'
    && Number(target.is_active) === 1;

  if (isSelf && change.deleting) {
    return 'You cannot delete your own account';
  }
  if (isSelf && change.isActive === false) {
    return 'You cannot deactivate your own account';
  }
  if (isSelf && change.role && change.role !== 'ADMIN') {
    return 'You cannot remove your own admin role';
  }

  // Would this change remove the last active admin?
  const losesAdmin = targetWasActiveAdmin && (
    change.deleting === true
    || change.isActive === false
    || (change.role && change.role !== 'ADMIN')
  );
  if (losesAdmin && Number(activeAdminCount) <= 1) {
    return 'This is the last active admin account; promote another admin first';
  }

  return null;
}

module.exports = {
  VALID_ROLES,
  MIN_PASSWORD_LENGTH,
  normalizeRole,
  validatePassword,
  validateUsername,
  checkAdminSafety
};
