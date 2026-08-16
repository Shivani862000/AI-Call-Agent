/**
 * src/conversation-state.js
 * Call conversation state machine — turn instructions, hangup detection, sentiment.
 */

'use strict';

const { CALL_TYPES, LIVE_MAX_RESPONSE_TOKENS } = require('./config');
const { normalizeOutboundCallType, formatOutboundCallTypeLabel } = require('./helpers');
const { FINAL_CLOSING_LINE } = require('../prompts/closing.ts');

// ── Sentiment evaluation ───────────────────────────────────────────────────────

function evaluateLiveSentimentLabel(text) {
  const normalized = String(text || '').toLowerCase();
  const negative = ['problem', 'issue', 'bad', 'rude', 'wait', 'dirty', 'complaint', 'angry', 'nahi', 'galat'];
  const positive = ['good', 'great', 'achha', 'accha', 'sahi', 'helpful', 'clean', 'thank'];
  const negativeCount = negative.filter((word) => normalized.includes(word)).length;
  const positiveCount = positive.filter((word) => normalized.includes(word)).length;

  if (negativeCount > positiveCount && negativeCount > 0) {
    return { label: 'negative', score: -0.75 };
  }

  if (positiveCount > negativeCount && positiveCount > 0) {
    return { label: 'positive', score: 0.65 };
  }

  return { label: 'neutral', score: 0 };
}

// ── Auto-hangup detection ──────────────────────────────────────────────────────

function shouldAutoHangupAfterAgentTurn(text) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim().toLowerCase();
  if (!normalized) {
    return false;
  }

  // User specifically requested to ONLY disconnect if this exact phrase is spoken
  return /Aapka din shubh ho/i.test(normalized);
}

function estimateHangupDelayMs(text) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim().toLowerCase();
  if (!normalized) {
    return 4500;
  }

  const strongClosingPatterns = [
    /google form/i,
    /din shubh ho/i,
    /goodbye/i,
    /namaste/i,
    /aapka samay dene ke liye/i,
    /aapke feedback ke liye dhanyavaad/i
  ];

  if (strongClosingPatterns.some((pattern) => pattern.test(normalized))) {
    return 1800;
  }

  const length = normalized.length;
  return Math.min(7000, Math.max(2800, 1800 + (length * 24)));
}

// ── Hindi/English text helpers ─────────────────────────────────────────────────

function normalizeHindiEnglishText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function isGreetingOnly(text) {
  const normalized = normalizeHindiEnglishText(text).replace(/[.,!?।]/g, '').trim();
  return ['hello', 'helo', 'hi', 'haan hello', 'ji hello', 'namaste', 'हेलो', 'नमस्ते'].includes(normalized);
}

function isAffirmativeReply(text) {
  const normalized = normalizeHindiEnglishText(text);
  return /(^|\b)(haan|han|ha|yes|yeah|ji|jee|okay|ok|theek|thik|sure)(\b|$)/i.test(normalized)
    || /हाँ|हां|जी|ठीक/.test(text);
}

function isNegativeOrBusyReply(text) {
  const normalized = normalizeHindiEnglishText(text);
  return /(busy|baad mein|bad mein|later|not now|driving|meeting|stop|band|interested nahi)/i.test(normalized)
    || /बाद में|व्यस्त|बंद/.test(text);
}

function isNoReply(text) {
  const normalized = normalizeHindiEnglishText(text);
  return /(^|\b)(nahi|nahin|no|nope|not yet|abhi nahi)(\b|$)/i.test(normalized)
    || /नहीं|नही/.test(text);
}

// ── Review Call turn instruction builder ───────────────────────────────────────

function buildReviewCallTurnInstruction(customerReply, state) {
  if (state.step === 'intro') {
    state.step = 'problem_check';
  }

  const markCompletedAfterReply = () => {
    state.step = 'completed';
    state.conversationState = 'COMPLETED';
    state.conversationCompleted = true;
    state.endCall = true;
    state.endCallAfterNextReply = true;
  };

  if (state.step === 'problem_check') {
    if (isNegativeOrBusyReply(customerReply)) {
      markCompletedAfterReply();
      return `Donor wants to stop or is busy. Say exactly: "Koi baat nahi sir. ${FINAL_CLOSING_LINE}" Then end the call.`;
    }

    if (isNoReply(customerReply)) {
      state.step = 'feedback';
      return 'Donor had no problem. Say exactly: "OKK, Thankyou Sir! Sir, aapko hamare yahan blood donate karna kaisa laga?"';
    }

    if (isAffirmativeReply(customerReply)) {
      state.step = 'issue_detail';
      return 'Donor had a problem. Say exactly: "Kya problem hui Sir?"';
    }

    return 'Clarify briefly. Say exactly: "Sir, blood donate karne ke baad aapko koi dikkat ya problem hui thi?"';
  }

  if (state.step === 'issue_detail') {
    state.step = 'feedback';
    return 'Capture the issue from the donor response. Say exactly: "Sir, hum apne adhikari ko batayenge. Next time poora dhyan rakhenge. Sorry Sir. Sir, aapko hamare yahan blood donate karna kaisa laga?"';
  }

  if (state.step === 'feedback') {
    markCompletedAfterReply();
    return `Acknowledge the donor feedback warmly in one short sentence. Then say exactly: "Sir, humne aapke paas ek video send ki hai. Usko please Like, Comment karein aur Channel ko Subscribe karein. Hamaara Facebook aur Google par Apna Blood Bank ke naam se page bhi hai. Usse bhi Like, Share, Comment aur Subscribe karein, taaki aage ki activities ke baare mein aapko pata lagta rahe. ${FINAL_CLOSING_LINE}" Then end the call.`;
  }

  markCompletedAfterReply();
  return `Say exactly: "${FINAL_CLOSING_LINE}" Then end the call.`;
}

