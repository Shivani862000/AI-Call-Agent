/**
 * src/conversation-state.js
 * Call conversation state machine — turn instructions, hangup detection, sentiment.
 */

'use strict';

const { CALL_TYPES, LIVE_MAX_RESPONSE_TOKENS } = require('./config');
const { normalizeOutboundCallType, formatOutboundCallTypeLabel } = require('./helpers');
const { FINAL_CLOSING_LINE, buildClosingLine, spokenName } = require('../prompts/closing.ts');
const { describeEligibility, describeVisit } = require('../prompts/review-calling.ts');
const { CLIENT_WITH_CITY } = require('../prompts/client.ts');
const {
  SELF_INTRODUCTION,
  lowerFirst,
  joinSpoken,
  identityQuestion,
  buildConfirmedPreamble
} = require('../prompts/identity.ts');
const { RATING_QUESTION } = require('./rating-question');
const { isFillerOnly } = require('./agent-speech');

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

/**
 * Whether a barge-in should be ignored.
 *
 * Cutting the agent off when the caller speaks is right in the middle of a
 * conversation and wrong at the end of one. Gemini raises its interrupt
 * whenever the VAD hears anything, and background noise on a mobile line is
 * enough: the queued goodbye was discarded mid-word and, because the hangup
 * fires once the audio buffer drains, the call then ended on the spot. From the
 * donor's side the agent stopped talking and hung up on them.
 *
 * Once the closing is being spoken there is nothing left to interrupt.
 */
