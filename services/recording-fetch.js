'use strict';

const dns = require('node:dns/promises');
const https = require('node:https');
const net = require('node:net');
const { Transform, pipeline } = require('node:stream');

const failure = () => new Error('Recording unavailable');
const AUDIO_TYPES = new Set(['audio/mpeg', 'audio/wav', 'audio/x-wav', 'audio/ogg', 'audio/webm', 'audio/mp4', 'audio/aac']);

function httpsUrl(value) {
  if (typeof value !== 'string' || !value || value.length > 4096 || /[\s\\\x00-\x1f\x7f]/.test(value)) throw failure();
  const authority = /^https:\/\/([^/?#]+)/i.exec(value)?.[1];
  if (!authority || /[@%]/.test(authority)) throw failure();
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || net.isIP(url.hostname.replace(/^\[|\]$/g, '')) || !url.hostname.includes('.') || url.hostname.endsWith('.')) throw failure();
  return url;
}

function recordingPolicy(env) {
  const origins = new Set();
  for (const entry of String(env.RECORDING_ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean)) {
    const url = httpsUrl(entry);
    if (url.pathname !== '/' || url.search) throw failure();
    origins.add(url.origin);
  }
  const lowerLimit = (name, max) => {
    const raw = env[name];
    if (raw === undefined || raw === '') return max;
    if (!/^\d+$/.test(String(raw)) || !Number.isSafeInteger(Number(raw)) || Number(raw) < 1 || Number(raw) > max) throw failure();
    return Number(raw);
  };
  const redirects = env.RECORDING_ALLOW_REDIRECTS || 'false';
  if (!['true', 'false'].includes(redirects)) throw failure();
  return { origins, redirects: redirects === 'true', maxBytes: lowerLimit('RECORDING_MAX_BYTES', 25 * 1024 * 1024), timeoutMs: lowerLimit('RECORDING_TIMEOUT_MS', 30000) };
}

// Callback metadata is validated without DNS or network effects. Empty origin
// configuration is intentionally a denial, pending verified provider fixtures.
function validateRecordingUrl(value, env = process.env) {
  try {
    const url = httpsUrl(value);
    if (!recordingPolicy(env).origins.has(url.origin)) throw failure();
    return url;
  } catch { throw failure(); }
}

function addressNumber(address) {
  if (net.isIP(address) === 4) return address.split('.').reduce((n, v) => (n << 8n) | BigInt(v), 0n);
  // Mapped/embedded IPv4 and zone identifiers are deliberately unsupported.
  if (net.isIP(address) !== 6 || address.includes('.') || address.includes('%')) throw failure();
  const halves = address.split('::');
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves[1] ? halves[1].split(':') : [];
  const parts = halves.length === 1 ? left : [...left, ...Array(8 - left.length - right.length).fill('0'), ...right];
  return parts.reduce((n, v) => (n << 16n) | BigInt(`0x${v}`), 0n);
}
function inRange(number, base, bits, width) {
  const shift = BigInt(width - bits);
  return (number >> shift) === (addressNumber(base) >> shift);
}
function isGlobalAddress(address) {
  try {
    const family = net.isIP(address), number = addressNumber(address);
    if (family === 4) {
      return ![['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 3]].some(([base, bits]) => inRange(number, base, bits, 32));
    }
    // Accept only currently allocated global unicast; conservatively exclude
    // IETF protocol assignments, documentation, 6to4 and special-purpose space.
    return inRange(number, '2000::', 3, 128)
      && ![['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]].some(([base, bits]) => inRange(number, base, bits, 128));
  } catch { return false; }
}

function responseMetadata(response, maxBytes) {
  const headers = response.headers;
  const single = name => {
    let count = 0;
    for (let i = 0; i < (response.rawHeaders || []).length; i += 2) if (response.rawHeaders[i].toLowerCase() === name) count++;
    if (count > 1 || Array.isArray(headers[name])) throw failure();
    return headers[name];
  };
  const contentType = (single('content-type') || '').split(';')[0].trim().toLowerCase();
  const encoding = single('content-encoding');
  const length = single('content-length');
  const transfer = single('transfer-encoding');
  if (!AUDIO_TYPES.has(contentType) || (encoding && encoding !== 'identity') || (transfer && transfer !== 'chunked') || (length !== undefined && (transfer || !/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)) || Number(length) > maxBytes))) throw failure();
  return { contentType, length: length === undefined ? null : Number(length) };
}

// The injectable adapters sit below policy and connection construction. Production
// never uses fetch, pooled agents or a second DNS lookup after validation.
function createRecordingFetcher({ env = process.env, lookup = (host) => dns.lookup(host, { all: true, verbatim: true }), request = https.request } = {}) {
  return async function fetchRecording(value, { signal } = {}) {
    let req, response, output, timer, rejectAbort;
    let cancelled = false;
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', cancel); };
    const cancel = () => {
      if (cancelled) return;
      cancelled = true;
      cleanup();
      req?.destroy(); response?.destroy(); output?.destroy(failure());
      rejectAbort?.(failure());
    };
    const aborted = new Promise((resolve, reject) => { rejectAbort = reject; });
    // Cancellation may occur after headers have been returned to the consumer.
    aborted.catch(() => {});
    try {
      const policy = recordingPolicy(env);
      timer = setTimeout(cancel, policy.timeoutMs);
      signal?.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted) cancel();
      let url = validateRecordingUrl(value, env);
      for (let redirects = 0; ; redirects++) {
        if (cancelled) throw failure();
        const answers = await Promise.race([lookup(url.hostname), aborted]);
        if (cancelled || !Array.isArray(answers) || !answers.length || answers.some(a => !isGlobalAddress(a.address) || a.family !== net.isIP(a.address))) throw failure();
        const pinned = answers[0];
        response = await Promise.race([new Promise((resolve, reject) => {
          req = request({ protocol: 'https:', hostname: url.hostname, port: url.port || 443,
            path: url.pathname + url.search, method: 'GET', agent: false,
            servername: url.hostname, rejectUnauthorized: true, maxHeaderSize: 16384,
            headers: { Accept: [...AUDIO_TYPES].join(', '), 'Accept-Encoding': 'identity' },
            lookup(host, options, cb) {
              if (cancelled || host !== url.hostname) return cb(failure());
              if (options?.all) cb(null, [{ address: pinned.address, family: pinned.family }]);
              else cb(null, pinned.address, pinned.family);
            }
          }, incoming => {
            if (cancelled) { incoming.destroy(); return; }
            resolve(incoming);
          });
          req.on('error', () => reject(failure()));
          req.end();
        }), aborted]);
        if (cancelled) throw failure();
        if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
          response.destroy(); req.destroy();
          if (!policy.redirects || redirects >= 3 || typeof response.headers.location !== 'string') throw failure();
          url = validateRecordingUrl(new URL(response.headers.location, url).href, env);
          continue;
        }
        if (response.statusCode !== 200) throw failure();
        const meta = responseMetadata(response, policy.maxBytes);
        let bytes = 0;
        output = new Transform({
          transform(chunk, enc, cb) {
            bytes += chunk.length;
            cb(bytes > policy.maxBytes ? failure() : null, chunk);
          },
          flush(cb) { cb(meta.length !== null && bytes !== meta.length ? failure() : null); }
        });
        output.on('error', () => {});
        output.once('end', cleanup);
        output.once('close', () => { cleanup(); req?.destroy(); response?.destroy(); });
        response.prependListener('error', () => output.destroy(failure()));
        pipeline(response, output, error => { if (error) output.destroy(failure()); });
        return { stream: output, contentType: meta.contentType, cancel };
      }
    } catch {
      cancel();
      throw failure();
    }
  };
}

module.exports = { createRecordingFetcher, fetchRecording: createRecordingFetcher(), validateRecordingUrl };
