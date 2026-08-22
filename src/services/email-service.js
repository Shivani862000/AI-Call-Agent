const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.gmail.com',
  port: parseInt(process.env.SMTP_PORT || '587', 10),
  secure: process.env.SMTP_SECURE === 'true', // true for 465, false for other ports
  auth: {
    user: process.env.SMTP_USER || '', 
    pass: process.env.SMTP_PASS || '', 
  },
});

async function sendDailyReportToAdmin(email, tenantName, reportData) {
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
    console.warn('SMTP_USER and SMTP_PASS are not configured. Skipping email send for:', email);
    return;
  }

  const { totalCalls, successful, failed } = reportData;

  const mailOptions = {
    from: `"AI Call Agent" <${process.env.SMTP_USER}>`,
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
  };

  try {
    const info = await transporter.sendMail(mailOptions);
    console.log(`Email report sent to ${email} (MessageId: ${info.messageId})`);
  } catch (error) {
    console.error('Error sending email report:', error);
  }
}

module.exports = {
  sendDailyReportToAdmin
};
