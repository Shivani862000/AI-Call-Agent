'use strict';

/**
 * One-off: turn a Google OAuth "Desktop app" client into a refresh token.
 *
 * Run it once on a machine with a browser, paste the result into .env.prod,
 * and never run it again -- the refresh token does not expire for an Internal
 * consent screen, so there is nothing to renew.
 *
 * Google withdrew the copy-a-code-from-the-browser flow (the "oob" redirect)
 * in 2022, so this listens on a loopback port and catches the redirect itself.
 * Desktop clients are allowed any 127.0.0.1 port without registering it.
 *
 * No new dependency: node:http and the built-in fetch are enough.
 */

const http = require('node:http');
const readline = require('node:readline/promises');
const { randomUUID, timingSafeEqual } = require('node:crypto');

// Send-only. This token cannot read the mailbox, which is the point.
const SCOPE = 'https://www.googleapis.com/auth/gmail.send';
const PORT = Number(process.env.OAUTH_CALLBACK_PORT || 53682);

/**
 * A "Desktop app" client accepts any loopback port without registering it. A
 * "Web application" client does not: the URI must match what is registered,
 * exactly, or Google answers redirect_uri_mismatch before the consent screen
 * is ever shown. OAUTH_REDIRECT_URI exists so the registered value can be
 * copied in verbatim -- including "localhost" instead of the IP literal, which
 * Google treats as a different string.
 */
// Used verbatim, never normalised: Google compares this string exactly, so
// "helpfully" trimming a trailing slash would break the case where the slash
// is what was registered.
const REDIRECT_URI = String(process.env.OAUTH_REDIRECT_URI || `http://127.0.0.1:${PORT}`);
const REDIRECT = new URL(REDIRECT_URI);
const LISTEN_PORT = Number(REDIRECT.port || PORT);
const TIMEOUT_MS = 5 * 60 * 1000;

function page(title, detail) {
  return `<!doctype html><meta charset="utf-8"><title>${title}</title>`
    + `<body style="font:16px system-ui;padding:3rem;max-width:32rem">`
    + `<h1 style="font-size:1.2rem">${title}</h1><p>${detail}</p></body>`;
}

/** Constant-time compare so the state check is not a timing oracle. */
function sameState(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && timingSafeEqual(left, right);
}

async function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

/** Waits for Google to redirect back, and resolves with the one-time code. */
function waitForCode(state) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, REDIRECT_URI);
      if (url.pathname !== REDIRECT.pathname) {
        res.writeHead(404).end();
        return;
      }

      const error = url.searchParams.get('error');
      const code = url.searchParams.get('code');

      if (error) {
        res.writeHead(400, { 'Content-Type': 'text/html' })
          .end(page('Consent refused', `Google returned <code>${error}</code>. Nothing was changed.`));
        finish(new Error(`Authorization failed: ${error}`));
        return;
      }
      if (!sameState(url.searchParams.get('state'), state)) {
        res.writeHead(400, { 'Content-Type': 'text/html' })
          .end(page('Rejected', 'The state parameter did not match. Start again.'));
        finish(new Error('State mismatch -- the redirect did not come from the request this script made.'));
        return;
      }
      if (!code) {
        res.writeHead(400, { 'Content-Type': 'text/html' })
          .end(page('No code', 'Google redirected back without an authorization code.'));
        finish(new Error('No authorization code in the redirect.'));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'text/html' })
        .end(page('Done', 'You can close this tab and return to the terminal.'));
      finish(null, code);
    });

    let settled = false;
    function finish(error, code) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      server.close(() => (error ? reject(error) : resolve(code)));
    }

    const timer = setTimeout(
      () => finish(new Error('Timed out after 5 minutes waiting for consent.')),
      TIMEOUT_MS
    );

    server.on('error', (err) => finish(
      err.code === 'EADDRINUSE'
        ? new Error(`Port ${LISTEN_PORT} is busy. Re-run with OAUTH_CALLBACK_PORT=<free port>.`)
        : err
    ));
    server.listen(LISTEN_PORT, '127.0.0.1');
  });
}

async function exchange(clientId, clientSecret, code) {
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: REDIRECT_URI,
      grant_type: 'authorization_code'
    })
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(
      `Token exchange failed (HTTP ${response.status}): ${body.error || 'unknown'}`
      + (body.error_description ? ` -- ${body.error_description}` : '')
    );
  }
  return body;
}

async function main() {
  const clientId = process.env.GMAIL_CLIENT_ID || await prompt('OAuth client ID: ');
  const clientSecret = process.env.GMAIL_CLIENT_SECRET || await prompt('OAuth client secret: ');
  if (!clientId || !clientSecret) throw new Error('Both the client ID and secret are required.');

  const state = randomUUID();
  const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authUrl.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: SCOPE,
    state,
    // Without both of these Google returns an access token only, and the
    // script would appear to work while producing nothing reusable.
    access_type: 'offline',
    prompt: 'consent'
  }).toString();

  console.log('\nOpen this URL, and sign in as the mailbox the digest should come from:\n');
  console.log(authUrl.toString());
  console.log(`\nListening on ${REDIRECT_URI} ...`);

  const code = await waitForCode(state);
  const tokens = await exchange(clientId, clientSecret, code);

  if (!tokens.refresh_token) {
    throw new Error(
      'Google returned no refresh token. This happens when the account has '
      + 'already granted this client. Revoke it at '
      + 'https://myaccount.google.com/permissions and run this again.'
    );
  }

  console.log('\n--- add to .env.prod ---\n');
  console.log(`GMAIL_CLIENT_ID=${clientId}`);
  console.log('GMAIL_CLIENT_SECRET=<the secret you just entered>');
  console.log(`GMAIL_REFRESH_TOKEN=${tokens.refresh_token}`);
  console.log('\nTreat that token like a password: it sends mail as you until revoked.');
}

main().catch((error) => {
  console.error(`\n${error.message}`);
  process.exit(1);
});
