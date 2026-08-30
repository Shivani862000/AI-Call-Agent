'use strict';

const express = require('express');
const bcrypt = require('bcrypt');
const { dbAll, dbGet, dbRun, dbTx } = require('../db');
const logger = require('../services/system-logger');
const { invalidateAccountCache } = require('../src/auth');
const {
  normalizeRole,
  validatePassword,
  validateUsername,
  checkAdminSafety
} = require('../src/user-rules');

const BCRYPT_COST = 12;

// password_hash is never in this list. It must not leave the server.
const PUBLIC_COLUMNS = 'id, username, role, is_active, created_at, updated_at, last_login_at, created_by';

const router = express.Router();

function actorOf(req) {
  return req.adminSession || {};
}

/** Resolves the signed-in user's row; sessions carry a username, not an id. */
async function loadActor(req) {
  return dbGet(
    `SELECT id, username, role, is_active FROM users WHERE lower(username) = lower(?)`,
    [String(actorOf(req).username || '')]
  );
}

async function countActiveAdmins(query = dbGet) {
  const row = await query("SELECT COUNT(*) AS count FROM users WHERE role = 'ADMIN' AND is_active = 1");
  return Number(row?.count || 0);
}

// ── List ───────────────────────────────────────────────────────────────────────

router.get('/', async (req, res, next) => {
  try {
    const users = await dbAll(`SELECT ${PUBLIC_COLUMNS} FROM users ORDER BY role ASC, username ASC`);
    res.json({ users });
  } catch (error) { next(error); }
});

// ── Create ─────────────────────────────────────────────────────────────────────

router.post('/', async (req, res, next) => {
  try {
    const username = String(req.body.username || '').trim();
    const role = normalizeRole(req.body.role);
    const fieldErrors = {};

    const usernameIssue = validateUsername(username);
    if (usernameIssue) fieldErrors.username = usernameIssue;
    const passwordIssue = validatePassword(req.body.password);
    if (passwordIssue) fieldErrors.password = passwordIssue;
    if (!role) fieldErrors.role = 'Role must be ADMIN or AGENT';

    if (Object.keys(fieldErrors).length > 0) {
      return res.status(400).json({ error: 'Please fix the highlighted fields', fieldErrors });
    }

    const hash = await bcrypt.hash(String(req.body.password), BCRYPT_COST);
    const created = await dbRun(
      `INSERT INTO users (username, password_hash, role, created_by) VALUES (?, ?, ?, ?)`,
      [username, hash, role, actorOf(req).username || null]
    );

    logger.info('USER_CREATED', { user: username, role, by: actorOf(req).username });
    res.status(201).json({ user: await dbGet(`SELECT ${PUBLIC_COLUMNS} FROM users WHERE id = ?`, [created.lastID]) });
  } catch (error) {
    if (error.code === '23505') {
      return res.status(409).json({
        error: 'That username already exists',
        fieldErrors: { username: 'Already taken' }
      });
    }
    next(error);
  }
});

// ── Update: role, active state, or an admin-issued password reset ──────────────

router.patch('/:id', async (req, res, next) => {
  try {
    const actor = await loadActor(req);
    const targetId = Number(req.params.id);

    const result = await dbTx(async (tx) => {
      // FOR UPDATE so a concurrent demotion cannot slip past the last-admin
      // check between the count and the write.
      const target = await tx.get(
        'SELECT id, username, role, is_active FROM users WHERE id = ? FOR UPDATE', [targetId]
      );
      const adminCount = await countActiveAdmins(tx.get);

      const change = {};
      if (req.body.role !== undefined) {
        change.role = normalizeRole(req.body.role);
        if (!change.role) return { status: 400, body: { error: 'Role must be ADMIN or AGENT' } };
      }
      if (req.body.isActive !== undefined) change.isActive = Boolean(req.body.isActive);

      const blocked = checkAdminSafety({ actor, target, change, activeAdminCount: adminCount });
      if (blocked) return { status: blocked === 'User not found' ? 404 : 409, body: { error: blocked } };

      const sets = [];
      const params = [];
      if (change.role) { sets.push('role = ?'); params.push(change.role); }
      if (change.isActive !== undefined) { sets.push('is_active = ?'); params.push(change.isActive ? 1 : 0); }

      if (req.body.password !== undefined) {
        const issue = validatePassword(req.body.password);
        if (issue) return { status: 400, body: { error: issue, fieldErrors: { password: issue } } };
        sets.push('password_hash = ?');
        params.push(await bcrypt.hash(String(req.body.password), BCRYPT_COST));
      }

      if (sets.length === 0) return { status: 400, body: { error: 'Nothing to update' } };

      sets.push('updated_at = now()');
      params.push(targetId);
      await tx.run(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, params);

      return {
        status: 200,
        body: { user: await tx.get(`SELECT ${PUBLIC_COLUMNS} FROM users WHERE id = ?`, [targetId]) },
        audit: { target: target.username, change, passwordReset: req.body.password !== undefined }
      };
    });

    if (result.audit) {
      invalidateAccountCache(result.audit.target);
      logger.warn('USER_UPDATED', {
        user: result.audit.target,
        by: actorOf(req).username,
        role: result.audit.change.role,
        active: result.audit.change.isActive,
        passwordReset: result.audit.passwordReset
      });
    }
    res.status(result.status).json(result.body);
  } catch (error) { next(error); }
});

// ── Delete ─────────────────────────────────────────────────────────────────────

router.delete('/:id', async (req, res, next) => {
  try {
    const actor = await loadActor(req);
    const targetId = Number(req.params.id);

    const result = await dbTx(async (tx) => {
      const target = await tx.get(
        'SELECT id, username, role, is_active FROM users WHERE id = ? FOR UPDATE', [targetId]
      );
      const adminCount = await countActiveAdmins(tx.get);

      const blocked = checkAdminSafety({ actor, target, change: { deleting: true }, activeAdminCount: adminCount });
      if (blocked) return { status: blocked === 'User not found' ? 404 : 409, body: { error: blocked } };

      await tx.run('DELETE FROM users WHERE id = ?', [targetId]);
      return { status: 200, body: { success: true }, audit: target.username };
    });

    if (result.audit) {
      invalidateAccountCache(result.audit);
      logger.warn('USER_DELETED', { user: result.audit, by: actorOf(req).username });
    }
    res.status(result.status).json(result.body);
  } catch (error) { next(error); }
});

module.exports = router;
