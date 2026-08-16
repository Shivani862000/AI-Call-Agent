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

function normalizeSentiment(value) {
  const sentiment = String(value || '').trim().toLowerCase();
  if (sentiment.includes('positive') || sentiment.includes('good')) return 'positive';
  if (sentiment.includes('negative') || sentiment.includes('bad')) return 'negative';
  return 'neutral';
}

function normalizeRating(stars) {
  if (!stars) return 0;
  if (typeof stars === 'number') return stars;
  const match = String(stars).match(/^(\d+)/);
  if (match) return Number(match[1]);
  return 0;
}

function categoryFromAnalysis(row) {
  const rating = normalizeRating(row.stars);
  const sentiment = normalizeSentiment(row.sentiment);

  if (rating >= 4 || sentiment === 'positive') return 'good';
  if ((rating > 0 && rating <= 2) || sentiment === 'negative') return 'bad';
  return 'average';
}

function parseAnalysisJson(value) {
  if (!value) return {};
  try {
    return typeof value === 'string' ? JSON.parse(value) : value;
  } catch (error) {
    return {};
  }
}

function getFollowUpAnswers(analysisJson) {
  const productAnalysis = analysisJson?.product_analysis || analysisJson || {};
  return {
    blood_donated_last_3_months: productAnalysis.blood_donated_last_3_months || null,
    willing_to_donate_future: productAnalysis.willing_to_donate_future || null
  };
}

async function listUnifiedFeedback() {
  const feedbackRows = await dbAll(`
    SELECT
      f.id,
      f.customer_id,
      f.call_id,
      c.name AS customer_name,
      c.phone AS customer_phone,
      f.review_text,
      f.category,
      f.stars,
      f.source,
      f.submitted_at,
      calls.call_type,
      calls.outcome,
      calls.called_at,
      calls.extracted_review_text,
      calls.extracted_rating,
      calls.sentiment_label,
      calls.sentiment,
      calls.analysis_summary,
      calls.analysis_status,
      calls.analysis_json,
      calls.transcript_status,
      CASE WHEN COALESCE(calls.transcript_text, '') != '' THEN 1 ELSE 0 END AS transcript_available
    FROM feedback f
    JOIN customers c ON c.id = f.customer_id
    LEFT JOIN calls ON calls.id = f.call_id
    ORDER BY f.submitted_at DESC
    LIMIT 500
  `);

  const linkedCallIds = new Set(feedbackRows.map((row) => Number(row.call_id || 0)).filter(Boolean));
  const analyzedCalls = await dbAll(`
      SELECT 
        calls.id AS call_id,
        calls.customer_id,
        customers.name AS customer_name,
        customers.phone AS customer_phone,
        calls.extracted_review_text,
        calls.analysis_summary,
        calls.summary,
        calls.report_excerpt,
        calls.extracted_rating AS stars,
        calls.sentiment_label,
        calls.sentiment,
        calls.analysis_status,
        calls.analysis_completed_at,
        calls.feedback_saved_at,
        calls.called_at,
        calls.call_type,
        calls.outcome,
        calls.analysis_json,
        calls.transcript_status,
        CASE WHEN COALESCE(calls.transcript_text, '') != '' THEN 1 ELSE 0 END AS transcript_available
      FROM calls
      JOIN customers ON customers.id = calls.customer_id
      WHERE calls.extracted_rating IS NOT NULL 
         OR calls.sentiment IS NOT NULL 
         OR calls.analysis_summary IS NOT NULL
      ORDER BY COALESCE(calls.analysis_completed_at, calls.feedback_saved_at, calls.called_at) DESC
      LIMIT 500
  `);

  const storedFeedback = feedbackRows.map((row) => {
    const stars = normalizeRating(row.stars || row.extracted_rating);
    const sentiment = normalizeSentiment(row.sentiment_label || row.sentiment || row.category);
    const followUpAnswers = getFollowUpAnswers(parseAnalysisJson(row.analysis_json));
    return {
      id: row.id,
      feedback_id: row.id,
      customer_id: row.customer_id,
      call_id: row.call_id,
      customer_name: row.customer_name,
      customer_phone: row.customer_phone,
      review_text: row.review_text || row.extracted_review_text || row.analysis_summary || '',
      category: categoryFromAnalysis({ stars, sentiment }),
      stars,
      sentiment,
      call_type: row.call_type,
      outcome: row.outcome,
      analysis_status: row.analysis_status,
      transcript_status: row.transcript_status,
      transcript_available: Boolean(row.transcript_available),
      source: row.source || (row.call_id ? 'call_analysis' : 'manual'),
      submitted_at: row.submitted_at || row.called_at,
      ...followUpAnswers
    };
  });

  const analysisFeedback = analyzedCalls
    .filter((row) => !linkedCallIds.has(Number(row.call_id)))
    .map((row) => {
      const stars = normalizeRating(row.stars);
      const sentiment = normalizeSentiment(row.sentiment_label || row.sentiment);
      const followUpAnswers = getFollowUpAnswers(parseAnalysisJson(row.analysis_json));
      return {
        id: `analysis-${row.call_id}`,
        feedback_id: null,
        customer_id: row.customer_id,
        call_id: row.call_id,
        customer_name: row.customer_name,
        customer_phone: row.customer_phone,
        review_text: row.extracted_review_text || row.analysis_summary || row.summary || row.report_excerpt || '',
        category: categoryFromAnalysis({ stars, sentiment }),
        stars,
        sentiment,
        call_type: row.call_type,
        outcome: row.outcome,
        analysis_status: row.analysis_status,
        transcript_status: row.transcript_status,
        transcript_available: Boolean(row.transcript_available),
        source: 'call_analysis',
        submitted_at: row.analysis_completed_at || row.feedback_saved_at || row.called_at,
        ...followUpAnswers
      };
    })
    .filter((row) => row.review_text || row.stars || row.sentiment !== 'neutral' || row.call_type === 'THREE_MONTH_FOLLOWUP');

  return [...storedFeedback, ...analysisFeedback]
    .sort((a, b) => new Date(b.submitted_at || 0) - new Date(a.submitted_at || 0));
}

