/**
 * src/auth.js
 * Cookie-based authentication, session management, and admin middleware.
 */

'use strict';

const crypto = require('crypto');
const bcrypt = require('bcrypt');

// ── Constants ──────────────────────────────────────────────────────────────────

const PROTECTED_HTML_PATHS = new Set([
  '/admin.html',
  '/incoming-calls.html',
  '/customers.html',
  '/clients.html',
  '/feedback.html',
  '/feedback-analysis.html',
  '/reports.html'
]);

const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH || '$2b$10$Gl3xR8zUgWQfsseWE63q3e4JBUoU4pZCPpvjSn9ENt0ZHA7rYR4Zm';
const AUTH_COOKIE_NAME = 'feedback_admin_session';
const AUTH_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const AUTH_SIGNING_SECRET = process.env.AUTH_SIGNING_SECRET || process.env.SESSION_SECRET || process.env.ICALLMATE_UKEY || 'feedback-admin-auth-secret';

if (process.env.NODE_ENV === 'production') {
  if (!AUTH_SIGNING_SECRET || AUTH_SIGNING_SECRET.length < 16) {
    console.error('FATAL ERROR: AUTH_SIGNING_SECRET is missing or too short for production environment. Must be at least 16 characters.');
    process.exit(1);
  }
}

// ── Cookie parsing ─────────────────────────────────────────────────────────────

function parseCookies(req) {
  const header = String(req.headers.cookie || '');
  if (!header) {
    return {};
  }

  return header.split(';').reduce((accumulator, item) => {
    const separatorIndex = item.indexOf('=');
    if (separatorIndex === -1) {
      return accumulator;
    }

    const key = item.slice(0, separatorIndex).trim();
    const value = item.slice(separatorIndex + 1).trim();
    if (key) {
      accumulator[key] = decodeURIComponent(value);
    }
    return accumulator;
  }, {});
}

// ── Token signing & creation ───────────────────────────────────────────────────

function signAuthValue(value) {
  return crypto.createHmac('sha256', AUTH_SIGNING_SECRET).update(value).digest('base64url');
}

function createAuthToken(username, role = 'ADMIN') {
  const payload = Buffer.from(JSON.stringify({
    username,
    role,
    exp: Date.now() + AUTH_SESSION_TTL_MS
  })).toString('base64url');
  const signature = signAuthValue(payload);
  return `${payload}.${signature}`;
}

// ── Session reading ────────────────────────────────────────────────────────────

function readAuthSession(req) {
  const cookies = parseCookies(req);
  const token = cookies[AUTH_COOKIE_NAME];
  if (!token) {
    return null;
  }

  const [payload, signature] = token.split('.');
  if (!payload || !signature) {
    return null;
  }

  const expectedSignature = signAuthValue(payload);
  const signatureBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expectedSignature);
  if (
    signatureBuffer.length !== expectedBuffer.length
    || !crypto.timingSafeEqual(signatureBuffer, expectedBuffer)
  ) {
    return null;
  }

  try {
    const session = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!session?.username || !session?.exp || session.exp < Date.now()) {
      return null;
    }
    if (!session.role) {
      session.role = 'ADMIN';
    }
    return session;
  } catch (error) {
    return null;
  }
}

// ── Cookie management ──────────────────────────────────────────────────────────

function shouldUseSecureCookie(req) {
  if (!req) {
    return false;
  }

  if (req.secure) {
    return true;
  }

  const forwardedProto = String(req.headers['x-forwarded-proto'] || '')
    .split(',')[0]
    .trim()
    .toLowerCase();

  return forwardedProto === 'https';
}

function setAuthCookie(req, res, token) {
  const isSecure = shouldUseSecureCookie(req);
  const cookieParts = [
    `${AUTH_COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(AUTH_SESSION_TTL_MS / 1000)}`
  ];

  if (isSecure) {
    cookieParts.push('Secure');
  }

  res.setHeader('Set-Cookie', cookieParts.join('; '));
}

function clearAuthCookie(req, res) {
  const isSecure = shouldUseSecureCookie(req);
  const cookieParts = [
    `${AUTH_COOKIE_NAME}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=0'
  ];

  if (isSecure) {
    cookieParts.push('Secure');
  }

  res.setHeader('Set-Cookie', cookieParts.join('; '));
}

// ── Middleware ──────────────────────────────────────────────────────────────────

const validMediaTokens = new Set();

function createMediaToken() {
  const token = crypto.randomBytes(16).toString('hex');
  validMediaTokens.add(token);
  setTimeout(() => validMediaTokens.delete(token), 3600000);
  return token;
}

function validateMediaToken(token) {
  if (validMediaTokens.has(token)) {
    validMediaTokens.delete(token);
    return true;
  }
  return false;
}

function requireAdminAuth(req, res, next) {
  const session = readAuthSession(req);
  if (session) {
    req.adminSession = session;
    return next();
  }

  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  return res.redirect('/login.html');
}

async function verifyCredentials(username, password) {
  const { dbGet } = require('../db');
  try {
    const user = await dbGet('SELECT * FROM users WHERE username = ?', [username]);
    if (user && bcrypt.compareSync(password, user.password_hash)) {
      return { success: true, role: user.role };
    }
    // Fallback to env for safety
    if (username === ADMIN_USERNAME && bcrypt.compareSync(password, ADMIN_PASSWORD_HASH)) {
      return { success: true, role: 'ADMIN' };
    }
    return { success: false };
  } catch (err) {
    if (username === ADMIN_USERNAME && bcrypt.compareSync(password, ADMIN_PASSWORD_HASH)) {
      return { success: true, role: 'ADMIN' };
    }
    return { success: false };
  }
}

async function basicAuth(req, res, next) {
  const b64auth = (req.headers.authorization || '').split(' ')[1] || '';
  const [login, password] = Buffer.from(b64auth, 'base64').toString().split(':');

  const authResult = await verifyCredentials(login, password);
  if (authResult.success) {
    req.adminSession = { username: login, role: authResult.role };
    return next();
  }

  res.setHeader('WWW-Authenticate', 'Basic realm="Restricted Area"');
  res.status(401).send('Authentication required');
}

module.exports = {
  PROTECTED_HTML_PATHS,
  ADMIN_USERNAME,
  parseCookies,
  createAuthToken,
  readAuthSession,
  setAuthCookie,
  clearAuthCookie,
  requireAdminAuth,
  basicAuth,
  verifyCredentials,
  createMediaToken,
  validateMediaToken
};
