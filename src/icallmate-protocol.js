/**
 * src/icallmate-protocol.js
 * Small protocol decisions shared by the iCallMate media bridge and tests.
 */

'use strict';

function shouldStartAiBridgeForEvent(eventName, alreadyAnswered = false) {
  const event = String(eventName || '').trim().toLowerCase();
  return event === 'answer' || (event === 'media' && !alreadyAnswered);
}

function buildReverseHangupEvent({ streamId, callerId, reason }) {
  return {
    event: 'reverse-hangup-call',
    streamId: String(streamId || ''),
    callerId: String(callerId || ''),
    source: 'ai',
    message: 'Call Dropped on BOT',
    reason: String(reason || 'model_requested_end_call')
  };
}

module.exports = {
  shouldStartAiBridgeForEvent,
  buildReverseHangupEvent
};