function shouldIgnoreBargeIn({ hangupAfterAudioDrains, pendingHangup, state, openingInProgress } = {}) {
  return Boolean(
    // The opening carries the disclosure and the identity question, and the
    // caller's own "Hello" landed in the middle of it: two calls were cut at
    // "...quality ke liye record", so nobody was ever asked who they were and
    // the agent resumed mid-word. Someone saying hello as you introduce
    // yourself is not asking you to stop.
    openingInProgress
    || hangupAfterAudioDrains
    || pendingHangup
    || (state && (state.endCallAfterNextReply || state.conversationState === 'COMPLETED'))
  );
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

/**
 * Fold the nuqta out of Devanagari.
 *
 * Deepgram writes dizziness-and-trouble as "दिक़्क़त"; every keyword list in
 * this codebase spells it "दिक्कत". The nuqta (U+093C) is a diacritic, not a
 * different word, but it makes the two strings unequal, so a donor who
 * complained was invisible to every Hindi classifier we have. NFD splits the
 * precomposed letters (क़ is both U+0958 and क + U+093C) so either spelling
 * folds to the same text.
 */
function foldNuqta(value) {
  return String(value || '').normalize('NFD').replace(/़/g, '').normalize('NFC');
}

function normalizeHindiEnglishText(value) {
  return foldNuqta(value)
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function isGreetingOnly(text) {
  const normalized = normalizeHindiEnglishText(text).replace(/[.,!?।]/g, '').trim();
  return ['hello', 'helo', 'hi', 'hello hello', 'hello ji', 'haan hello', 'ji hello', 'hello haan', 'namaste', 'हेलो', 'हेलो जी', 'हेलो हेलो', 'नमस्ते'].includes(normalized);
}

/**
 * A question is not an answer.
 *
 * A donor asked "आप कहां से बोल रहे हो?" -- where are you calling from -- and
 * the flow took it as a yes and moved on to "Kab donate kiya tha?".
 */
function isQuestionReply(text) {
  const raw = String(text || '');
  if (/[?？]/.test(raw)) return true;
  const normalized = normalizeHindiEnglishText(raw);
  return /\b(kaun|kahan|kahaan|kyun|kyon|kaise|kab|kya aap|who is|where are|why are)\b/i.test(normalized)
    || /कौन|कहाँ|कहां|क्यों|कैसे/.test(normalized);
}

function isAffirmativeReply(text) {
  const normalized = normalizeHindiEnglishText(text);
  // A question is never a yes, however it is worded.
  if (isQuestionReply(text)) return false;
  return /(^|\b)(haan|han|ha|yes|yeah|ji|jee|okay|ok|theek|thik|sure)(\b|$)/i.test(normalized)
    // Anchored: "कहां" (where) contains "हां" (yes), so an unanchored
    // alternation read "where are you calling from" as agreement.
    || /(^|[\s,।"'(])(हाँ|हां|जी|ठीक|बिलकुल|बिल्कुल)([\s,।?.!"')]|$)/.test(normalized);
}

/**
 * "baad mein" is a brush-off on its own and part of a story with something in
 * front of it.
 *
 * A donor answered the experience question with "बहुत चक्कर आया उसके बाद में"
 * -- I felt very dizzy afterwards -- and the unanchored "बाद में" read it as
 * "call me later", so the agent said "Koi baat nahi" and hung up on a woman
 * describing an adverse reaction. Hindi marks the difference with "ke"/"के" on
 * the preceding word: "उसके बाद" and "dene ke baad" are "after that", while a
 * deferral has nothing before it.
 */
const LATER_DEFERRAL = /(?<!\bke\s)(?<!के\s)(baad mein|bad mein|बाद में)/;

function isNegativeOrBusyReply(text) {
  const normalized = normalizeHindiEnglishText(text);
  return /(busy|later|not now|driving|meeting|stop|band|interested nahi)/i.test(normalized)
    || LATER_DEFERRAL.test(normalized)
    || /व्यस्त|बंद/.test(normalized);
}

function isNoReply(text) {
  const normalized = normalizeHindiEnglishText(text);
  return /(^|\b)(nahi|nahin|no|nope|not yet|abhi nahi)(\b|$)/i.test(normalized)
    || /नहीं|नही/.test(normalized);
}

/**
 * Someone saying they are not the person the call is for.
 *
 * "galat number" contains no "nahi" and no busy word, so neither existing
 * classifier caught it and the call read a wrong number as a confirmed
 * identity -- then told them this person had donated blood.
 */
//
// "kaun bol raha hai" used to be on this list. It is a question, not a denial,
// and the commonest reply of all to "Kya meri baat Ankita ji se ho rahi hai?";
// reading it as a wrong number hung up on the patient for asking who called.
function isWrongPersonReply(text) {
  const normalized = normalizeHindiEnglishText(text);
  return /(galat number|galat no|wrong number|wrong no|koi aur|main nahi hoon|main nahin hoon|yahan nahi|ghar par nahi|available nahi|aisa koi nahi|is naam ka koi|not here|not available)/i.test(normalized)
    || /गलत नंबर|कोई और/.test(normalized);
}

/**
 * Someone winding the call up: "ok bye", "theek hai bye", "rakhta hoon".
 *
 * A donor said "Ok, bye" and was asked the same question again, because
 * nothing recognised it. Ending a call politely is not an unclear answer.
 */
function isGoodbyeReply(text) {
  const normalized = normalizeHindiEnglishText(text);
  return /\b(bye|goodbye|bye bye|rakhta hoon|rakhti hoon|rakhte hain|phone rakh|baad mein baat)\b/i.test(normalized)
    || /अलविदा|रखता हूँ|रखती हूँ/.test(normalized);
}

function isPositiveExperienceReply(text) {
  const normalized = normalizeHindiEnglishText(text);
  // "theek hai" is the commonest answer of all and matched nothing, in either
  // script, so the flow treated it as unintelligible and asked again.
  return /(ach+h?a|ac+h?a|badhiya|badiya|good|great|fine|excellent|smooth|sahi|satisfied|positive|bahut achhi|theek|thik)/i.test(normalized)
    || /अच्छा|अच्छी|बढ़िया|सही|संतुष्ट|ठीक|बढिया/.test(normalized);
}

/**
 * Fainting, dizziness, weakness, pain and nausea are the commonest reactions to
 * giving blood, and catching them the next day is the whole reason this call is
 * placed. None of them were on either list, so a donor who said "बहुत चक्कर
 * आया" was treated as having given no clear answer.
 */
function isNegativeExperienceReply(text) {
  const normalized = normalizeHindiEnglishText(text);
  return /(kharab|bura|bekar|\bbad\b|\bpoor\b|not good|ach+h?a nahi|ac+h?a nahi|problem|dikkat|pareshani|complaint|unsatisfied|rude|dirty)/i.test(normalized)
    || /(chakkar|behosh|behoshi|kamzor|kamjor|weakness|faint|dizzy|ulti|vomit|dard|\bpain\b|sujan|swelling|takleef)/i.test(normalized)
    || /खराब|बुरा|बेकार|समस्या|दिक्कत|परेशानी|शिकायत/.test(normalized)
    // Written without nuqta: normalizeHindiEnglishText folds it out of the
    // input, so a "कमज़ोर" here could never match. "कमजोर" catches both.
    || /चक्कर|बेहोश|कमजोर|उल्टी|दर्द|सूजन|तकलीफ/.test(normalized);
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
    || /पता नहीं|शायद|देखते हैं|सोच/.test(normalized);
}

/**
 * The centre takes walk-ins during opening hours and has no appointment system,
 * so nobody calls the donor back and no slot is ever confirmed. The call
 * records when the donor intends to come and says so plainly, rather than
 * promising a confirmation that would never arrive.
 */
const VISIT_TIME_QUESTION = 'Aap kis din aur kis samay aana chahenge?';

/**
 * The spoken number, or null.
 *
 * Shares the parser the post-call extraction uses, so "chaar" heard live and
 * "chaar" read back off the transcript can never disagree.
 */
function extractSpokenRating(text) {
  const { extractNumericRatingFromText } = require('../services/call-feedback');
  const score = extractNumericRatingFromText(text);
  return Number.isInteger(score) && score >= 1 && score <= 5 ? score : null;
}

function captureIntendedVisit(customerReply, state, closing) {
  state.intendedVisitNote = String(customerReply || '').trim().slice(0, 200);
  return `Capture when the donor intends to visit and repeat it back once. Then say exactly: `
    + `"Theek hai, humne note kar liya hai. Aapko alag se confirm karne ki zarurat nahi, `
    + `aap us din subah 9 baje se shaam 5 baje ke beech aa sakte hain. ${closing}" Then end the call.`;
}

// ── Identity check: the first step of every call ───────────────────────────────

/**
 * How many times the name question is asked again before the call gives up.
 * The opening asks once, so a caller who only ever says "Hello" hears it three
 * times in all.
 */
const IDENTITY_MAX_REASKS = 2;

/**
 * Whoever picked up saying that they are the person asked for.
 *
 * Anything that was not a refusal used to count, "Hello" included, so a caller
 * who had not taken in the question was told about the donation.
 */
function isIdentityConfirmation(text) {
  if (isGreetingOnly(text) || isQuestionReply(text)) return false;
  const normalized = normalizeHindiEnglishText(text);
  return isAffirmativeReply(text)
    || /\b(bol rah[aie]|boliye|bolo|bataiye|batao|speaking|main hi)\b/i.test(normalized)
    || /बोल रह|बोलिए|बोलो|बताइए|बताओ/.test(normalized);
}

function markCallCompleted(state) {
  state.step = 'completed';
  state.conversationState = 'COMPLETED';
  state.conversationCompleted = true;
  state.endCall = true;
  state.endCallAfterNextReply = true;
}

/**
 * The reply to the name question, for either call type.
 *
 * Returns { confirmed: true } once they say it is them; otherwise the
 * instruction for this turn, none of which mention the donation or name the
 * patient to someone who may not be them.
 */
function handleIdentityReply(customerReply, state, customerName) {
  const question = identityQuestion(customerName);
  // Deliberately the unnamed closing: saying "Dhanyavaad Ankita ji" to someone
  // who just said they are not Ankita confirms whose number it is.
  const close = `Say exactly: "Koi baat nahi. ${FINAL_CLOSING_LINE}" Then end the call. Do not mention the donation or the patient's name.`;

  if (isWrongPersonReply(customerReply) || isNegativeOrBusyReply(customerReply) || isNoReply(customerReply)) {
    state.identityOutcome = 'declined';
    markCallCompleted(state);
    return { instruction: `Wrong person, or the donor cannot talk. ${close}` };
  }
  if (isIdentityConfirmation(customerReply)) {
    state.identityOutcome = 'confirmed';
    return { confirmed: true };
  }

  state.identityReasks = (state.identityReasks || 0) + 1;
  if (state.identityReasks > IDENTITY_MAX_REASKS) {
    markCallCompleted(state);
    return { instruction: `Nobody has confirmed who they are. ${close}` };
  }
  // "Kaun bol raha hai?" is answered with who is calling -- which the old
  // opening told everyone anyway -- and the question is put back.
  // "Hello?" ends in a question mark but is still only a hello.
  if (isQuestionReply(customerReply) && !isGreetingOnly(customerReply)) {
    return { instruction: `They asked who is calling. Do not mention the donation. Say exactly: "${SELF_INTRODUCTION} ${question}"` };
  }
  return { instruction: `They have not said who they are yet. Do not mention the donation. Say exactly: "Ji, ${lowerFirst(question)}"` };
}

// ── Review Call turn instruction builder ───────────────────────────────────────

function buildReviewCallTurnInstruction(customerReply, state, clientName, customerName) {
  const name = spokenName(customerName);
  const address = name ? `${name} ji, ` : '';
  const closing = buildClosingLine(name);
  // Said once, on the way out. The review call runs the day after a donation,
  // when the donor cannot give blood for another three months, so it tells them
  // when they can and leaves it there. Arranging a visit belongs to the
  // three-month follow-up, which is placed when it is actually actionable.
  const invitation = `${describeEligibility(state.lastVisitDate)} aap dobara blood donate kar sakte hain, aapka swagat hai.`;
  const markCompletedAfterReply = () => markCallCompleted(state);

  // The opening only asks who picked up. Nothing about the donation is said
  // until they confirm, so a wrong number never learns that this person donated.
  if (state.step === 'intro') {
    const identity = handleIdentityReply(customerReply, state, name);
    if (!identity.confirmed) return identity.instruction;
    state.step = 'experience';
    const line = joinSpoken(
      buildConfirmedPreamble(name),
      `Aapne ${describeVisit(state.lastVisitDate)} blood donate kiya tha, uske liye dhanyavaad. Aapka experience kaisa raha?`
    );
    return `Identity confirmed. Say exactly: "${line}"`;
  }

  if (state.step === 'experience') {
    // Checked before the busy branch. A complaint is an answer to the question
    // that was asked; a busy signal is a refusal to answer it. When a reply
    // reads as both -- "donate karne ke baad mein bahut dikkat hui" -- the
    // answer is what the donor came to say.
    if (isNegativeExperienceReply(customerReply)) {
      state.step = 'issue_detail';
      return 'The donor reported a negative experience. Say exactly: "Maaf kijiye. Kripya batayein aapko kya pareshani hui thi?"';
    }

    if (isNegativeOrBusyReply(customerReply)) {
      markCompletedAfterReply();
      return `Donor wants to stop or is busy. Say exactly: "Koi baat nahi. ${closing}" Then end the call.`;
    }

    if (isPositiveExperienceReply(customerReply)) {
      state.step = 'rating';
      return `Say exactly: "Bahut achhi baat hai, sunkar khushi hui. ${RATING_QUESTION}"`;
    }

    // Asked once. The clarification had no counter, so a donor whose answer
    // matched nothing was asked the same question on every turn -- one call
    // asked three times, the last after the donor had said "Ok, bye".
    if (isGoodbyeReply(customerReply) || state.experienceClarified) {
      markCompletedAfterReply();
      return `The donor is not giving a clear answer or is ending the call. Say exactly: "Koi baat nahi. ${invitation} ${closing}" Then end the call.`;
    }
    state.experienceClarified = true;
    return `The experience answer was unclear. Say exactly: "${address}blood donate karne ka aapka experience achha tha ya koi pareshani hui thi?"`;
  }

  if (state.step === 'issue_detail') {
    state.step = 'rating';
    state.issueNote = String(customerReply || '').trim().slice(0, 300);
    return `Capture the issue. Then say exactly: "Main aapki baat sambandhit adhikari tak pahucha dungi. Agli baar hum aur dhyan rakhenge. ${RATING_QUESTION}"`;
  }

  // The number the donor puts on the experience. Asked once and never pressed:
  // a donor who will not give one is closed out unrated rather than nudged,
  // because an invented rating cannot be told from a real one downstream.
  if (state.step === 'rating') {
    markCompletedAfterReply();
    const score = extractSpokenRating(customerReply);
    if (score === null) {
      return `The donor did not give a number. Do not ask again. Say exactly: "Koi baat nahi. ${invitation} ${closing}" Then end the call.`;
    }
    state.ratingGiven = score;
    return `The donor rated the experience ${score} out of 5. Repeat the number back once. `
      + `Say exactly: "Aapke feedback ke liye dhanyavaad. ${invitation} ${closing}" Then end the call.`;
  }

  markCompletedAfterReply();
  return `Say exactly: "${FINAL_CLOSING_LINE}" Then end the call.`;
}

// ── Three Month Follow-up turn instruction builder ─────────────────────────────

function buildThreeMonthFollowupTurnInstruction(customerReply, state, clientName, customerName) {
  const name = spokenName(customerName);
  const closing = buildClosingLine(name);
  const centre = CLIENT_WITH_CITY;
  const slotQuestion = 'Kya aap agli baar aane ka samay abhi bata sakte hain?';
  const markCompletedAfterReply = () => markCallCompleted(state);

  if (state.step === 'intro') {
    const identity = handleIdentityReply(customerReply, state, name);
    if (!identity.confirmed) return identity.instruction;
    state.step = 'donated_again';
    const line = joinSpoken(
      buildConfirmedPreamble(name),
      `Aapne ${describeVisit(state.lastVisitDate)} blood donate kiya tha, uske liye dhanyavaad. Blood donation ke 3 mahine poore ho gaye hain. Kya aapne uske baad dobara blood donate kiya hai?`
    );
    return `Donor confirmed identity. Say exactly: "${line}"`;
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

    if (isAffirmativeReply(customerReply)) {
      state.donatedAgain = true;
      state.step = 'donation_date';
      return 'Donor donated again. Say exactly: "Bahut achha. Kab donate kiya tha?"';
    }

    // Answer what they asked, then put the question back. Repeating the
    // question at someone who asked who you are is how a call becomes a loop.
    if (isQuestionReply(customerReply)) {
      state.followupClarified = (state.followupClarified || 0) + 1;
      if (state.followupClarified <= 2) {
        return `Answer their question in one short sentence -- you are an AI assistant from ${centre} -- then ask again, exactly: "Kya aapne 3 mahine ke baad dobara blood donate kiya hai?"`;
      }
    }

    state.followupClarified = (state.followupClarified || 0) + 1;
    if (state.followupClarified > 2) {
      markCompletedAfterReply();
      return `The donor is not answering the question. Say exactly: "Koi baat nahi. ${closing}" Then end the call.`;
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
    if (isAffirmativeReply(customerReply) && !isUncertainReply(customerReply)) {
      state.redonationInterest = 'yes';
      state.step = 'visit_time';
      return `The donor wants to come in. Say exactly: "Bahut achha. ${VISIT_TIME_QUESTION}"`;
    }
    markCompletedAfterReply();
    if (isUncertainReply(customerReply)) {
      state.redonationInterest = 'unclear';
      return `The donor is undecided. Say exactly: "Koi baat nahi, aap jab chahein hamse sampark kar sakte hain. ${closing}" Then end the call.`;
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

  if (state.step === 'visit_time') {
    markCompletedAfterReply();
    return captureIntendedVisit(customerReply, state, closing);
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

  // Counted for the call record: a patient who confirmed who they were and
  // then answered nothing gave no feedback, however long the call ran.
  if (state.step !== 'intro' && state.step !== 'completed' && customerReply
      && !isGreetingOnly(customerReply) && !isFillerOnly(customerReply)) {
    state.answersGiven = (state.answersGiven || 0) + 1;
  }

  const repeat = repeatLineForGreeting(customerReply, state);
  if (repeat) {
    return `${prefix.join('\n')}\n${repeat}`;
  }

  const instruction = normalizeOutboundCallType(callType) === CALL_TYPES.THREE_MONTH_FOLLOWUP
    ? buildThreeMonthFollowupTurnInstruction(customerReply, state, clientName, customerName)
    : buildReviewCallTurnInstruction(customerReply, state, clientName, customerName);

  const spoken = [...instruction.matchAll(/Say exactly: "([^"]+)"/g)].pop();
  if (spoken) state.lastSpokenLine = spoken[1];
  state.lastAgentTurnInterrupted = false;

  return `${prefix.join('\n')}\n${instruction}`;
}

// Consecutive hellos met with the last line again before they are treated as
// a reply like any other -- by then the line is bad, and each step already
// knows how to give up.
const GREETING_MAX_REPEATS = 2;

/** The question at the end of a line, or the whole line when it asks none. */
function questionOf(line) {
  const sentences = String(line || '').split(/(?<=[.!?।])\s+/).filter(Boolean);
  const last = sentences[sentences.length - 1] || '';
  return /\?\s*$/.test(last) ? last : String(line || '').trim();
}

/**
 * A caller who says only "hello" mid-call has not answered anything: they have
 * lost the line, or did not hear the question. Taking it as the answer moved
 * the call on to a question they had not heard the start of -- or, at the
 * free-text steps, stored "hello" as the donation date.
 *
 * The identity step is left to its own handling, which already re-asks.
 */
function repeatLineForGreeting(customerReply, state) {
  const greeting = isGreetingOnly(customerReply) || isFillerOnly(customerReply);
  if (!greeting) {
    state.greetingRepeats = 0;
    return null;
  }
  if (!state.lastSpokenLine || state.step === 'intro' || state.step === 'completed') return null;
  if ((state.greetingRepeats || 0) >= GREETING_MAX_REPEATS) return null;

  state.greetingRepeats = (state.greetingRepeats || 0) + 1;
  // If the line was cut off they missed more than the question, so it is said
  // again in full.
  const line = state.lastAgentTurnInterrupted ? state.lastSpokenLine : questionOf(state.lastSpokenLine);
  state.lastAgentTurnInterrupted = false;
  return `The caller only said hello; they may not have heard you. Do not move on and do not treat this as an answer. Say exactly: "Ji, main sun rahi hoon. ${line}"`;
}

module.exports = {
  RATING_QUESTION,
  foldNuqta,
  evaluateLiveSentimentLabel,
  shouldAutoHangupAfterAgentTurn,
  shouldIgnoreBargeIn,
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
  isIdentityConfirmation,
  isGoodbyeReply,
  isQuestionReply,
  buildReviewCallTurnInstruction,
  buildThreeMonthFollowupTurnInstruction,
  buildOutboundDemoTurnInstruction
};
