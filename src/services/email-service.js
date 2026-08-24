'use strict';

const nodemailer = require('nodemailer');
const { getIntegrationRuntimeConfig: defaultRuntimeConfigResolver } = require('../webmaster/settings-service');

function createEmailService({
  nodemailerImpl = nodemailer,
  getIntegrationRuntimeConfig = defaultRuntimeConfigResolver,
  logger = console
} = {}) {
  async function sendDailyReportToAdmin(email, tenantName, reportData, { tenantId = null } = {}) {
    const runtime = await getIntegrationRuntimeConfig('smtp', tenantId);
    const settings = runtime.settings || {};
    const password = runtime.secrets?.password || '';
    if (settings.enabled === false || !settings.user || !password) {
      logger.warn?.('SMTP is not configured. Skipping daily report delivery.', { tenantId });
      return { delivered: false, skipped: true };
    }

    const transporter = nodemailerImpl.createTransport({
      host: settings.host,
      port: Number(settings.port),
      secure: Boolean(settings.secure),
      auth: { user: settings.user, pass: password }
    });
    const { totalCalls, successful, failed } = reportData;
    const fromName = settings.fromName || 'AI Call Agent';
    const fromAddress = settings.fromAddress || settings.user;
    const info = await transporter.sendMail({
      from: `"${fromName}" <${fromAddress}>`,
      to: email,
      subject: `Daily Call Report for ${tenantName}`,
      html: `
        <h2>Daily Call Report: ${tenantName}</h2>
        <p>Here is the summary of your AI calls today:</p>
        <ul>
          <li><strong>Total Calls:</strong> ${totalCalls}</li>
          <li><strong>Successful:</strong> ${successful}</li>
          <li><strong>Failed/No Answer:</strong> ${failed}</li>
        </ul>
        <p>Log in to your dashboard to view detailed call history.</p>
      `
    });
    logger.info?.('Daily report email delivered', { tenantId, messageId: info.messageId });
    return { delivered: true, messageId: info.messageId };
  }

  return { sendDailyReportToAdmin };
}

const defaultService = createEmailService();

module.exports = {
  createEmailService,
  sendDailyReportToAdmin: defaultService.sendDailyReportToAdmin
};
