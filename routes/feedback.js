const express = require('express');
function defaultCategorizeFeedback(...args) {
  return require('../services/openai').categorizeFeedback(...args);
}

function createFeedbackRouter({
  customers,
  feedback,
  getClientId,
  categorize = defaultCategorizeFeedback
}) {
  if (!customers || !feedback || typeof getClientId !== 'function') {
    throw new TypeError('Feedback router requires customers, feedback, and getClientId dependencies');
  }

  const router = express.Router();

  router.post('/manual', async (req, res) => {
    try {
      const clientId = await Promise.resolve(getClientId(req));
      const customerId = Number(req.body.customer_id);
      const reviewText = String(req.body.review_text || '').trim();
      const stars = Number(req.body.stars || 0);
      const fieldErrors = {};

      if (!Number.isSafeInteger(customerId) || customerId <= 0) {
        fieldErrors.customer_id = 'Please select a customer';
      }
      if (!reviewText) {
        fieldErrors.review_text = 'Review text is required';
      } else if (reviewText.length < 5) {
        fieldErrors.review_text = 'Review text should be at least 5 characters';
      } else if (reviewText.length > 1000) {
        fieldErrors.review_text = 'Review text must be 1000 characters or fewer';
      }
      if (!Number.isInteger(stars) || stars < 1 || stars > 5) {
        fieldErrors.stars = 'Rating must be between 1 and 5';
      }
      if (Object.keys(fieldErrors).length > 0) {
        return res.status(400).json({ error: 'Please fix the highlighted fields', fieldErrors });
      }

      const customer = await customers.findById(clientId, customerId);
      if (!customer) {
        return res.status(404).json({
          error: 'Customer not found',
          fieldErrors: { customer_id: 'Selected customer no longer exists' }
        });
      }

      const categorization = await categorize(reviewText, stars);
      const saved = await feedback.create(clientId, {
        customer_id: customerId,
        review_text: reviewText,
        category: categorization.category,
        stars,
        submitted_at: new Date().toISOString(),
        source: 'manual'
      });
      return res.json({
        id: saved.id,
        category: categorization.category,
        reason: categorization.reason
      });
    } catch (error) {
      console.error('Error saving feedback:', error);
      return res.status(500).json({ error: error.message });
    }
  });

  router.get('/', async (req, res) => {
    try {
      const clientId = await Promise.resolve(getClientId(req));
      return res.json(await feedback.list(clientId));
    } catch (error) {
      console.error('Error fetching feedback:', error);
      return res.status(500).json({ error: error.message });
    }
  });

  return router;
}

module.exports = { createFeedbackRouter };
