'use strict';

const nodemailer = require('nodemailer');

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

function mailConfig(env = process.env) {
  return {
    host: String(env.SMTP_HOST || '').trim(),
    port: Number(env.SMTP_PORT || 587),
    user: String(env.SMTP_USER || '').trim(),
    pass: String(env.SMTP_PASS || ''),
    from: String(env.MAIL_FROM || env.SMTP_USER || '').trim(),
    authMode: usesIpAuth(env) ? 'ip' : 'password'
  };
}

function isMailConfigured(env = process.env) {
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
    ...(config.authMode === 'ip' ? {} : { auth: { user: config.user, pass: config.pass } })
  });
  return transport;
}

async function sendMail({ to, subject, text, html }) {
  const recipients = (Array.isArray(to) ? to : [to]).filter(Boolean);
  if (recipients.length === 0) return { sent: false, reason: 'no recipients' };

  const info = await getTransport().sendMail({
    from: mailConfig().from,
    to: recipients.join(', '),
    subject,
    text,
    html
  });
  return { sent: true, messageId: info.messageId, accepted: info.accepted };
}

/** Verifies credentials without sending, for the settings screen's test button. */
async function verifyMail() {
  await getTransport().verify();
  return true;
}

/** Lets tests build a transport against a throwaway config. */
function resetTransport() { transport = undefined; }

module.exports = { sendMail, verifyMail, isMailConfigured, mailConfig, resetTransport };
