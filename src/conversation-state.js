/**
 * src/conversation-state.js
 * Call conversation state machine — turn instructions, hangup detection, sentiment.
 */

'use strict';

const { CALL_TYPES, LIVE_MAX_RESPONSE_TOKENS } = require('./config');
const { normalizeOutboundCallType, formatOutboundCallTypeLabel } = require('./helpers');
const { FINAL_CLOSING_LINE, buildClosingLine } = require('../prompts/closing.ts');
const { describeEligibility, describeVisit } = require('../prompts/review-calling.ts');

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

/**
 * Someone saying they are not the person the call is for.
 *
 * "galat number" contains no "nahi" and no busy word, so neither existing
 * classifier caught it and the call read a wrong number as a confirmed
 * identity -- then told them this person had donated blood.
 */
function isWrongPersonReply(text) {
  const normalized = normalizeHindiEnglishText(text);
  return /(galat number|galat no|wrong number|wrong no|koi aur|kaun bol|kaun hai|aap kaun|main nahi hoon|main nahin hoon|yahan nahi|ghar par nahi|available nahi|aisa koi nahi|is naam ka koi|not here|not available|speaking to)/i.test(normalized)
    || /गलत नंबर|कोई और|कौन बोल/.test(text);
}

function isPositiveExperienceReply(text) {
  const normalized = normalizeHindiEnglishText(text);
  return /(ach+h?a|ac+h?a|badhiya|badiya|good|great|fine|excellent|smooth|sahi|satisfied|positive|bahut achhi)/i.test(normalized)
    || /अच्छा|अच्छी|बढ़िया|सही|संतुष्ट/.test(text);
}

function isNegativeExperienceReply(text) {
  const normalized = normalizeHindiEnglishText(text);
  return /(kharab|bura|bekar|\bbad\b|\bpoor\b|not good|ach+h?a nahi|ac+h?a nahi|problem|dikkat|pareshani|complaint|unsatisfied|rude|dirty)/i.test(normalized)
    || /खराब|बुरा|बेकार|समस्या|दिक्कत|परेशानी|शिकायत/.test(text);
}

/**
 * "pata nahi" and "dekhta hoon" contain "nahi", so isNoReply reads them as a
 * firm decline. On the appointment question that would report a donor who was
 * merely undecided to the team as having refused, so uncertainty is checked
 * first and recorded as its own answer.
 */
function isUncertainReply(text) {
  const normalized = normalizeHindiEnglishText(text);
  return /(pata nahi|nahi pata|dekhte hain|dekhta hoon|dekhti hoon|dekh kar|shayad|maybe|not sure|pakka nahi|confirm nahi|baad mein bat|soch kar|sochta hoon|sochti hoon)/i.test(normalized)
    || /पता नहीं|शायद|देखते हैं|सोच/.test(text);
}

// ── Review Call turn instruction builder ───────────────────────────────────────

