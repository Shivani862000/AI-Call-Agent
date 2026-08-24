'use strict';

const { WebmasterError, forbidden } = require('./errors');

const WEBMASTER_ACCESS_LEVELS = new Set(['OWNER', 'ADMIN']);

async function loadUser(UserModel, username) {
  const query = UserModel.findOne({ username });
  if (query && typeof query.lean === 'function') {
    return query.lean();
  }
  return query;
}

function sendError(res, error) {
  const safeError = error instanceof WebmasterError
    ? error
    : forbidden('WEBMASTER_FORBIDDEN');
  return res.status(safeError.status).json(safeError.toResponse());
}

function createWebmasterAuthorization({ UserModel, TenantModel, env = process.env }) {
  if (!UserModel) {
    throw new Error('UserModel is required to authorize Webmaster access');
  }

  async function resolveActor(session) {
    if (session?.role !== 'WEBMASTER') {
      throw forbidden('WEBMASTER_FORBIDDEN');
    }

    const username = String(session.username || '').trim();
    const environmentUsername = String(env.ADMIN_USERNAME || '').trim();
    if (!username) {
      throw forbidden('WEBMASTER_FORBIDDEN');
    }
    if (environmentUsername && username === environmentUsername) {
      if (session.authSource === 'environment') {
        return {
          username,
          role: 'WEBMASTER',
          platformAccessLevel: 'OWNER',
          source: 'environment'
        };
      }
      throw forbidden('WEBMASTER_FORBIDDEN');
    }
    if (session.authSource === 'environment') {
      throw forbidden('WEBMASTER_FORBIDDEN');
    }

    const user = await loadUser(UserModel, username);
    if (!user || user.role !== 'WEBMASTER') {
      throw forbidden('WEBMASTER_FORBIDDEN');
    }
    if (user.status !== 'active') {
      throw forbidden('ACCOUNT_INACTIVE');
    }
    if (!WEBMASTER_ACCESS_LEVELS.has(user.platformAccessLevel)) {
      throw forbidden('WEBMASTER_ACCESS_UNASSIGNED');
    }

    return {
      id: user._id ? String(user._id) : undefined,
      username: user.username,
      role: 'WEBMASTER',
      platformAccessLevel: user.platformAccessLevel,
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
