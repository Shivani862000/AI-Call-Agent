/**
 * src/auth.js
 * Cookie-based authentication, session management, and role middleware.
 */

'use strict';

const crypto = require('crypto');
const bcrypt = require('bcrypt');
const { supabase } = require('./supabase'); // Supabase client

// ── Constants ──────────────────────────────────────────────────────────────────

const PROTECTED_HTML_PATHS = new Set([
  '/admin.html',
  '/customer-list.html',
  '/webmaster.html',
  '/support-tickets.html',
  '/incoming-calls.html',
  '/customers.html',
  '/users.html',
  '/clients.html',
  '/feedback.html',
  '/feedback-analysis.html',
  '/reports.html'
]);

const VALID_ROLES = new Set(['WEBMASTER', 'SUPPORT_TEAM', 'CLIENT_ADMIN', 'CLIENT_AGENT']);
const AUTH_SOURCES = new Set(['database', 'environment']);
const AUTH_COOKIE_NAME = 'feedback_admin_session';
const AUTH_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const AUTH_SESSION_MAX_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const AUTH_CLOCK_SKEW_MS = 60 * 1000;
const CONFIGURED_AUTH_SIGNING_SECRET = String(process.env.AUTH_SIGNING_SECRET || '').trim();
const AUTH_SIGNING_SECRET = CONFIGURED_AUTH_SIGNING_SECRET
  ? Buffer.from(CONFIGURED_AUTH_SIGNING_SECRET, 'utf8')
  : crypto.randomBytes(32);

function getAuthConfigurationIssues(env = process.env) {
  const isProduction = String(env.NODE_ENV || '').toLowerCase() === 'production';
  const signingSecret = String(env.AUTH_SIGNING_SECRET || '').trim();
  const issues = [];

  if (isProduction && !signingSecret) {
    issues.push('AUTH_SIGNING_SECRET is required in production');
  }

  if (signingSecret && Buffer.byteLength(signingSecret, 'utf8') < 32) {
    issues.push('AUTH_SIGNING_SECRET must contain at least 32 bytes');
  }

  const reusedSecrets = [
    env.SESSION_SECRET,
    env.ICALLMATE_UKEY,
    env.GEMINI_API_KEY,
    env.GOOGLE_API_KEY,
    env.DEEPGRAM_API_KEY
  ]
    .map((value) => String(value || '').trim())
    .filter(Boolean);
  if (signingSecret && reusedSecrets.includes(signingSecret)) {
    issues.push('AUTH_SIGNING_SECRET must not reuse a provider or legacy session secret');
  }

  return issues;
}

function validateAuthConfig() {
  const issues = getAuthConfigurationIssues();
  if (issues.length > 0) {
    throw new Error(`Invalid authentication configuration: ${issues.join('; ')}`);
  }

  if (!CONFIGURED_AUTH_SIGNING_SECRET) {
    console.warn('[AUTH] AUTH_SIGNING_SECRET is not set; using an ephemeral development secret.');
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
      try {
        accumulator[key] = decodeURIComponent(value);
      } catch (error) {
        accumulator[key] = value;
      }
    }
    return accumulator;
  }, {});
}

function normalizeRole(role) {
  const normalized = String(role || '').trim().toUpperCase();
  return VALID_ROLES.has(normalized) ? normalized : null;
}

// ── Token signing & creation ───────────────────────────────────────────────────

function signAuthValue(value) {
  return crypto.createHmac('sha256', AUTH_SIGNING_SECRET).update(value).digest();
}

function createAuthToken(username, role, tenantId = null, authSource = 'database', options = {}) {
  const normalizedUsername = String(username || '').trim();
  const normalizedRole = normalizeRole(role);
  if (
    !normalizedUsername
    || normalizedUsername.length > 100
    || !normalizedRole
    || !AUTH_SOURCES.has(authSource)
  ) {
    throw new Error('Cannot create a session for an invalid user or role');
  }

  const issuedAt = Date.now();
  const requestedTtl = Number(options.ttlMs);
  const ttlMs = Number.isFinite(requestedTtl)
    ? Math.min(AUTH_SESSION_MAX_TTL_MS, Math.max(5 * 60 * 1000, requestedTtl))
    : AUTH_SESSION_TTL_MS;
  const payload = Buffer.from(JSON.stringify({
    version: 3,
    username: normalizedUsername,
    role: normalizedRole,
    tenantId: tenantId ? tenantId.toString() : null,
    authSource,
    issuedAt,
    exp: issuedAt + ttlMs,
    nonce: crypto.randomBytes(16).toString('base64url')
  })).toString('base64url');
  const signature = signAuthValue(payload).toString('base64url');
  return `${payload}.${signature}`;
}

// ── Session reading ────────────────────────────────────────────────────────────

