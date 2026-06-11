const express = require('express');
const router = express.Router();
const { dbRun, dbGet, dbAll } = require('../db');
const { categorizeFeedback } = require('../services/gemini');

// Manual feedback entry
router.post('/manual', async (req, res) => {
  try {
    const customer_id = Number(req.body.customer_id);
    const review_text = String(req.body.review_text || '').trim();
    const stars = Number(req.body.stars || 0);
    const fieldErrors = {};

    if (!customer_id) {
      fieldErrors.customer_id = 'Please select a customer';
    }

    if (!review_text) {
      fieldErrors.review_text = 'Review text is required';
    } else if (review_text.length < 5) {
      fieldErrors.review_text = 'Review text should be at least 5 characters';
    } else if (review_text.length > 1000) {
      fieldErrors.review_text = 'Review text must be 1000 characters or fewer';
    }

    if (!Number.isInteger(stars) || stars < 1 || stars > 5) {
      fieldErrors.stars = 'Rating must be between 1 and 5';
    }

    if (Object.keys(fieldErrors).length > 0) {
      return res.status(400).json({ error: 'Please fix the highlighted fields', fieldErrors });
    }

    const customer = await dbGet('SELECT id FROM customers WHERE id = ?', [customer_id]);
    if (!customer) {
      return res.status(404).json({ error: 'Customer not found', fieldErrors: { customer_id: 'Selected customer no longer exists' } });
    }

    // Categorize feedback using the local heuristic classifier
    const categorization = await categorizeFeedback(review_text, stars);

    // Save to feedback table
    const result = await dbRun(
      'INSERT INTO feedback (customer_id, review_text, category, stars, submitted_at, source) VALUES (?, ?, ?, ?, ?, ?)',
      [customer_id, review_text, categorization.category, stars, new Date().toISOString(), 'manual']
    );

    res.json({
      id: result.lastID,
      category: categorization.category,
      reason: categorization.reason
    });
  } catch (error) {
    console.error('Error saving feedback:', error);
    res.status(500).json({ error: error.message });
  }
});

// List all feedback with customer names
router.get('/', async (req, res) => {
  try {
    const feedback = await dbAll(`
      SELECT 
        f.id,
        f.customer_id,
        f.call_id,
        c.name as customer_name,
        f.review_text,
        f.category,
        f.stars,
        f.source,
        f.submitted_at
      FROM feedback f
      JOIN customers c ON f.customer_id = c.id
      ORDER BY f.submitted_at DESC
    `);

    res.json(feedback);
  } catch (error) {
    console.error('Error fetching feedback:', error);
    res.status(500).json({ error: error.message });
  }
});

// Analytics endpoint for unified feedback stats
router.get('/analytics', async (req, res) => {
  try {
    const feedback = await dbAll(`
      SELECT f.*, c.name as customer_name, c.phone as customer_phone
      FROM feedback f
      LEFT JOIN customers c ON f.customer_id = c.id
    `);
    const recentCalls = await dbAll(`
      SELECT calls.*, c.name as customer_name, c.phone as customer_phone
      FROM calls
      LEFT JOIN customers c ON calls.customer_id = c.id
      ORDER BY calls.created_at DESC LIMIT 500
    `);

    // Positive Feedback
    const fbPositive = feedback.filter((item) => Number(item.stars || 0) >= 4);
    const callsPositive = recentCalls.filter((c) => Number(c.extracted_rating || 0) >= 4 && !feedback.find(f => f.call_id === c.id));
    const positiveFeedback = [...fbPositive, ...callsPositive];

    // Negative Feedback
    const fbNegative = feedback.filter((item) => Number(item.stars || 0) > 0 && Number(item.stars || 0) <= 2);
    const callsNegative = recentCalls.filter((c) => Number(c.extracted_rating || 0) > 0 && Number(c.extracted_rating || 0) <= 2 && !feedback.find(f => f.call_id === c.id));
    const negativeFeedback = [...fbNegative, ...callsNegative];

    // Pending Analysis
    const pendingAnalysis = recentCalls.filter((call) => String(call.analysis_status || '').toLowerCase() !== 'completed');

    // Needs Review
    const needsReview = recentCalls.filter((call) => {
      const isCompleted = String(call.outcome || '').toLowerCase() === 'completed';
      const needsTranscript = String(call.transcript_status || '').toLowerCase() !== 'completed';
      const needsAnalysis = String(call.analysis_status || '').toLowerCase() !== 'completed';
      const missingRating = !Number(call.extracted_rating || 0);
      return isCompleted && (needsTranscript || needsAnalysis || missingRating);
    });

    res.json({
      metrics: {
        positive: positiveFeedback.length,
        negative: negativeFeedback.length,
        pendingAnalysis: pendingAnalysis.length,
        needsReview: needsReview.length
      },
      lists: {
        positive: positiveFeedback,
        negative: negativeFeedback,
        pendingAnalysis,
        needsReview
      }
    });
  } catch (error) {
    console.error('Error computing feedback analytics:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