function buildReviewCallTurnInstruction(customerReply, state, clientName, customerName) {
  const name = String(customerName || '').trim();
  const address = name ? `${name} ji, ` : '';
  const closing = buildClosingLine(name);
  const redonationQuestion = `${describeEligibility(state.lastVisitDate)} aap dobara blood donate kar sakte hain. `
    + 'Kya aap abhi se appointment ka slot book karna chahenge?';
  const markCompletedAfterReply = () => {
    state.step = 'completed';
    state.conversationState = 'COMPLETED';
    state.conversationCompleted = true;
    state.endCall = true;
    state.endCallAfterNextReply = true;
  };

  // The opening only asks who picked up. Nothing about the donation is said
  // until they confirm, so a wrong number never learns that this person donated.
  if (state.step === 'intro') {
    if (isWrongPersonReply(customerReply) || isNegativeOrBusyReply(customerReply) || isNoReply(customerReply)) {
      markCompletedAfterReply();
      // Deliberately the unnamed closing: saying "Dhanyavaad Ankita ji" to
      // someone who just said they are not Ankita confirms whose number it is.
      return `Wrong person, or the donor cannot talk. Say exactly: "Koi baat nahi. ${FINAL_CLOSING_LINE}" Then end the call. Do not mention the donation or the patient's name.`;
    }

    state.step = 'experience';
    return `Identity confirmed. Say exactly: "Aapne ${describeVisit(state.lastVisitDate)} blood donate kiya tha, uske liye dhanyavaad. Aapka experience kaisa raha?"`;
  }

  if (state.step === 'experience') {
    if (isNegativeOrBusyReply(customerReply)) {
      markCompletedAfterReply();
      return `Donor wants to stop or is busy. Say exactly: "Koi baat nahi. ${closing}" Then end the call.`;
    }

    if (isNegativeExperienceReply(customerReply)) {
      state.step = 'issue_detail';
      return 'The donor reported a negative experience. Say exactly: "Maaf kijiye. Kripya batayein aapko kya pareshani hui thi?"';
    }

    if (isPositiveExperienceReply(customerReply)) {
      state.step = 'redonation';
      return `Say exactly: "Bahut achhi baat hai, sunkar khushi hui. ${redonationQuestion}"`;
    }

    return `The experience answer was unclear. Say exactly: "${address}blood donate karne ka aapka experience achha tha ya koi pareshani hui thi?"`;
  }

  if (state.step === 'issue_detail') {
    state.step = 'redonation';
    return `Capture the issue. Then say exactly: "Main aapki baat sambandhit adhikari tak pahucha dungi. Agli baar hum aur dhyan rakhenge. ${redonationQuestion}"`;
  }

  // The donor's answer to the appointment question. Recorded on the call by the
  // post-call analysis; the agent cannot confirm a slot itself.
  if (state.step === 'redonation') {
    markCompletedAfterReply();
    if (isAffirmativeReply(customerReply)) {
      state.redonationInterest = 'yes';
      return `The donor wants a slot. Say exactly: "Bahut achha. Hamari team aapko call karke slot confirm kar degi. ${closing}" Then end the call.`;
    }
    if (isUncertainReply(customerReply)) {
      state.redonationInterest = 'unclear';
      return `The donor is undecided. Say exactly: "Koi baat nahi, aap jab chahein hamse sampark kar sakte hain. ${closing}" Then end the call.`;
    }
    if (isNoReply(customerReply) || isNegativeOrBusyReply(customerReply)) {
      state.redonationInterest = 'no';
      return `The donor declined a slot. Say exactly: "Koi baat nahi, aap jab chahein hamse sampark kar sakte hain. ${closing}" Then end the call.`;
    }
    state.redonationInterest = 'unclear';
    return `Acknowledge the donor's answer briefly without confirming any appointment. Then say exactly: "${closing}" Then end the call.`;
  }

  markCompletedAfterReply();
  return `Say exactly: "${FINAL_CLOSING_LINE}" Then end the call.`;
}

// ── Three Month Follow-up turn instruction builder ─────────────────────────────

