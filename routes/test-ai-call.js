const express = require('express');
const {
  startBrowserTestCall,
  handleUserMessage,
  endBrowserTestCall
} = require('../services/test-ai-call');

const router = express.Router();

function sendError(res, error) {
  const statusCode = error.statusCode || 500;
  if (statusCode >= 500) {
    console.error('[TEST AI CALL API]', error);
  }
  res.status(statusCode).json({
    error: error.message || 'Browser test call request failed'
  });
}

router.post('/start', async (req, res) => {
  try {
    const result = await startBrowserTestCall();
    res.json(result);
  } catch (error) {
    sendError(res, error);
  }
});

router.post('/message', async (req, res) => {
  try {
    const result = await handleUserMessage({
      sessionId: req.body.sessionId,
      message: req.body.message
    });
    res.json(result);
  } catch (error) {
    sendError(res, error);
  }
});

router.post('/end', async (req, res) => {
  try {
    const result = await endBrowserTestCall({
      sessionId: req.body.sessionId
    });
    res.json(result);
  } catch (error) {
    sendError(res, error);
  }
});

module.exports = router;
