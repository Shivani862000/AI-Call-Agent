const express = require('express');
const router = express.Router();
const { generateReportPDF } = require('../services/pdf');
const { sendEmailWithAttachment, sendSimpleEmail } = require('../services/email');
const { sendWhatsAppMessage } = require('../services/icallmate');
const { buildReportData, buildWeeklySummary, buildOwnerDashboardData, getCurrentWeekDateRange } = require('../services/reporting');

function weeklyTimestampFilename(prefix = 'Weekly-Report') {
  return `${prefix}-${new Date().toISOString().replace(/[:.]/g, '-')}.pdf`;
}

async function buildDailyPreview() {
  return buildReportData({ label: 'today' });
}

async function buildWeeklyPreview() {
  return buildWeeklySummary();
}

router.get('/preview', async (req, res) => {
  try {
    const report = await buildDailyPreview();
    res.json(report);
  } catch (error) {
    console.error('Error generating daily preview:', error);
    res.status(500).json({ error: error.message });
  }
});

router.get('/weekly-preview', async (req, res) => {
  try {
    const report = await buildWeeklyPreview();
    res.json(report);
  } catch (error) {
    console.error('Error generating weekly preview:', error);
    res.status(500).json({ error: error.message });
  }
});

router.get('/owner-preview', async (req, res) => {
  try {
    const report = await buildOwnerDashboardData();
    res.json(report);
  } catch (error) {
    console.error('Error generating owner preview:', error);
    res.status(500).json({ error: error.message });
  }
});

router.post('/generate', async (req, res) => {
  try {
    const reportData = await buildDailyPreview();
    const pdfPath = await generateReportPDF(reportData);

    await sendEmailWithAttachment(
      process.env.OWNER_EMAIL,
      `Feedback Report — ${reportData.date}`,
      `${reportData.summary_text}\n\nPlease find today's feedback report attached.`,
      pdfPath
    );

    res.json({
      success: true,
      path: pdfPath,
      message: 'Report generated and emailed successfully'
    });
  } catch (error) {
    console.error('Error generating report:', error);
    res.status(500).json({ error: error.message });
  }
});

router.get('/download', async (req, res) => {
  try {
    const reportData = await buildDailyPreview();
    const pdfPath = await generateReportPDF(reportData);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

    res.set({
      'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
      Pragma: 'no-cache',
      Expires: '0',
      'Surrogate-Control': 'no-store'
    });

    res.download(pdfPath, `Report-${timestamp}.pdf`);
  } catch (error) {
    console.error('Error downloading report:', error);
    res.status(500).json({ error: error.message });
  }
});

router.post('/weekly-generate', async (req, res) => {
  try {
    const reportData = await buildWeeklyPreview();
    const pdfPath = await generateReportPDF(reportData);

    res.json({
      success: true,
      path: pdfPath,
      message: 'Weekly report generated successfully'
    });
  } catch (error) {
    console.error('Error generating weekly report:', error);
    res.status(500).json({ error: error.message });
  }
});

router.get('/weekly-download', async (req, res) => {
  try {
    const reportData = await buildWeeklyPreview();
    const pdfPath = await generateReportPDF(reportData);

    res.set({
      'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
      Pragma: 'no-cache',
      Expires: '0',
      'Surrogate-Control': 'no-store'
    });

    res.download(pdfPath, weeklyTimestampFilename());
  } catch (error) {
    console.error('Error downloading weekly report:', error);
    res.status(500).json({ error: error.message });
  }
});

router.post('/weekly-email', async (req, res) => {
  try {
    const summary = await buildWeeklySummary();
    const pdfPath = await generateReportPDF(summary);
    const plainText = [
      summary.summary_text,
      '',
      summary.top_insights?.length ? `Top insights:\n- ${summary.top_insights.join('\n- ')}` : 'Top insights: none',
      '',
      summary.hot_lead_names?.length ? `Hot leads:\n- ${summary.hot_lead_names.join('\n- ')}` : 'Hot leads: none',
      '',
      summary.pending_summary?.length ? `Pending items:\n- ${summary.pending_summary.join('\n- ')}` : 'Pending items: none'
    ].join('\n');

    if (process.env.OWNER_EMAIL) {
      await sendEmailWithAttachment(
        process.env.OWNER_EMAIL,
        `Weekly AI Summary — ${summary.date}`,
        plainText,
        pdfPath
      );
    } else {
      await sendSimpleEmail(process.env.OWNER_EMAIL, `Weekly AI Summary — ${summary.date}`, plainText);
    }

    res.json({ success: true, message: 'Weekly summary emailed successfully', path: pdfPath });
  } catch (error) {
    console.error('Error emailing weekly summary:', error);
    res.status(500).json({ error: error.message });
  }
});

router.post('/owner-digest/send', async (req, res) => {
  try {
    const digest = await buildOwnerDashboardData();
    const lines = [
      digest.digest_text,
      '',
      `Revenue pipeline: Rs ${Number(digest.roi_snapshot?.revenue_pipeline_estimate || 0).toFixed(0)}`,
      `Estimated AI ops cost: Rs ${Number(digest.roi_snapshot?.ai_ops_cost_estimate || 0).toFixed(0)}`,
      `Estimated saving vs staff: Rs ${Number(digest.roi_snapshot?.estimated_saving_vs_staff || 0).toFixed(0)}`,
      '',
      digest.alerts?.length
        ? `Priority alerts:\n- ${digest.alerts.map((item) => `${item.customer_name}: ${item.headline}`).join('\n- ')}`
        : 'Priority alerts: none'
    ].join('\n');

    let emailSent = false;
    let whatsappSent = false;

    if (process.env.OWNER_EMAIL) {
      emailSent = await sendSimpleEmail(
        process.env.OWNER_EMAIL,
        `CEO Morning Digest — ${new Date().toLocaleDateString()}`,
        lines
      );
    }

    if (process.env.OWNER_PHONE && process.env.ICALLMATE_WHATSAPP_ENABLED === 'true') {
      await sendWhatsAppMessage(process.env.OWNER_PHONE, digest.digest_text);
      whatsappSent = true;
    }

    res.json({
      success: emailSent || whatsappSent,
      email_sent: emailSent,
      whatsapp_sent: whatsappSent,
      digest: digest.digest_text
    });
  } catch (error) {
    console.error('Error sending owner digest:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
