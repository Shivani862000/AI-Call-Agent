'use strict';

function dequeueAudioFrame(buffer, { chunkBytes = 640, turnComplete = false } = {}) {
  const audioBuffer = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);

  if (audioBuffer.length >= chunkBytes) {
    return {
      chunk: audioBuffer.subarray(0, chunkBytes),
      remaining: audioBuffer.subarray(chunkBytes),
      turnComplete,
      drainComplete: false
    };
  }

  if (turnComplete && audioBuffer.length > 0) {
    return {
      chunk: audioBuffer,
      remaining: Buffer.alloc(0),
      turnComplete: true,
      drainComplete: false
    };
  }

  return {
    chunk: null,
    remaining: audioBuffer,
    turnComplete: false,
    drainComplete: turnComplete && audioBuffer.length === 0
  };
}

function calculateHangupDelayMs({
  audioDrained = false,
  finalAudioGraceMs,
  pendingAudioMs = 0,
  estimatedSpeechMs = 0
} = {}) {
  const graceMs = Math.max(Number(finalAudioGraceMs || 0), 0);
  if (audioDrained) {
    return graceMs;
  }

  return Math.max(
    graceMs,
    Math.max(Number(pendingAudioMs || 0), 0) + 1000,
    Math.max(Number(estimatedSpeechMs || 0), 0)
  );
}

module.exports = {
  dequeueAudioFrame,
  calculateHangupDelayMs
};
