const express = require('express');
const router = express.Router();
const { dbAll, dbGet } = require('../db');
const { generateReportPDF } = require('../services/pdf');
const { sendEmailWithAttachment } = require('../services/email');

// Helper to get today's date range
function getTodayDateRange() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);

  return {
    start: today.toISOString(),
    end: tomorrow.toISOString()
  };
}

async function buildReportData() {
  const { start, end } = getTodayDateRange();
  const publicBaseUrl = process.env.NGROK_URL || process.env.PUBLIC_BASE_URL || '';

  const callStats = await dbGet(`
    SELECT 
      COUNT(*) as total_calls,
      SUM(CASE WHEN outcome = 'answered' THEN 1 ELSE 0 END) as answered,
      SUM(CASE WHEN outcome = 'no_answer' THEN 1 ELSE 0 END) as no_answer,
      SUM(CASE WHEN outcome = 'declined' THEN 1 ELSE 0 END) as declined,
      SUM(CASE WHEN outcome = 'consent_given' THEN 1 ELSE 0 END) as consent_given,
      SUM(CASE WHEN whatsapp_sent = 1 THEN 1 ELSE 0 END) as whatsapp_sent
    FROM calls
    WHERE called_at >= ? AND called_at < ?
  `, [start, end]);

  const feedbackStats = await dbGet(`
    SELECT 
      COUNT(*) as feedback_count,
      ROUND(AVG(CASE WHEN stars IS NOT NULL THEN stars END), 1) as average_rating,
      SUM(CASE WHEN category = 'good' THEN 1 ELSE 0 END) as good_count,
      SUM(CASE WHEN category = 'average' THEN 1 ELSE 0 END) as average_count,
      SUM(CASE WHEN category = 'bad' THEN 1 ELSE 0 END) as bad_count
    FROM feedback
    WHERE submitted_at >= ? AND submitted_at < ?
  `, [start, end]);

  const feedbackList = await dbAll(`
    SELECT 
      f.id,
      c.name as customer_name,
      f.category,
      f.stars,
      SUBSTR(f.review_text, 1, 180) as review_excerpt,
      f.submitted_at
    FROM feedback f
    JOIN customers c ON f.customer_id = c.id
    WHERE f.submitted_at >= ? AND f.submitted_at < ?
    ORDER BY f.submitted_at DESC
  `, [start, end]);

  const analyzedCalls = await dbAll(`
    SELECT
      calls.id,
      c.name AS customer_name,
      calls.called_at,
      calls.outcome,
      calls.recording_status,
      calls.recording_url,
      calls.transcript_status,
      calls.transcript_text,
      calls.analysis_status,
      calls.analysis_summary,
      calls.report_excerpt,
      calls.extracted_rating
    FROM calls
    JOIN customers c ON c.id = calls.customer_id
    WHERE calls.called_at >= ? AND calls.called_at < ?
    ORDER BY calls.called_at DESC
    LIMIT 10
  `, [start, end]);

  const pendingItems = await dbAll(`
    SELECT
      calls.id,
      c.name AS customer_name,
      calls.called_at,
      calls.outcome,
      calls.recording_status,
      calls.transcript_status,
      calls.analysis_status
    FROM calls
    JOIN customers c ON c.id = calls.customer_id
    WHERE calls.called_at >= ? AND calls.called_at < ?
      AND (
        COALESCE(calls.recording_status, 'pending') != 'completed'
        OR COALESCE(calls.transcript_status, 'pending') != 'completed'
        OR COALESCE(calls.analysis_status, 'pending') != 'completed'
        OR calls.outcome IN ('initiated', 'scheduled_initiated', 'no_answer')
      )
    ORDER BY calls.called_at DESC
    LIMIT 8
  `, [start, end]);

  const safeTotalCalls = Number(callStats.total_calls) || 0;
  const safeAnswered = Number(callStats.answered) || 0;
  const safeNoAnswer = Number(callStats.no_answer) || 0;
  const safeDeclined = Number(callStats.declined) || 0;
  const safeConsent = Number(callStats.consent_given) || 0;
  const safeWhatsapp = Number(callStats.whatsapp_sent) || 0;
  const safeFeedbackCount = Number(feedbackStats.feedback_count) || 0;
  const safeGoodCount = Number(feedbackStats.good_count) || 0;
  const safeAverageCount = Number(feedbackStats.average_count) || 0;
  const safeBadCount = Number(feedbackStats.bad_count) || 0;
  const averageRating = Number(feedbackStats.average_rating) || 0;
  const successRate = safeTotalCalls > 0 ? Number(((safeAnswered / safeTotalCalls) * 100).toFixed(1)) : 0;

  const enrichedCalls = analyzedCalls.map((call) => ({
    ...call,
    recording_link: publicBaseUrl ? `${publicBaseUrl}/api/calls/${call.id}/recording` : null,
    transcript_link: publicBaseUrl ? `${publicBaseUrl}/api/calls/${call.id}/transcript` : null,
    dashboard_link: publicBaseUrl ? `${publicBaseUrl}/admin.html` : null
  }));

  return {
    date: new Date().toISOString().split('T')[0],
    total_calls: safeTotalCalls,
    answered: safeAnswered,
    no_answer: safeNoAnswer,
    declined: safeDeclined,
    consent_given: safeConsent,
    whatsapp_sent: safeWhatsapp,
    feedback_count: safeFeedbackCount,
    average_rating: averageRating,
    success_rate: successRate,
    good_count: safeGoodCount,
    average_count: safeAverageCount,
    bad_count: safeBadCount,
    feedback: feedbackList,
    analyzed_calls: enrichedCalls,
    pending_items: pendingItems,
    dashboard_link: publicBaseUrl ? `${publicBaseUrl}/admin.html` : null,
    summary_text: `Total ${safeTotalCalls} calls, ${safeFeedbackCount} feedback entries, ${safeGoodCount} good reviews, and ${successRate}% answer success today.`
  };
}

// Get aggregated report data (JSON preview)
router.get('/preview', async (req, res) => {
  try {
    const report = await buildReportData();
    res.json(report);
  } catch (error) {
    console.error('Error generating preview:', error);
    res.status(500).json({ error: error.message });
  }
});

// Generate and email report
router.post('/generate', async (req, res) => {
  try {
    const reportData = await buildReportData();

    // Generate PDF
    const pdfPath = await generateReportPDF(reportData);

    // Send email
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

// Download last report
router.get('/download', async (req, res) => {
  try {
    const reportData = await buildReportData();
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

module.exports = router;
