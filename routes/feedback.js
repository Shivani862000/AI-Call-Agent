const express = require('express');
const router = express.Router();
const Customer = require('../src/models/Customer');
const Feedback = require('../src/models/Feedback');
const Call = require('../src/models/Call');
const { categorizeFeedback } = require('../services/gemini');
const { activeRecordFilter } = require('../src/webmaster/lifecycle');

// Manual feedback entry
router.post('/manual', async (req, res) => {
  try {
    const customer_id = req.body.customer_id;
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

    const customer = await Customer.findOne(activeRecordFilter({ _id: customer_id, tenantId: req.tenantId }));
    if (!customer) {
      return res.status(404).json({ error: 'Customer not found', fieldErrors: { customer_id: 'Selected customer no longer exists' } });
    }

    // Categorize feedback using the local heuristic classifier
    const categorization = await categorizeFeedback(review_text, stars);

    // Save to feedback table
    const feedback = await Feedback.create({
      tenantId: req.tenantId,
      customerId: customer_id,
      review_text,
      category: categorization.category,
      rating: stars,
      source: 'manual'
    });

    res.json({
      id: feedback._id,
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

async function listUnifiedFeedback(tenantId) {
  const manualFeedbacks = await Feedback.find(activeRecordFilter({ tenantId }))
    .populate('customerId', 'name phone')
    .populate('callId')
    .sort({ created_at: -1 })
    .limit(500)
    .lean();

  const linkedCallIds = new Set(manualFeedbacks.map(f => f.callId?._id?.toString()).filter(Boolean));

  const analyzedCalls = await Call.find(activeRecordFilter({
    tenantId,
    $or: [
      { extracted_rating: { $ne: null } },
      { sentiment: { $ne: null } },
      { analysis_summary: { $ne: null } }
    ]
  }))
    .populate('customerId', 'name phone')
    .sort({ analysis_completed_at: -1, started_at: -1 })
    .limit(500)
    .lean();

  const storedFeedback = manualFeedbacks.map((row) => {
    const callData = row.callId || {};
    const stars = normalizeRating(row.rating || callData.extracted_rating);
    const sentiment = normalizeSentiment(callData.sentiment_label || callData.sentiment || row.category);
    const followUpAnswers = getFollowUpAnswers(parseAnalysisJson(callData.analysis_json));
    
    return {
      id: row._id,
      feedback_id: row._id,
      customer_id: row.customerId?._id,
      call_id: callData._id,
      customer_name: row.customerId?.name,
      customer_phone: row.customerId?.phone,
      review_text: row.review_text || callData.extracted_review_text || callData.analysis_summary || '',
      category: categoryFromAnalysis({ stars, sentiment }),
      stars,
      sentiment,
      call_type: callData.call_type,
      outcome: callData.outcome,
      analysis_status: callData.analysis_status,
      transcript_status: callData.transcript_status,
      transcript_available: Boolean(callData.transcript),
      source: row.source || (callData._id ? 'call_analysis' : 'manual'),
      submitted_at: row.created_at || callData.started_at,
      ...followUpAnswers
    };
  });

  const analysisFeedback = analyzedCalls
    .filter((row) => !linkedCallIds.has(row._id.toString()))
    .map((row) => {
      const stars = normalizeRating(row.extracted_rating);
      const sentiment = normalizeSentiment(row.sentiment_label || row.sentiment);
      const followUpAnswers = getFollowUpAnswers(parseAnalysisJson(row.analysis_json));
      return {
        id: `analysis-${row._id}`,
        feedback_id: null,
        customer_id: row.customerId?._id,
        call_id: row._id,
        customer_name: row.customerId?.name,
        customer_phone: row.customerId?.phone,
        review_text: row.extracted_review_text || row.analysis_summary || '',
        category: categoryFromAnalysis({ stars, sentiment }),
        stars,
        sentiment,
        call_type: row.call_type,
        outcome: row.outcome,
        analysis_status: row.analysis_status,
        transcript_status: row.transcript_status,
        transcript_available: Boolean(row.transcript),
        source: 'call_analysis',
        submitted_at: row.analysis_completed_at || row.started_at,
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
    const feedback = await listUnifiedFeedback(req.tenantId);
    res.json(buildFeedbackOverview(feedback));
  } catch (error) {
    console.error('Error fetching feedback overview:', error);
    res.status(500).json({ error: error.message });
  }
});

router.get('/items', async (req, res) => {
  try {
    res.json(await listUnifiedFeedback(req.tenantId));
  } catch (error) {
    console.error('Error fetching feedback items:', error);
    res.status(500).json({ error: error.message });
  }
});

// Backward-compatible list endpoint used by the overview dashboard.
router.get('/', async (req, res) => {
  try {
    const feedback = await listUnifiedFeedback(req.tenantId);
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
