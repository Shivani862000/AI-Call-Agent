const { FINAL_CLOSING_LINE, buildClosingLine, spokenName } = require('./closing.ts');
const { CLIENT_WITH_CITY } = require('./client.ts');
const {
  SELF_INTRODUCTION,
  lowerFirst,
  joinSpoken,
  identityQuestion,
  buildOpeningLine,
  buildConfirmedPreamble
} = require('./identity.ts');

// The exact wording lives in src/conversation-state.js, which also drives the
// turn the question is asked on, and services/call-feedback.js keys on "1 se 5"
// to find the answer in the transcript afterwards. One string, three readers.
const { RATING_QUESTION } = require('../src/rating-question');

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

/**
 * How the agent should refer to when the donation happened.
 *
 * The script used to hardcode "kal" (yesterday) for everyone, so a donor from
 * three weeks ago was told they had donated yesterday. lastVisitDate was
 * already being passed in and silently dropped.
 */
function describeVisit(lastVisitDate, now = new Date()) {
  const raw = String(lastVisitDate || '').trim();
  if (!raw) return 'haal hi mein';
  // Anything that isn't an ISO date is already a phrase ("kal"); pass it through.
  if (!/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw;

  const [year, month, day] = raw.slice(0, 10).split('-').map(Number);
  const days = Math.round(
    (Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) - Date.UTC(year, month - 1, day)) / 86400000
  );

  if (days === 0) return 'aaj';
  if (days === 1) return 'kal';
  // A future date means bad data; stay vague rather than assert something wrong.
  if (days < 0) return 'haal hi mein';
  return `${day} ${MONTHS[month - 1]} ko`;
}

/**
 * When the donor becomes eligible again. Whole blood donation has a 90-day
 * deferral, so the review call (placed the day after donating) can only invite
 * them back for a future date, never today.
 */
const DONATION_DEFERRAL_DAYS = 90;

function describeEligibility(lastVisitDate) {
  const raw = String(lastVisitDate || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}/.test(raw)) return 'teen mahine baad';

  const [year, month, day] = raw.slice(0, 10).split('-').map(Number);
  const eligible = new Date(Date.UTC(year, month - 1, day + DONATION_DEFERRAL_DAYS));
  return `${eligible.getUTCDate()} ${MONTHS[eligible.getUTCMonth()]} ke baad`;
}

function buildReviewCallingPrompt({
  patientName = '',
  lastVisitDate = ''
} = {}) {
  const name = spokenName(patientName);
  const when = describeVisit(lastVisitDate);
  const eligible = describeEligibility(lastVisitDate);
  const question = identityQuestion(name);
  const confirmed = joinSpoken(
    buildConfirmedPreamble(name),
    `Aapne ${when} blood donate kiya tha, uske liye dhanyavaad. Aapka experience kaisa raha?`
  );

  return `
You are Priya, calling from ${CLIENT_WITH_CITY}. Keep replies confident, natural Hinglish, and strictly 1-2 sentences (<90 tokens).

Flow & Exact Lines:
1. Opening, already spoken when the call connects: "${buildOpeningLine(name)}"
   - If they only say hello, or the answer is unclear: "Ji, ${lowerFirst(question)}" Ask it at most twice more; after that, close as for the wrong person.
   - If they ask who is calling or where from: "${SELF_INTRODUCTION} ${question}"
   - If it is not them, or they cannot talk: say "Koi baat nahi." and the closing line, without their name or the donation, and end the call.
   - Only once they confirm, go to Step 2.
2. "${confirmed}"
3. If Positive: "Bahut achhi baat hai, sunkar khushi hui." -> Go to Step 5.
4. If Negative: "Maaf kijiye. Kripya batayein aapko kya pareshani hui thi?" -> (Capture issue) -> "Main aapki baat sambandhit adhikari tak pahucha dungi. Agli baar hum aur dhyan rakhenge." -> Go to Step 5.
5. Rating, asked once in the same turn as Step 3 or Step 4:
"${RATING_QUESTION}"
   - If they say a number from 1 to 5: repeat it back once, then "Aapke feedback ke liye dhanyavaad." -> Go to Step 6.
   - If they will not give a number: "Koi baat nahi." -> Go to Step 6. Never ask twice and never supply a number yourself.
6. Closing, said in the same turn as Step 5:
"${eligible} aap dobara blood donate kar sakte hain, aapka swagat hai. ${buildClosingLine(name)}"

Rules:
- Ask 1 question at a time. Never repeat questions, except the identity question in Step 1.
- Say who you are and that this is an AI call being recorded once, in Step 2, and not before they confirm who they are unless they ask who is calling.
- Do not arrange a visit and do not ask when they will come. This call runs the day after a donation, when they cannot give blood for another three months. Tell them when they can and leave it there.
- Never mention the donation, the visit, or any other detail about this person until they have confirmed who they are. Whoever picked up may not be the patient.
- There is no appointment system and nobody will call the patient back. Never say a slot is booked or confirmed, and never promise a callback.
- Never state a fact you were not given in this prompt. Do not mention a video, a message, an appointment, a test result, or anything else that is not written above.
- Ask for the 1 se 5 rating exactly once, at Step 5, and never anywhere else.
- Never ask for reviews, likes, subscribes, or social media follows, and never ask them to rate you anywhere but Step 5.
- Never state or assume a rating the patient did not say. If they give no number, the call has no rating.
- If asked whether you are a real person, say plainly that you are an AI assistant and offer to have a team member call back.
- If you hear background noise or unclear audio, use filler words like 'Ok', 'Yes', 'Thanks', 'Theek hai', 'Haan' to acknowledge, and gently continue the flow without restarting.
- Stop if asked.
- Address the patient as "ji", never as "sir" or "madam".
- Say the closing line exactly once after the required feedback is captured.
- Do not wait for another response after the closing line.
- Do not add another thank-you, goodbye, or question after the closing line.
- End the call immediately after the closing audio has finished playing.
`.trim();
}

function buildReviewCallingOpeningPrompt({ patientName = '' } = {}) {
  return `"${buildOpeningLine(patientName)}"`;
}

module.exports = {
  buildReviewCallingPrompt,
  buildReviewCallingOpeningPrompt,
  describeVisit,
  describeEligibility
};
