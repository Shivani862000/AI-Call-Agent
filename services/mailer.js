'use strict';

const nodemailer = require('nodemailer');
const crypto = require('node:crypto');
const fs = require('node:fs');

const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.send';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GMAIL_SEND_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';

/**
 * SMTP transport for outbound mail.
 *
 * Built lazily so the app boots without mail configured, and returns a clear
 * "not configured" rather than throwing inside a scheduler tick.
 */
let transport;

/**
 * Google Workspace's SMTP relay authenticates the sending machine by IP rather
 * than by password, so there is no credential to hold on the droplet at all.
 *
 * It must be asked for explicitly. Treating "no username and no password" as
 * consent to send unauthenticated would turn a forgotten SMTP_PASS into a
 * silent attempt to relay without credentials, which is a misconfiguration
 * dressed up as a feature.
 */
function usesIpAuth(env = process.env) {
  return /^(ip|none)$/i.test(String(env.SMTP_AUTH_MODE || '').trim());
}

/**
 * Service-account credentials, from a mounted key file or straight from the
 * environment.
 *
 * The file is preferred: the app prints its environment at boot, and a private
 * key in a variable is one log line away from disk. The env form exists for
 * tests and for hosts where mounting a file is awkward.
 */
function gmailCredentials(env = process.env) {
  const keyFile = String(env.GMAIL_KEY_FILE || '').trim();
  if (keyFile) {
    try {
      const parsed = JSON.parse(fs.readFileSync(keyFile, 'utf8'));
      return {
        clientEmail: String(parsed.client_email || '').trim(),
        privateKey: String(parsed.private_key || '')
      };
    } catch (error) {
      throw new Error(`Could not read the Gmail service-account key at ${keyFile}: ${error.message}`);
    }
  }
  return {
    clientEmail: String(env.GMAIL_CLIENT_EMAIL || '').trim(),
    // An env-carried PEM usually arrives with the newlines escaped.
    privateKey: String(env.GMAIL_PRIVATE_KEY || '').replace(/\\n/g, '\n')
  };
}

/**
 * True when Gmail is fully configured.
 *
 * A key without an impersonated mailbox is not "partly configured" -- it cannot
 * send at all. Falling back to SMTP in that case would pick a transport whose
 * ports the host blocks, turning a visible misconfiguration into a silent
 * timeout, so the check is deliberately all-or-nothing.
 */
function usesGmailApi(env = process.env) {
  const hasKey = Boolean(String(env.GMAIL_KEY_FILE || '').trim() || String(env.GMAIL_PRIVATE_KEY || '').trim());
  return hasKey && Boolean(String(env.GMAIL_IMPERSONATE || '').trim());
}

function mailConfig(env = process.env) {
  if (usesGmailApi(env)) {
    const impersonate = String(env.GMAIL_IMPERSONATE || '').trim();
    return {
      transport: 'gmail-api',
      impersonate,
      from: String(env.MAIL_FROM || impersonate).trim(),
      host: 'gmail.googleapis.com',
      port: 443,
      authMode: 'service-account'
    };
  }
  return {
    transport: 'smtp',
    host: String(env.SMTP_HOST || '').trim(),
    port: Number(env.SMTP_PORT || 587),
    user: String(env.SMTP_USER || '').trim(),
    pass: String(env.SMTP_PASS || ''),
    from: String(env.MAIL_FROM || env.SMTP_USER || '').trim(),
    authMode: usesIpAuth(env) ? 'ip' : 'password'
  };
}

function isMailConfigured(env = process.env) {
  if (usesGmailApi(env)) return Boolean(mailConfig(env).from);
  const config = mailConfig(env);
  if (!config.host || !config.from) return false;
  return config.authMode === 'ip' ? true : Boolean(config.user && config.pass);
}

