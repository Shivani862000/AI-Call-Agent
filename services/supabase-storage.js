'use strict';

const { resolveServiceRoleKey, resolveStorageUrl } = require('../src/config');

const BUCKET = process.env.SUPABASE_STORAGE_BUCKET || 'call-recordings';

function requireConfig() {
  const base = resolveStorageUrl();
  const token = resolveServiceRoleKey();
  if (!base || !token) {
    throw new Error('Supabase Storage is not configured (need a connection string and a service-role key)');
  }
  return { base, token };
}

/** True when a service-role key and a derivable storage host are both present. */
function isStorageConfigured() {
  return Boolean(resolveStorageUrl() && resolveServiceRoleKey());
}

/**
 * Uploads one object, overwriting any existing object at the same key so a
 * retried upload is idempotent. Returns the key.
 */
async function uploadObject(key, body, contentType) {
  const { base, token } = requireConfig();

  const response = await fetch(`${base}/object/${BUCKET}/${key}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': contentType,
      'x-upsert': 'true'
    },
    body
  });

  if (!response.ok) {
    const detail = (await response.text()).slice(0, 200);
    throw new Error(`Storage upload failed (${response.status}): ${detail}`);
  }

  return key;
}

/**
 * Short-lived signed URL for a private object, so audio is served straight from
 * Storage rather than proxied through this process.
 */
async function createSignedUrl(key, expiresIn = 60) {
  const { base, token } = requireConfig();

  const response = await fetch(`${base}/object/sign/${BUCKET}/${key}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ expiresIn })
  });

  if (!response.ok) {
    const detail = (await response.text()).slice(0, 200);
    throw new Error(`Signed URL failed (${response.status}): ${detail}`);
  }

  const { signedURL } = await response.json();
  // signedURL comes back relative, e.g. /object/sign/<bucket>/<key>?token=...
  return `${base}${signedURL.replace(/^\/storage\/v1/, '')}`;
}

async function removeObject(key) {
  const { base, token } = requireConfig();
  const response = await fetch(`${base}/object/${BUCKET}/${key}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!response.ok && response.status !== 404) {
    throw new Error(`Storage delete failed (${response.status})`);
  }
}

module.exports = { uploadObject, createSignedUrl, removeObject, isStorageConfigured, BUCKET };
