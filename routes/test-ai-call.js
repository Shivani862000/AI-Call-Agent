const express = require('express');
const multer = require('multer');
const {
  startBrowserTestCall,
  handleUserAudio,
  handleUserMessage,
  endBrowserTestCall
} = require('../services/test-ai-call');

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 8 * 1024 * 1024
  }
});

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

router.post('/message-audio', upload.single('audio'), async (req, res) => {
  try {
    const result = await handleUserAudio({
      sessionId: req.body.sessionId,
      audioBuffer: req.file?.buffer,
      mimeType: req.file?.mimetype
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