function getTransport() {
  if (transport) return transport;
  const config = mailConfig();
  if (!isMailConfigured()) {
    throw new Error(
      'SMTP is not configured. Set SMTP_HOST, SMTP_USER, SMTP_PASS and MAIL_FROM, '
      + 'or SMTP_HOST, MAIL_FROM and SMTP_AUTH_MODE=ip for an IP-allowlisted relay.'
    );
  }

  transport = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    // 465 is implicit TLS; anything else must upgrade via STARTTLS. This
    // carries patient data, so an unencrypted fallback is refused outright --
    // including on an IP-authenticated relay, where nothing else protects it.
    secure: config.port === 465,
    requireTLS: config.port !== 465,
    // Omitted entirely for a relay that authenticates by IP: sending an empty
    // username makes the server reject the session rather than accept it.
    ...(config.authMode === 'ip' ? {} : { auth: { user: config.user, pass: config.pass } }),
    // Without these the socket waits indefinitely. A host that blocks outbound
    // SMTP drops the packets rather than refusing them, so the "send a test"
    // button spun for a minute and returned nothing at all.
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 20000
  });
  return transport;
}

/**
 * Turns a silent network failure into something actionable.
 *
 * Many hosts -- DigitalOcean among them -- block outbound 25, 465 and 587 by
 * default to deter spam, and drop the packets rather than refusing them. Every
 * SMTP provider then looks identical: a long hang and a timeout that says
 * nothing about the cause.
 */
function explainMailError(error, config) {
  const code = String(error && (error.code || error.message) || '');
  if (!/ETIMEDOUT|ESOCKET|ECONNREFUSED|Greeting never received|timeout/i.test(code)) {
    return error;
  }
  return new Error(
    `Could not reach ${config.host}:${config.port} (${code}). `
    + 'Outbound SMTP is usually blocked by the hosting provider by default -- '
    + 'ports 25, 465 and 587 to every host. Ask them to lift the block, or send over HTTPS instead.'
  );
}

/**
 * A signed JWT asserting "let me act as this mailbox".
 *
 * `sub` is the whole point: without it Google issues a token for the service
 * account itself, which owns no mailbox and cannot send. With it -- and with
 * the matching authorisation in the admin console -- the token acts as the
 * impersonated user.
 */
function buildAssertion({ clientEmail, privateKey, impersonate, now = new Date() }) {
  const issuedAt = Math.floor(now.getTime() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claims = {
    iss: clientEmail,
    sub: impersonate,
    scope: GMAIL_SCOPE,
    aud: GOOGLE_TOKEN_URL,
    iat: issuedAt,
    // Google refuses an assertion valid for longer than an hour.
    exp: issuedAt + 3600
  };

  const encode = (value) => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
  const signingInput = `${encode(header)}.${encode(claims)}`;
  const signature = crypto.createSign('RSA-SHA256').update(signingInput).sign(privateKey);
  return `${signingInput}.${signature.toString('base64url')}`;
}

/**
 * Turns Google's three-word OAuth failures into something that names the step
 * that was missed. Every one of these arrives as an HTTP 400 with no detail.
 */
function explainGmailError(body = {}, status = 400) {
  const raw = body && typeof body.error === 'object' ? body.error : {};
  const code = String((typeof body.error === 'string' ? body.error : raw.status || raw.message) || '');
  const detail = String(body.error_description || raw.message || '');

  if (/unauthorized_client/i.test(code)) {
    return new Error(
      'Google refused the service account (unauthorized_client). Domain-wide delegation '
      + 'is not authorised for this client. In admin.google.com -> Security -> Access and '
      + 'data control -> API controls -> Manage Domain Wide Delegation, check the numeric '
      + `Client ID is registered with exactly the scope ${GMAIL_SCOPE}.`
    );
  }
  if (/invalid_grant/i.test(code)) {
    return new Error(
      'Google rejected the assertion (invalid_grant). Either the impersonated mailbox does '
      + 'not exist in this domain, or the server clock has drifted more than a few minutes.'
    );
  }
  if (status === 403 || /access_denied|forbidden|PERMISSION_DENIED/i.test(code)) {
    return new Error(
      'Google accepted the identity but refused the send (403). Enable the Gmail API on the '
      + `project, and confirm the delegation grants ${GMAIL_SCOPE}.`
    );
  }
  return new Error(
    `Gmail API request failed (HTTP ${status})${code ? `: ${code}` : ''}${detail ? ` -- ${detail}` : ''}`
  );
}

// One token lasts an hour; the digest sends once a day, but the settings test
// button can be pressed repeatedly, and re-minting per send is needless work.
let cachedToken = null;

async function getAccessToken(config = mailConfig(), env = process.env, now = new Date()) {
  if (cachedToken && cachedToken.expiresAt > now.getTime() + 60_000) return cachedToken.value;

  const { clientEmail, privateKey } = gmailCredentials(env);
  if (!clientEmail || !privateKey) {
    throw new Error('The Gmail service-account key is missing its client_email or private_key.');
  }

  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: buildAssertion({ clientEmail, privateKey, impersonate: config.impersonate, now })
    })
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.access_token) throw explainGmailError(body, response.status);

  cachedToken = {
    value: body.access_token,
    expiresAt: now.getTime() + (Number(body.expires_in) || 3600) * 1000
  };
  return cachedToken.value;
}

