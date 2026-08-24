const express = require('express');
const {
  startTestCall,
  sendUserResponse,
  endTestCall
} = require('../services/test-call');

const router = express.Router();

function sendError(res, error) {
  const statusCode = error.statusCode || 500;
  if (statusCode >= 500) {
    console.error('[TEST CALL API]', error);
  }
  res.status(statusCode).json({
    error: error.message || 'Test call request failed',
    fieldErrors: error.fieldErrors || undefined
  });
}

router.post('/start', async (req, res) => {
  try {
    const result = await startTestCall({
      patientName: req.body.patientName || req.body.name,
      phone: req.body.phone,
      tenantId: req.tenantId ?? null
    });
    res.json(result);
  } catch (error) {
    sendError(res, error);
  }
});

router.post('/:sessionId/respond', async (req, res) => {
  try {
    const result = await sendUserResponse({
      sessionId: req.params.sessionId,
      message: req.body.message
    });
    res.json(result);
  } catch (error) {
    sendError(res, error);
  }
});

router.post('/:sessionId/end', async (req, res) => {
  try {
    const result = await endTestCall({
      sessionId: req.params.sessionId,
      reason: req.body.reason || 'ended_by_admin'
    });
    res.json(result);
  } catch (error) {
    sendError(res, error);
  }
});

module.exports = router;
