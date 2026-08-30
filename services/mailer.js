'use strict';

const nodemailer = require('nodemailer');

/**
 * SMTP transport for outbound mail.
 *
 * Built lazily so the app boots without mail configured, and returns a clear
 * "not configured" rather than throwing inside a scheduler tick.
 */
let transport;

function mailConfig(env = process.env) {
  return {
    host: String(env.SMTP_HOST || '').trim(),
    port: Number(env.SMTP_PORT || 587),
    user: String(env.SMTP_USER || '').trim(),
    pass: String(env.SMTP_PASS || ''),
    from: String(env.MAIL_FROM || env.SMTP_USER || '').trim()
  };
}

function isMailConfigured(env = process.env) {
  const config = mailConfig(env);
  return Boolean(config.host && config.user && config.pass && config.from);
}

function getTransport() {
  if (transport) return transport;
  const config = mailConfig();
  if (!isMailConfigured()) throw new Error('SMTP is not configured (SMTP_HOST, SMTP_USER, SMTP_PASS, MAIL_FROM)');

  transport = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    // 465 is implicit TLS; anything else must upgrade via STARTTLS. This
    // carries patient data, so an unencrypted fallback is refused outright.
    secure: config.port === 465,
    requireTLS: config.port !== 465,
    auth: { user: config.user, pass: config.pass }
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

module.exports = { sendMail, verifyMail, isMailConfigured, mailConfig };