function readAuthSession(req) {
  const cookies = parseCookies(req);
  const token = cookies[AUTH_COOKIE_NAME];
  if (!token) {
    return null;
  }

  const tokenParts = token.split('.');
  if (tokenParts.length !== 2) {
    return null;
  }

  const [payload, signature] = tokenParts;
  if (!/^[A-Za-z0-9_-]+$/.test(payload) || !/^[A-Za-z0-9_-]+$/.test(signature)) {
    return null;
  }

  const suppliedSignature = Buffer.from(signature, 'base64url');
  const expectedSignature = signAuthValue(payload);
  if (
    suppliedSignature.length !== expectedSignature.length
    || !crypto.timingSafeEqual(suppliedSignature, expectedSignature)
  ) {
    return null;
  }

  try {
    const session = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    const now = Date.now();
    const role = normalizeRole(session?.role);
    const username = String(session?.username || '').trim();
    const issuedAt = Number(session?.issuedAt);
    const expiresAt = Number(session?.exp);
    const tenantId = session?.tenantId || null;
    const authSource = String(session?.authSource || '');
    const validLifetime = expiresAt > issuedAt && expiresAt - issuedAt <= AUTH_SESSION_MAX_TTL_MS;

    if (
      !username
      || username.length > 100
      || session?.version !== 3
      || !role
      || !AUTH_SOURCES.has(authSource)
      || !Number.isFinite(issuedAt)
      || !Number.isFinite(expiresAt)
      || issuedAt > now + AUTH_CLOCK_SKEW_MS
      || expiresAt <= now
      || !validLifetime
      || !/^[A-Za-z0-9_-]{20,}$/.test(String(session?.nonce || ''))
    ) {
      return null;
    }

    return { username, role, tenantId, authSource, issuedAt, exp: expiresAt };
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

function setAuthCookie(req, res, token, options = {}) {
  const isSecure = shouldUseSecureCookie(req);
  const requestedTtl = Number(options.ttlMs);
  const ttlMs = Number.isFinite(requestedTtl)
    ? Math.min(AUTH_SESSION_MAX_TTL_MS, Math.max(5 * 60 * 1000, requestedTtl))
    : AUTH_SESSION_TTL_MS;
  const cookieParts = [
    `${AUTH_COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(ttlMs / 1000)}`
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

function getSharedMediaToken() {
  return String(process.env.ICALLMATE_MEDIA_SHARED_SECRET || '').trim();
}

function createMediaToken(options = {}) {
  if (options.reusable) {
    const sharedToken = getSharedMediaToken();
    if (Buffer.byteLength(sharedToken, 'utf8') < 32) {
      throw new Error('ICALLMATE_MEDIA_SHARED_SECRET must contain at least 32 bytes');
    }
    return sharedToken;
  }

  const token = crypto.randomBytes(16).toString('hex');
  validMediaTokens.add(token);
  const expiryTimer = setTimeout(() => validMediaTokens.delete(token), 3600000);
  expiryTimer.unref?.();
  return token;
}

function validateMediaToken(token) {
  const suppliedToken = String(token || '');
  const sharedToken = getSharedMediaToken();
  if (sharedToken && suppliedToken) {
    const suppliedBuffer = Buffer.from(suppliedToken, 'utf8');
    const sharedBuffer = Buffer.from(sharedToken, 'utf8');
    if (
      suppliedBuffer.length === sharedBuffer.length
      && crypto.timingSafeEqual(suppliedBuffer, sharedBuffer)
    ) {
      return true;
    }
  }

  if (validMediaTokens.has(token)) {
    validMediaTokens.delete(token);
    return true;
  }
  return false;
}

function requireAdminAuth(req, res, next) {
  const session = readAuthSession(req);
  if (!session) {
    if (req.path.startsWith('/api/') || req.path === '/call/start') {
      return res.status(401).json({ error: 'Authentication required' });
    }

    return res.redirect('/login.html');
  }

  return resolveActiveSession(session)
    .then((activeSession) => {
      if (!activeSession) {
        if (req.path.startsWith('/api/') || req.path === '/call/start') {
          return res.status(401).json({ error: 'Authentication required' });
        }
        return res.redirect('/login.html');
      }
      req.adminSession = activeSession;
      return next();
    })
    .catch(() => {
      if (req.path.startsWith('/api/') || req.path === '/call/start') {
        return res.status(401).json({ error: 'Authentication required' });
      }
      return res.redirect('/login.html');
    });
}

function isTenantRole(role) {
  return role === 'CLIENT_ADMIN' || role === 'CLIENT_AGENT';
}

async function loadActiveTenant(tenantId) {
  if (!tenantId) {
    return null;
  }
  const { data: tenant } = await supabase.from('tenants').select('*').eq('id', tenantId).single();
  return tenant?.status === 'active' ? tenant : null;
}

async function resolveActiveSession(session) {
  if (!session) {
    return null;
  }

  if (session.authSource !== 'database') {
    return null;
  }

  const { data: user } = await supabase.from('users').select('*').eq('username', session.username).single();
  const role = normalizeRole(user?.role);
  if (!user || user.status !== 'active' || role !== session.role) {
    return null;
  }
  if (isTenantRole(role) && !(await loadActiveTenant(user.tenant_id))) {
    return null;
  }

  return {
    ...session,
    tenantId: user.tenant_id ? String(user.tenant_id) : null,
    ...(role === 'WEBMASTER' ? { platformAccessLevel: user.platform_access_level || null } : {})
  };
}

function requireRole(...allowedRoles) {
  const normalizedRoles = new Set(allowedRoles.map(normalizeRole).filter(Boolean));
  return (req, res, next) => {
    const role = normalizeRole(req.adminSession?.role);
    if (role && normalizedRoles.has(role)) {
      return next();
    }

    if (req.path.startsWith('/api/') || req.path === '/call/start') {
      return res.status(403).json({ error: 'Forbidden: Insufficient role' });
    }

    return res.status(403).send('Forbidden: You do not have access to this page.');
  };
}

async function requireTenantAccess(req, res, next) {
  const session = req.adminSession;
  if (!session) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  if (session.role === 'WEBMASTER' || session.role === 'SUPPORT_TEAM') {
    const requestedTenantId = req.query?.tenantId || req.body?.tenantId;
    if (!requestedTenantId || !(await loadActiveTenant(requestedTenantId))) {
      return res.status(403).json({ error: 'Forbidden: An active tenant context is required' });
    }
    req.tenantId = requestedTenantId;
    return next();
  }

  if (session.tenantId && await loadActiveTenant(session.tenantId)) {
    // Inject tenantId into req for easy filtering in downstream controllers
    req.tenantId = session.tenantId;
    return next();
  }

  return res.status(403).json({ error: 'Forbidden: No tenant context' });
}

async function verifyCredentials(username, password) {
  const normalizedUsername = String(username || '').trim();
  if (!normalizedUsername || !password) {
    return { success: false };
  }

  try {
    const normalizedEmail = normalizedUsername.toLowerCase();
    
    // Check by username or email
    let { data: user } = await supabase.from('users').select('*').or(`username.eq.${normalizedUsername},email.eq.${normalizedEmail}`).maybeSingle();
    
    const role = normalizeRole(user?.role);
    if (
      user?.status === 'active'
      && user?.password_hash
      && role
      && await bcrypt.compare(String(password), user.password_hash)
    ) {
      if (isTenantRole(role) && !(await loadActiveTenant(user.tenant_id))) {
        return { success: false };
      }
      if (role === 'WEBMASTER' && !['OWNER', 'ADMIN'].includes(user.platform_access_level)) {
        return { success: false };
      }
      return {
        success: true,
        username: user.username,
        role,
        tenantId: user.tenant_id || null,
        authSource: 'database',
        ...(role === 'WEBMASTER' ? { platformAccessLevel: user.platform_access_level } : {})
      };
    }
    return { success: false };
  } catch (error) {
    return { success: false };
  }
}

async function basicAuth(req, res, next) {
  const authorization = String(req.headers.authorization || '');
  const match = authorization.match(/^Basic\s+(.+)$/i);
  let login = '';
  let password = '';

  if (match) {
    const decoded = Buffer.from(match[1], 'base64').toString('utf8');
    const separatorIndex = decoded.indexOf(':');
    if (separatorIndex !== -1) {
      login = decoded.slice(0, separatorIndex);
      password = decoded.slice(separatorIndex + 1);
    }
  }

  const authResult = await verifyCredentials(login, password);
  if (authResult.success) {
    req.adminSession = {
      username: authResult.username,
      role: authResult.role,
      tenantId: authResult.tenantId,
      authSource: authResult.authSource,
      ...(authResult.role === 'WEBMASTER' ? { platformAccessLevel: authResult.platformAccessLevel } : {})
    };
    return next();
  }

  res.setHeader('WWW-Authenticate', 'Basic realm="Restricted Area"');
  return res.status(401).send('Authentication required');
}

module.exports = {
  PROTECTED_HTML_PATHS,
  VALID_ROLES,
  AUTH_COOKIE_NAME,
  AUTH_SESSION_TTL_MS,
  getAuthConfigurationIssues,
  validateAuthConfig,
  parseCookies,
  createAuthToken,
  readAuthSession,
  resolveActiveSession,
  setAuthCookie,
  clearAuthCookie,
  requireAdminAuth,
  requireRole,
  requireTenantAccess,
  basicAuth,
  verifyCredentials,
  createMediaToken,
  validateMediaToken
};
