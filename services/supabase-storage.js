'use strict';

const { resolveServiceRoleKey, resolveStorageUrl } = require('../src/config');
const BUCKET = process.env.SUPABASE_STORAGE_BUCKET || 'call-recordings';
const failure = () => new Error('Storage request failed');

function objectPath(key) {
  if (typeof key !== 'string' || !key || key.length > 1024 || /[\\%?#:\x00-\x1f\x7f]/.test(key)) throw failure();
  const segments = key.split('/');
  if (segments.some(s => !s || s === '.' || s === '..')) throw failure();
  return segments.map(encodeURIComponent).join('/');
}
function requireConfig() {
  try {
    const base = new URL(resolveStorageUrl());
    const token = resolveServiceRoleKey();
    if (!token || base.protocol !== 'https:' || base.username || base.password || base.search || base.hash || base.pathname !== '/storage/v1'
        || !/^[a-zA-Z0-9_-]{1,100}$/.test(BUCKET)) throw failure();
    return { base: base.href, token };
  } catch { throw failure(); }
}
function isStorageConfigured() {
  try { requireConfig(); return true; } catch { return false; }
}

// A total deadline covers connection and small response bodies. Redirects never
// receive the service-role credential. Error details/URLs never leave this module.
async function storageRequest(url, options, { signal, timeoutMs = 5000, allow404 = false } = {}) {
  const controller = new AbortController();
  let response, reader, rejectAbort;
  const aborted = new Promise((resolve, reject) => { rejectAbort = reject; });
  aborted.catch(() => {});
  const cancel = () => {
    controller.abort();
    reader?.cancel().catch(() => {});
    rejectAbort(failure());
  };
  const timer = setTimeout(cancel, timeoutMs);
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    if (signal?.aborted) throw failure();
    response = await Promise.race([fetch(url, { ...options, redirect: 'error', signal: controller.signal }), aborted]);
    if (!response.ok && !(allow404 && response.status === 404)) throw failure();
    const length = response.headers.get('content-length');
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > 65536)) throw failure();
    reader = response.body?.getReader();
    let bytes = 0;
    const chunks = [];
    while (reader) {
      const { value, done } = await Promise.race([reader.read(), aborted]);
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 65536) throw failure();
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks).toString('utf8');
  } catch {
    cancel();
    if (!reader) response?.body?.cancel().catch(() => {});
    throw failure();
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
  }
}

async function uploadObject(key, body, contentType) {
  const encoded = objectPath(key);
  const { base, token } = requireConfig();
  await storageRequest(`${base}/object/${BUCKET}/${encoded}`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': contentType, 'x-upsert': 'true' }, body
  }, { timeoutMs: 30000 });
  return key;
}

async function createSignedUrl(key, expiresIn = 60, { signal } = {}) {
  const encoded = objectPath(key);
  const { base, token } = requireConfig();
  if (!Number.isInteger(expiresIn) || expiresIn < 1 || expiresIn > 3600) throw failure();
  const expected = new URL(`${base}/object/sign/${BUCKET}/${encoded}`);
  const text = await storageRequest(expected.href, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ expiresIn })
  }, { signal });
  try {
    const { signedURL } = JSON.parse(text);
    if (typeof signedURL !== 'string' || signedURL.length > 8192 || /[\\\x00-\x20\x7f]/.test(signedURL) || /(?:^|\/)(?:\.|\.\.)(?:\/|\?|$)/.test(signedURL)) throw failure();
    // REST storage may return /object/sign/... or /storage/v1/object/sign/...
    const rawPath = signedURL.split('?')[0];
    if (/%(?:2e|2f|5c)/i.test(rawPath)) throw failure();
    const value = signedURL.startsWith('/object/') ? base + signedURL : signedURL;
    const signed = new URL(value, base);
    const params = [...signed.searchParams.entries()];
    if (signed.origin !== expected.origin || signed.pathname !== expected.pathname || signed.username || signed.password || signed.hash
        || params.length !== 1 || params[0][0] !== 'token' || !params[0][1]) throw failure();
    return signed.href;
  } catch { throw failure(); }
}

async function removeObject(key) {
  const encoded = objectPath(key);
  const { base, token } = requireConfig();
  await storageRequest(`${base}/object/${BUCKET}/${encoded}`, {
    method: 'DELETE', headers: { Authorization: `Bearer ${token}` }
  }, { allow404: true });
}

module.exports = { uploadObject, createSignedUrl, removeObject, isStorageConfigured, BUCKET };
