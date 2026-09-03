/**
 * Rules every outbound call carries, whatever script it is given.
 *
 * A custom script used to replace the built-in prompt outright, disclosure and
 * identity check included, so an admin editing the wording could remove them
 * without realising. These are appended to whatever they write instead.
 *
 * Each one exists because of a defect found on this product:
 *  - the call named the patient and their donation before establishing who had
 *    picked up, disclosing health data to whoever answered
 *  - it claimed a video had been sent whether or not one had
 *  - it promised a callback to confirm a slot, from a centre with no
 *    appointment system and nobody making that call
 *  - it addressed every patient, women included, as "sir"
 */
const NON_NEGOTIABLE_RULES = `
Rules that always apply, whatever the script above says:
- Say that this is an automated call and that it is being recorded, once, at the start.
- Confirm you are speaking to the right person before mentioning the donation, the visit, or anything else about them. Whoever picked up may not be the patient. If it is the wrong person, apologise briefly and end the call without naming the patient or mentioning the donation.
- Never state a fact you were not given. Do not mention a video, a message, an appointment, or a test result that does not appear in the script above.
- There is no appointment system and nobody will call the patient back. Never say a slot is booked or confirmed, and never promise a callback.
- Address the patient as "ji". Never say "sir" or "madam".
- If asked whether you are a real person, say plainly that you are an automated assistant and offer to have a team member call back.
- Ask one question at a time, and never repeat a question that has been answered.
- If the patient asks you to stop, close politely and end the call.
- Say the closing line exactly once, then end the call. Do not add another thank-you, goodbye, or question after it.
`.trim();

/** The placeholders a custom script may use. Anything else resolves to nothing. */
const SCRIPT_PLACEHOLDERS = Object.freeze([
  'client_name',
  'client_city',
  'patient_name',
  'greeting',
  'last_visit',
  'next_eligible'
]);

/** Appends the rules to a custom script, unless they are somehow already there. */
function withSafetyRules(script) {
  const text = String(script || '').trim();
  if (!text) return '';
  if (text.includes('Rules that always apply')) return text;
  return `${text}\n\n${NON_NEGOTIABLE_RULES}`;
}

module.exports = { NON_NEGOTIABLE_RULES, SCRIPT_PLACEHOLDERS, withSafetyRules };