function buildThreeMonthFollowupTurnInstruction(customerReply, state, clientName, customerName) {
  const name = String(customerName || '').trim();
  const closing = buildClosingLine(name);
  const centre = clientName || 'Apna Blood Centre';
  const slotQuestion = 'Kya aap abhi se appointment ka slot book karna chahenge?';
  const markCompletedAfterReply = () => {
    state.step = 'completed';
    state.conversationState = 'COMPLETED';
    state.conversationCompleted = true;
    state.endCall = true;
    state.endCallAfterNextReply = true;
  };

  if (state.step === 'intro') {
    if (isWrongPersonReply(customerReply) || isNegativeOrBusyReply(customerReply) || isNoReply(customerReply)) {
      markCompletedAfterReply();
      // The unnamed closing: naming the donor to someone who just said they
      // are not them confirms whose number this is.
      return `Wrong person or donor declined. Say exactly: "Koi baat nahi. ${FINAL_CLOSING_LINE}" Then end the call. Do not mention the donation or the donor's name.`;
    }

    state.step = 'donated_again';
    return `Donor confirmed identity. Say exactly: "Aapne ${describeVisit(state.lastVisitDate)} blood donate kiya tha, uske liye dhanyavaad. Blood donation ke 3 mahine poore ho gaye hain. Kya aapne uske baad dobara blood donate kiya hai?"`;
  }

  if (state.step === 'donated_again') {
    if (isAffirmativeReply(customerReply)) {
      state.step = 'donation_date';
      state.donatedAgain = true;
      return 'Donor donated again. Say exactly: "Bahut achha. Kab donate kiya tha?"';
    }

    if (isNoReply(customerReply)) {
      state.step = 'plan_to_donate';
      return 'Donor has not donated again. Say exactly: "Hamare yahan garbhvati mahilaon aur thalassemia se grast bachchon ko free blood diya jata hai. Kya aap bhavishya mein blood donate karne mein ruchi rakhte hain?"';
    }

    return 'Clarify briefly. Say exactly: "Kya aapne 3 mahine ke baad dobara blood donate kiya hai?"';
  }

  if (state.step === 'donation_date') {
    state.step = 'donation_place';
    state.reportedDonationDate = String(customerReply || '').trim().slice(0, 200);
    return 'Capture the donation date. Say exactly: "Kahan donate kiya tha?"';
  }

  if (state.step === 'donation_place') {
    markCompletedAfterReply();
    state.reportedDonationPlace = String(customerReply || '').trim().slice(0, 200);
    state.step = 'appointment';
    // Eligibility runs from the donation they just reported, which is free text
    // rather than a date, so the interval is named without a specific day.
    return `Capture the donation place. Say exactly: "Bahut achha kaam kiya. Uske teen mahine baad aap dobara donate kar sakte hain. ${slotQuestion}"`;
  }

  if (state.step === 'plan_to_donate') {
    markCompletedAfterReply();
    if (isAffirmativeReply(customerReply)) {
      // Recorded in the same field the review call uses, so both call types
      // land in one working list instead of two.
      state.redonationInterest = 'yes';
      state.step = 'appointment';
      return `Say exactly: "Bahut achhi baat hai. Aapka yogdaan kisi ki jaan bacha sakta hai. Yadi sambhav ho to nashta karne ke baad subah 9 baje se shaam 5 baje ke beech ${centre} aa sakte hain. ${slotQuestion}"`;
    }
    if (isUncertainReply(customerReply)) {
      state.redonationInterest = 'unclear';
      return `Say exactly: "Theek hai. Yadi sambhav ho to nashta karne ke baad subah 9 baje se shaam 5 baje ke beech ${centre} aa sakte hain. ${closing}" Then end the call.`;
    }
    if (isNoReply(customerReply) || isNegativeOrBusyReply(customerReply)) {
      state.redonationInterest = 'no';
      return `Say exactly: "Theek hai. Yadi sambhav ho to nashta karne ke baad subah 9 baje se shaam 5 baje ke beech ${centre} aa sakte hain. ${closing}" Then end the call.`;
    }
    state.redonationInterest = 'unclear';
    return `Acknowledge the donor's response briefly. Then say exactly: "${closing}" Then end the call.`;
  }

  if (state.step === 'appointment') {
    markCompletedAfterReply();
    if (isUncertainReply(customerReply)) {
      state.redonationInterest = 'unclear';
      return `The donor is undecided. Say exactly: "Koi baat nahi, aap jab chahein hamse sampark kar sakte hain. ${closing}" Then end the call.`;
    }
    if (isAffirmativeReply(customerReply)) {
      state.redonationInterest = 'yes';
      return `The donor wants a slot. Say exactly: "Bahut achha. Hamari team aapko call karke slot confirm kar degi. ${closing}" Then end the call.`;
    }
    if (isNoReply(customerReply) || isNegativeOrBusyReply(customerReply)) {
      // A donor willing in principle but not ready to book is still a lead;
      // the earlier interest answer stands rather than being overwritten.
      if (state.redonationInterest !== 'yes') state.redonationInterest = 'no';
      return `The donor declined a slot. Say exactly: "Koi baat nahi, aap jab chahein hamse sampark kar sakte hain. ${closing}" Then end the call.`;
    }
    state.redonationInterest = state.redonationInterest || 'unclear';
    return `Acknowledge the answer briefly without confirming any appointment. Then say exactly: "${closing}" Then end the call.`;
  }

  markCompletedAfterReply();
  return `Say exactly: "${closing}" Then end the call.`;
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
  isPositiveExperienceReply,
  isNegativeExperienceReply,
  isUncertainReply,
  isWrongPersonReply,
  buildReviewCallTurnInstruction,
  buildThreeMonthFollowupTurnInstruction,
  buildOutboundDemoTurnInstruction
};
