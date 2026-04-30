const express = require('express');
const router = express.Router();
const { dbAll, dbGet } = require('../db');
const { generateReportPDF } = require('../services/pdf');
const { sendEmailWithAttachment } = require('../services/email');
const fs = require('fs');
const path = require('path');

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

// Get aggregated report data (JSON preview)
router.get('/preview', async (req, res) => {
  try {
    const { start, end } = getTodayDateRange();

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
        SUBSTR(f.review_text, 1, 100) as review_excerpt,
        f.submitted_at
      FROM feedback f
      JOIN customers c ON f.customer_id = c.id
      WHERE f.submitted_at >= ? AND f.submitted_at < ?
      ORDER BY f.submitted_at DESC
    `, [start, end]);

    const report = {
      date: new Date().toISOString().split('T')[0],
      total_calls: callStats.total_calls || 0,
      answered: callStats.answered || 0,
      no_answer: callStats.no_answer || 0,
      declined: callStats.declined || 0,
      consent_given: callStats.consent_given || 0,
      whatsapp_sent: callStats.whatsapp_sent || 0,
      feedback_count: feedbackStats.feedback_count || 0,
      good_count: feedbackStats.good_count || 0,
      average_count: feedbackStats.average_count || 0,
      bad_count: feedbackStats.bad_count || 0,
      feedback: feedbackList
    };

    res.json(report);
  } catch (error) {
    console.error('Error generating preview:', error);
    res.status(500).json({ error: error.message });
  }
});

// Generate and email report
router.post('/generate', async (req, res) => {
  try {
    const { start, end } = getTodayDateRange();

    // Fetch report data
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
        SUBSTR(f.review_text, 1, 100) as review_excerpt,
        f.submitted_at
      FROM feedback f
      JOIN customers c ON f.customer_id = c.id
      WHERE f.submitted_at >= ? AND f.submitted_at < ?
      ORDER BY f.submitted_at DESC
    `, [start, end]);

    const reportData = {
      date: new Date().toISOString().split('T')[0],
      total_calls: callStats.total_calls || 0,
      answered: callStats.answered || 0,
      no_answer: callStats.no_answer || 0,
      declined: callStats.declined || 0,
      consent_given: callStats.consent_given || 0,
      whatsapp_sent: callStats.whatsapp_sent || 0,
      feedback_count: feedbackStats.feedback_count || 0,
      good_count: feedbackStats.good_count || 0,
      average_count: feedbackStats.average_count || 0,
      bad_count: feedbackStats.bad_count || 0,
      feedback: feedbackList
    };

    // Generate PDF
    const pdfPath = await generateReportPDF(reportData);

    // Send email
    await sendEmailWithAttachment(
      process.env.OWNER_EMAIL,
      `Feedback Report — ${reportData.date}`,
      'Please find today\'s feedback report attached.',
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
router.get('/download', (req, res) => {
  try {
    const tmpDir = '/tmp';
    const files = fs.readdirSync(tmpDir)
      .filter(f => f.startsWith('report_') && f.endsWith('.pdf'))
      .map(f => ({ name: f, time: fs.statSync(path.join(tmpDir, f)).mtime }))
      .sort((a, b) => b.time - a.time);

    if (files.length === 0) {
      return res.status(404).json({ error: 'No reports found' });
    }

    const lastReport = path.join(tmpDir, files[0].name);
    res.download(lastReport, `Report-${new Date().toISOString().split('T')[0]}.pdf`);
  } catch (error) {
    console.error('Error downloading report:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
