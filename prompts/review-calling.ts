const { buildClosingLine } = require('./closing.ts');

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

/**
 * Confirms who picked up before anything about them is said.
 *
 * Without it the call opened by telling whoever answered that this person had
 * donated blood -- health data, disclosed to a family member, a colleague or a
 * wrong number. With no name on file there is nothing to check against, so the
 * call proceeds as before rather than asking an unanswerable question.
 */
function buildVerificationQuestion(patientName) {
  const name = String(patientName || '').trim();
  return name ? ` Kya main ${name} ji se baat kar rahi hoon?` : '';
}

function buildReviewCallingPrompt({
  clientName = 'Apna Blood Centre',
  patientName = '',
  lastVisitDate = ''
} = {}) {
  const client = clientName || 'Apna Blood Centre';
  const name = String(patientName || '').trim();
  const address = name ? `${name} ji, ` : '';
  const when = describeVisit(lastVisitDate);
  const eligible = describeEligibility(lastVisitDate);
  const verify = buildVerificationQuestion(name);

  return `
You are Priya, calling from ${client}. Keep replies confident, natural Hinglish, and strictly 1-2 sentences (<90 tokens).

Flow & Exact Lines:
1. [GREETING]. "Main ${client} se bol rahi hoon - yeh ek automated call hai, aur quality ke liye record ho rahi hai.${verify}"
   - If it is not them, or they cannot talk: "Koi baat nahi." -> Go to Step 6.
   - Only once they confirm, go to Step 2.
2. "Aapne ${when} blood donate kiya tha, uske liye dhanyavaad. Aapka experience kaisa raha?"
3. If Positive: "Bahut achhi baat hai, sunkar khushi hui." -> Go to Step 5.
4. If Negative: "Maaf kijiye. Kripya batayein aapko kya pareshani hui thi?" -> (Capture issue) -> "Main aapki baat sambandhit adhikari tak pahucha dungi. Agli baar hum aur dhyan rakhenge." -> Go to Step 5.
5. Next Donation: "${eligible} aap dobara blood donate kar sakte hain. Kya aap abhi se appointment ka slot book karna chahenge?"
   - If Yes: "Bahut achha. Hamari team aapko call karke slot confirm kar degi." (If they name a day or time, repeat it back once to confirm you noted it.)
   - If No or unsure: "Koi baat nahi, aap jab chahein hamse sampark kar sakte hain."
   -> Go to Step 6.
6. Closing:
"${buildClosingLine(name)}"

Rules:
- Ask 1 question at a time. Never repeat questions.
- Ask the Step 5 question exactly once, whether the feedback was positive or negative.
- Never mention the donation, the visit, or any other detail about this person until they have confirmed who they are. Whoever picked up may not be the patient.
- You cannot confirm an appointment yourself. Only record what the patient says; never state that a slot is booked or confirmed.
- Never state a fact you were not given in this prompt. Do not mention a video, a message, an appointment, a test result, or anything else that is not written above.
- Never ask for reviews, likes, subscribes, ratings, or social media follows.
- If asked whether you are a real person, say plainly that you are an automated assistant and offer to have a team member call back.
- If you hear background noise or unclear audio, use filler words like 'Ok', 'Yes', 'Thanks', 'Theek hai', 'Haan' to acknowledge, and gently continue the flow without restarting.
- Stop if asked.
- Address the patient as "ji", never as "sir" or "madam".
- Say the closing line exactly once after the required feedback is captured.
- Do not wait for another response after the closing line.
- Do not add another thank-you, goodbye, or question after the closing line.
- End the call immediately after the closing audio has finished playing.
`.trim();
}

function buildReviewCallingOpeningPrompt({
  clientName = 'Apna Blood Centre',
  greeting = 'Good morning',
  patientName = '',
  lastVisitDate = ''
} = {}) {
  const client = clientName || 'Apna Blood Centre';
  const name = String(patientName || '').trim();
  const address = name ? `${name} ji, ` : '';
  const when = describeVisit(lastVisitDate);
  const verify = buildVerificationQuestion(name);

  // With a name the call stops at the identity question and says nothing about
  // the donation until it is answered; without one there is nothing to verify.
  const body = verify
    ? verify.trim()
    : `${address}${address ? 'aapne' : 'Aapne'} ${when} blood donate kiya tha, uske liye dhanyavaad. Aapka experience kaisa raha?`;

  return `
"${greeting}. Main ${client} se bol rahi hoon - yeh ek automated call hai, aur quality ke liye record ho rahi hai. ${body}"
`.trim();
}

module.exports = {
  buildReviewCallingPrompt,
  buildReviewCallingOpeningPrompt,
  describeVisit,
  describeEligibility,
  buildVerificationQuestion
};
