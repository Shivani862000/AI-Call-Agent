'use strict';

const { supabase: defaultSupabase } = require('../supabase');
const { WebmasterError, forbidden } = require('./errors');

const WEBMASTER_ACCESS_LEVELS = new Set(['OWNER', 'ADMIN']);

async function loadUser(supabaseClient, username) {
  const { data, error } = await supabaseClient
    .from('users')
    .select('*')
    .eq('username', username)
    .maybeSingle();

  if (error) {
    throw forbidden('WEBMASTER_FORBIDDEN');
  }

  return data;
}

function sendError(res, error) {
  const safeError = error instanceof WebmasterError
    ? error
    : forbidden('WEBMASTER_FORBIDDEN');
  return res.status(safeError.status).json(safeError.toResponse());
}

function createWebmasterAuthorization({ supabaseClient = defaultSupabase } = {}) {

  async function resolveActor(session) {
    if (session?.role !== 'WEBMASTER') {
      throw forbidden('WEBMASTER_FORBIDDEN');
    }

    const username = String(session.username || '').trim();
    if (!username) {
      throw forbidden('WEBMASTER_FORBIDDEN');
    }
    if (session.authSource === 'environment') {
      throw forbidden('WEBMASTER_FORBIDDEN');
    }

    const user = await loadUser(supabaseClient, username);
    if (!user || user.role !== 'WEBMASTER') {
      throw forbidden('WEBMASTER_FORBIDDEN');
    }
    if (user.status !== 'active') {
      throw forbidden('ACCOUNT_INACTIVE');
    }
    if (!WEBMASTER_ACCESS_LEVELS.has(user.platform_access_level)) {
      throw forbidden('WEBMASTER_ACCESS_UNASSIGNED');
    }

    return {
      id: user.id ? String(user.id) : undefined,
      username: user.username,
      role: 'WEBMASTER',
      platformAccessLevel: user.platform_access_level,
      source: 'database'
    };
  }

  function requireWebmaster(req, res, next) {
    return resolveActor(req.adminSession)
      .then((actor) => {
        req.webmasterActor = actor;
        next();
      })
      .catch((error) => sendError(res, error));
  }

  function requireOwner(req, res, next) {
    return resolveActor(req.adminSession)
      .then((actor) => {
        if (actor.platformAccessLevel !== 'OWNER') {
          throw forbidden('WEBMASTER_OWNER_REQUIRED');
        }
        req.webmasterActor = actor;
        next();
      })
      .catch((error) => sendError(res, error));
  }

  return { resolveActor, requireWebmaster, requireOwner };
}

module.exports = { createWebmasterAuthorization };
