// The auto-hangup detector keys on "Aapka din shubh ho" alone
// (src/conversation-state.js), so the thank-you half is free to be personalised.
const FINAL_CLOSING_LINE = 'Dhanyavaad. Aapka din shubh ho.';

/**
 * The closing line addressed to the patient by name.
 *
 * "ji" is gender-neutral; the line used to say "sir" to everyone, which was
 * spoken to female patients on live calls.
 */
function buildClosingLine(patientName) {
  const name = String(patientName || '').trim();
  return name ? `Dhanyavaad ${name} ji. Aapka din shubh ho.` : FINAL_CLOSING_LINE;
}

module.exports = {
  FINAL_CLOSING_LINE,
  buildClosingLine
};
