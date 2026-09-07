// The auto-hangup detector keys on "Aapka din shubh ho" alone
// (src/conversation-state.js), so the thank-you half is free to be personalised.
const FINAL_CLOSING_LINE = 'Dhanyavaad. Aapka din shubh ho.';

/**
 * The name to say out loud: the first name only.
 *
 * Full names made the fixed lines longer and the model started corrupting
 * them -- one call said "aap dobara blood donate Verma kar sakte hain", with
 * the surname dropped into the middle of a different sentence, and then cut
 * the closing off at "Dhanyavaad Shivani". A first name is also how anyone
 * would actually address someone on the phone.
 */
function spokenName(fullName) {
  return String(fullName || '').trim().split(/\s+/)[0] || '';
}

/**
 * The closing line addressed to the patient by name.
 *
 * "ji" is gender-neutral; the line used to say "sir" to everyone, which was
 * spoken to female patients on live calls.
 */
function buildClosingLine(patientName) {
  const name = spokenName(patientName);
  return name ? `Dhanyavaad ${name} ji. Aapka din shubh ho.` : FINAL_CLOSING_LINE;
}

module.exports = {
  FINAL_CLOSING_LINE,
  buildClosingLine,
  spokenName
};
