/**
 * src/auth.js
 * Cookie-based authentication, session management, and role middleware.
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

const VALID_ROLES = new Set(['ADMIN', 'AGENT', 'WEBMASTER', 'CLIENT_ADMIN', 'SUPPORT_TEAM']);
const ADMIN_USERNAME = String(process.env.ADMIN_USERNAME || 'admin').trim();
const AUTH_COOKIE_NAME = 'sb-access-token';
const AUTH_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const AUTH_CLOCK_SKEW_MS = 60 * 1000;
const CONFIGURED_AUTH_SIGNING_SECRET = String(process.env.AUTH_SIGNING_SECRET || '').trim();
const AUTH_SIGNING_SECRET = CONFIGURED_AUTH_SIGNING_SECRET
  ? Buffer.from(CONFIGURED_AUTH_SIGNING_SECRET, 'utf8')
  : crypto.randomBytes(32);

function getAuthConfigurationIssues(env = process.env) {
  const isProduction = String(env.NODE_ENV || '').toLowerCase() === 'production';
  const username = String(env.ADMIN_USERNAME || '').trim();
  const passwordHash = String(env.ADMIN_PASSWORD_HASH || '').trim();
  const signingSecret = String(env.AUTH_SIGNING_SECRET || '').trim();
  const issues = [];

  if (isProduction && !username) {
    issues.push('ADMIN_USERNAME is required in production');
  }

  if (isProduction && !/^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/.test(passwordHash)) {
    issues.push('ADMIN_PASSWORD_HASH must be a valid bcrypt hash in production');
  }

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

function createAuthToken(username, role) {
  const normalizedUsername = String(username || '').trim();
  const normalizedRole = normalizeRole(role);
  if (!normalizedUsername || normalizedUsername.length > 100 || !normalizedRole) {
    throw new Error('Cannot create a session for an invalid user or role');
  }

  const issuedAt = Date.now();
  const payload = Buffer.from(JSON.stringify({
    version: 1,
    username: normalizedUsername,
    role: normalizedRole,
    issuedAt,
    exp: issuedAt + AUTH_SESSION_TTL_MS,
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

  try {
    const tokenParts = token.split('.');
    if (tokenParts.length !== 3) {
      return null;
    }

    const payload = tokenParts[1];
    const base64Url = payload.replace(/-/g, '+').replace(/_/g, '/');
    const jsonPayload = Buffer.from(base64Url, 'base64').toString('utf8');
    const session = JSON.parse(jsonPayload);
    
    if (session.exp && session.exp < Math.floor(Date.now() / 1000)) {
      return null;
    }

    // Attempt to parse out username and role. Note that standard Supabase 
    // doesn't have username, but we can default to email.
    return { 
      id: session.sub,
      role: normalizeRole(session.user_role || session.app_metadata?.role || session.user_metadata?.role) || 'AGENT',
      username: session.email || session.sub,
      tenantId: session.app_metadata?.tenant_id,
      exp: session.exp
    };
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
  if (session) {
    req.adminSession = session;
    return next();
  }

  if (req.path.startsWith('/api/') || req.path === '/call/start') {
    return res.status(401).json({ error: 'Authentication required' });
  }

  return res.redirect('/login.html');
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

async function verifyCredentials(login, password) {
  const normalizedLogin = String(login || '').trim();
  if (!normalizedLogin || !password) {
    return { success: false };
  }

  const { createClient } = require('@supabase/supabase-js');
  const freshSupabaseAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false }
  });

  try {
    let email = normalizedLogin;
    if (!email.includes('@')) {
      const { data: userRows, error: uErr } = await freshSupabaseAdmin
        .from('users')
        .select('email')
        .eq('username', normalizedLogin)
        .limit(1);
      if (uErr) {
        console.error('[AUTH DEBUG] Error fetching email for username:', normalizedLogin, uErr.message);
      } else if (userRows && userRows.length > 0 && userRows[0].email) {
        email = userRows[0].email;
        console.log('[AUTH DEBUG] Resolved username to email:', email);
      } else {
        console.log('[AUTH DEBUG] Username not found in public.users:', normalizedLogin);
      }
    }

    const loginClient = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
      auth: { autoRefreshToken: false, persistSession: false }
    });

    const { data, error } = await loginClient.auth.signInWithPassword({
      email,
      password
    });

    if (error || !data.user) {
      console.error('[AUTH] Supabase signIn failed:', error?.message);
      return { success: false };
    }

    const { data: userProfile, error: profileErr } = await freshSupabaseAdmin
      .from('users')
      .select('username, role, tenant_id, platform_access_level')
      .eq('id', data.user.id)
      .single();

    if (profileErr) {
      console.error('[AUTH DEBUG] Error fetching userProfile for id', data.user.id, profileErr.message);
    } else {
      console.log('[AUTH DEBUG] Fetched userProfile:', userProfile);
    }

    return {
      success: true,
      username: userProfile?.username || email,
      role: userProfile?.role || 'AGENT',
      tenantId: userProfile?.tenant_id,
      platformAccessLevel: userProfile?.platform_access_level,
      accessToken: data.session.access_token,
      refreshToken: data.session.refresh_token,
      expiresAt: data.session.expires_at
    };
  } catch (error) {
    console.error('[AUTH ERROR]', error);
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
    req.adminSession = { username: authResult.username, role: authResult.role };
    return next();
  }

  res.setHeader('WWW-Authenticate', 'Basic realm="Restricted Area"');
  return res.status(401).send('Authentication required');
}

module.exports = {
  PROTECTED_HTML_PATHS,
  VALID_ROLES,
  ADMIN_USERNAME,
  AUTH_COOKIE_NAME,
  AUTH_SESSION_TTL_MS,
  getAuthConfigurationIssues,
  validateAuthConfig,
  parseCookies,
  createAuthToken,
  readAuthSession,
  setAuthCookie,
  clearAuthCookie,
  requireAdminAuth,
  requireRole,
  basicAuth,
  verifyCredentials,
  createMediaToken,
  validateMediaToken,
  requireWebmaster: requireRole('WEBMASTER', 'SUPPORT_TEAM', 'ADMIN'),
  requireOwner: requireRole('WEBMASTER')
};