/** RFC 2047: a header may not carry raw 8-bit text, and patient names are Devanagari. */
function encodeHeader(value) {
  const text = String(value == null ? '' : value);
  if (/^[\x20-\x7E]*$/.test(text)) return text;
  return `=?UTF-8?B?${Buffer.from(text, 'utf8').toString('base64')}?=`;
}

/** Base64 bodies are wrapped at 76 columns, as MIME requires. */
function base64Body(value) {
  return Buffer.from(String(value == null ? '' : value), 'utf8')
    .toString('base64')
    .replace(/(.{76})/g, '$1\r\n');
}

/**
 * The RFC 822 message Gmail wants, base64url encoded.
 *
 * base64url rather than base64: the API rejects a raw body containing + or /.
 */
function buildRawMessage({ from, to, subject, text, html }) {
  const boundary = `----=_kcpath_${crypto.randomBytes(12).toString('hex')}`;
  const lines = [
    `From: ${from}`,
    `To: ${(Array.isArray(to) ? to : [to]).join(', ')}`,
    `Subject: ${encodeHeader(subject)}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    base64Body(text),
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    base64Body(html),
    `--${boundary}--`,
    ''
  ];
  return Buffer.from(lines.join('\r\n'), 'utf8').toString('base64url');
}

async function sendViaGmail({ to, subject, text, html }) {
  const config = mailConfig();
  const token = await getAccessToken(config);

  const response = await fetch(GMAIL_SEND_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw: buildRawMessage({ from: config.from, to, subject, text, html }) })
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    // A token can be revoked mid-life; do not serve the stale one to the retry.
    if (response.status === 401) cachedToken = null;
    throw explainGmailError(body, response.status);
  }
  return { sent: true, messageId: body.id, accepted: Array.isArray(to) ? to : [to] };
}

async function sendMail({ to, subject, text, html }) {
  const recipients = (Array.isArray(to) ? to : [to]).filter(Boolean);
  if (recipients.length === 0) return { sent: false, reason: 'no recipients' };

  if (mailConfig().transport === 'gmail-api') {
    return sendViaGmail({ to: recipients, subject, text, html });
  }

  const info = await getTransport().sendMail({
    from: mailConfig().from,
    to: recipients.join(', '),
    subject,
    text,
    html
  }).catch((error) => { throw explainMailError(error, mailConfig()); });
  return { sent: true, messageId: info.messageId, accepted: info.accepted };
}

/** Verifies credentials without sending, for the settings screen's test button. */
async function verifyMail() {
  // Minting a token exercises the whole delegation chain -- key, client ID,
  // scope, impersonated mailbox -- without putting a message in anyone's inbox.
  if (mailConfig().transport === 'gmail-api') {
    await getAccessToken();
    return true;
  }
  await getTransport().verify().catch((error) => { throw explainMailError(error, mailConfig()); });
  return true;
}

/** Lets tests build a transport against a throwaway config. */
function resetTransport() { transport = undefined; cachedToken = null; }

module.exports = {
  sendMail,
  verifyMail,
  isMailConfigured,
  mailConfig,
  resetTransport,
  explainMailError,
  usesGmailApi,
  buildAssertion,
  buildRawMessage,
  explainGmailError
};