function buildFeedbackOverview(feedback) {
  const rated = feedback.filter((item) => item.stars > 0);
  const sentiment = { positive: 0, neutral: 0, negative: 0 };
  const ratings = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  const callTypes = { review: 0, follow_up: 0, manual: 0 };

  feedback.forEach((item) => {
    sentiment[item.sentiment] = (sentiment[item.sentiment] || 0) + 1;
    if (item.stars >= 1 && item.stars <= 5) ratings[item.stars] += 1;
    if (!item.call_id) callTypes.manual += 1;
    else if (String(item.call_type || '').toUpperCase() === 'THREE_MONTH_FOLLOWUP') callTypes.follow_up += 1;
    else callTypes.review += 1;
  });

  const averageRating = rated.length
    ? rated.reduce((total, item) => total + item.stars, 0) / rated.length
    : 0;

  return {
    metrics: {
      total: feedback.length,
      average_rating: Number(averageRating.toFixed(1)),
      positive_rate: feedback.length ? Math.round((sentiment.positive / feedback.length) * 100) : 0,
      with_transcript: feedback.filter((item) => item.transcript_available).length
    },
    sentiment,
    ratings,
    call_types: callTypes,
    recent: feedback.slice(0, 5)
  };
}

router.get('/overview', async (req, res) => {
  try {
    const feedback = await listUnifiedFeedback();
    res.json(buildFeedbackOverview(feedback));
  } catch (error) {
    console.error('Error fetching feedback overview:', error);
    res.status(500).json({ error: error.message });
  }
});

router.get('/items', async (req, res) => {
  try {
    res.json(await listUnifiedFeedback());
  } catch (error) {
    console.error('Error fetching feedback items:', error);
    res.status(500).json({ error: error.message });
  }
});

// Backward-compatible list endpoint used by the overview dashboard.
router.get('/', async (req, res) => {
  try {
    const feedback = await listUnifiedFeedback();
    console.log(`[FEEDBACK_ANALYSIS_RECORDS_FOUND] count=${feedback.length}`);
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
    const fbPositive = feedback.filter((item) => normalizeRating(item.stars) >= 4);
    const callsPositive = recentCalls
      .filter((c) => normalizeRating(c.extracted_rating) >= 4 && !feedback.find(f => f.call_id === c.id))
      .map((c) => ({ ...c, stars: normalizeRating(c.extracted_rating), review_text: c.extracted_review_text }));
    const positiveFeedback = [...fbPositive, ...callsPositive];

    // Negative Feedback
    const fbNegative = feedback.filter((item) => normalizeRating(item.stars) > 0 && normalizeRating(item.stars) <= 2);
    const callsNegative = recentCalls
      .filter((c) => normalizeRating(c.extracted_rating) > 0 && normalizeRating(c.extracted_rating) <= 2 && !feedback.find(f => f.call_id === c.id))
      .map((c) => ({ ...c, stars: normalizeRating(c.extracted_rating), review_text: c.extracted_review_text }));
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
