const express = require('express');
const router = express.Router();
const { dbRun, dbGet, dbAll } = require('../db');
const { categorizeFeedback } = require('../services/openai');

// Manual feedback entry
router.post('/manual', async (req, res) => {
  try {
    const { customer_id, review_text, stars } = req.body;

    if (!customer_id || !review_text) {
      return res.status(400).json({ error: 'Customer ID and review text are required' });
    }

    // Categorize using OpenAI
    const categorization = await categorizeFeedback(review_text, stars || 3);

    // Save to feedback table
    const result = await dbRun(
      'INSERT INTO feedback (customer_id, review_text, category, stars, submitted_at) VALUES (?, ?, ?, ?, ?)',
      [customer_id, review_text, categorization.category, stars || null, new Date().toISOString()]
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
        c.name as customer_name,
        f.review_text,
        f.category,
        f.stars,
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

module.exports = router;
