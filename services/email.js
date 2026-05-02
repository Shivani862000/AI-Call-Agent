const sgMail = require('@sendgrid/mail');

if (process.env.SENDGRID_API_KEY) {
  sgMail.setApiKey(process.env.SENDGRID_API_KEY);
}

async function sendEmailWithAttachment(to, subject, text, attachmentPath) {
  try {
    const fs = require('fs');
    const pdfBuffer = fs.readFileSync(attachmentPath);
    const base64Pdf = pdfBuffer.toString('base64');

    const msg = {
      to,
      from: process.env.OWNER_EMAIL,
      subject,
      text,
      attachments: [
        {
          content: base64Pdf,
          filename: `report_${new Date().toISOString().split('T')[0]}.pdf`,
          type: 'application/pdf',
          disposition: 'attachment'
        }
      ]
    };

    await sgMail.send(msg);
    console.log(`✓ Email sent to ${to}`);
    return true;
  } catch (error) {
    console.error('Error sending email:', error.message);
    throw error;
  }
}

async function sendSimpleEmail(to, subject, text) {
  if (!process.env.SENDGRID_API_KEY || !to || !process.env.OWNER_EMAIL) {
    return false;
  }

  try {
    await sgMail.send({
      to,
      from: process.env.OWNER_EMAIL,
      subject,
      text
    });
    console.log(`✓ Email sent to ${to}`);
    return true;
  } catch (error) {
    console.error('Error sending simple email:', error.message);
    throw error;
  }
}

module.exports = {
  sendEmailWithAttachment,
  sendSimpleEmail
};