// ── Three Month Follow-up turn instruction builder ─────────────────────────────

function buildThreeMonthFollowupTurnInstruction(customerReply, state) {
  const markCompletedAfterReply = () => {
    state.step = 'completed';
    state.conversationState = 'COMPLETED';
    state.conversationCompleted = true;
    state.endCall = true;
    state.endCallAfterNextReply = true;
  };

  if (state.step === 'intro') {
    if (isNegativeOrBusyReply(customerReply) || isNoReply(customerReply)) {
      markCompletedAfterReply();
      return `Wrong person or donor declined. Say exactly: "Koi baat nahi sir. ${FINAL_CLOSING_LINE}" Then end the call.`;
    }

    state.step = 'donated_again';
    return 'Donor confirmed identity. Say exactly: "Aapne kuch mahine pehle blood donate kiya tha. Sir, blood donation ke 3 mahine poore ho gaye hain. Kya aapne uske baad dobara blood donate kiya hai?"';
  }

  if (state.step === 'donated_again') {
    if (isAffirmativeReply(customerReply)) {
      state.step = 'donation_date';
      return 'Donor donated again. Say exactly: "Bahut achha sir. Kab donate kiya tha?"';
    }

    if (isNoReply(customerReply)) {
      state.step = 'plan_to_donate';
      return 'Donor has not donated again. Say exactly: "Hamare yahan garbhvati mahilaon aur thalassemia se grast bachchon ko free blood diya jata hai. Yadi sambhav ho to kisi bhi din nashta karne ke baad subah 9 baje se shaam 5 baje ke beech Apna Blood Centre aa sakte hain. Kya aap is baar donate karne ka plan kar sakte hain Sir?"';
    }

    return 'Clarify briefly. Say exactly: "Kya aapne 3 mahine ke baad dobara blood donate kiya hai?"';
  }

  if (state.step === 'donation_date') {
    state.step = 'donation_place';
    return 'Capture the donation date. Say exactly: "Kahan donate kiya tha?"';
  }

  if (state.step === 'donation_place') {
    markCompletedAfterReply();
    return `Capture the donation place. Say exactly: "Bahut achha kaam kiya sir. ${FINAL_CLOSING_LINE}" Then end the call.`;
  }

  if (state.step === 'plan_to_donate') {
    markCompletedAfterReply();
    return `Acknowledge the donor warmly in one short sentence. Then say exactly: "${FINAL_CLOSING_LINE}" Then end the call.`;
  }

  markCompletedAfterReply();
  return `Say exactly: "${FINAL_CLOSING_LINE}" Then end the call.`;
}

// ── Composite turn instruction builder ─────────────────────────────────────────

function buildOutboundDemoTurnInstruction(callerText, state, clientName, customerName, callType = CALL_TYPES.REVIEW_CALL) {
  const customerReply = String(callerText || '').trim();
  const prefix = [
    `Customer said: ${customerReply}`,
    'Respond in simple Hindi/Hinglish, natural phone tone.',
    `Call type: ${formatOutboundCallTypeLabel(callType)}.`,
    'Keep it concise unless closing.',
    'Ask only one question.',
    'Do not repeat the full greeting or restart the call.',
    `Max response tokens: ${LIVE_MAX_RESPONSE_TOKENS}.`,
    'When all required answers are captured, say the final thank-you only once and internally set END_CALL=true.',
    'Never say "end_call" or "END_CALL=true" aloud.',
    'CRITICAL: After saying the required final closing line, the conversation is finished.',
    'Do not answer any further customer speech. Do not repeat closing messages.',
    'Do not continue talking. Do not provide additional information. Immediately end the call.'
  ];

  const instruction = normalizeOutboundCallType(callType) === CALL_TYPES.THREE_MONTH_FOLLOWUP
    ? buildThreeMonthFollowupTurnInstruction(customerReply, state, clientName, customerName)
    : buildReviewCallTurnInstruction(customerReply, state, clientName, customerName);

  return `${prefix.join('\n')}\n${instruction}`;
}

module.exports = {
  evaluateLiveSentimentLabel,
  shouldAutoHangupAfterAgentTurn,
  estimateHangupDelayMs,
  normalizeHindiEnglishText,
  isGreetingOnly,
  isAffirmativeReply,
  isNegativeOrBusyReply,
  isNoReply,
  buildReviewCallTurnInstruction,
  buildThreeMonthFollowupTurnInstruction,
  buildOutboundDemoTurnInstruction
};
