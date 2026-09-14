const { CLIENT_WITH_CITY } = require('./client.ts');
const { spokenName } = require('./closing.ts');

/**
 * How every call opens: who picked up is asked first, and nothing else.
 *
 * The opening used to be "Good Morning. Main Apna Blood Centre se bol rahi
 * hoon - yeh ek automated call hai, aur quality ke liye record ho rahi hai.
 * Kya main Ankita ji se baat kar rahi hoon?" -- eight seconds of what every
 * robocall sounds like before the patient's own name, and patients hung up
 * before reaching it. Their name now comes first; who is calling and the
 * disclosure follow as soon as they confirm.
 */
const SELF_INTRODUCTION = `Main ${CLIENT_WITH_CITY} se Priya bol rahi hoon.`;
const DISCLOSURE = 'Yeh AI call hai aur quality ke liye record ho rahi hai.';

function lowerFirst(text) {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

function joinSpoken(...parts) {
  return parts.filter(Boolean).join(' ');
}

/**
 * With no name on file there is nobody to ask for, so the call asks for a
 * moment of their time instead.
 */
function identityQuestion(patientName) {
  const name = spokenName(patientName);
  return name ? `Kya meri baat ${name} ji se ho rahi hai?` : 'Kya main aapse do minute baat kar sakti hoon?';
}

/**
 * The first line of the call. Without a name the introduction and disclosure
 * cannot wait for a confirmation that names nobody, so they are said up front.
 */
function buildOpeningLine(patientName) {
  const name = spokenName(patientName);
  return name
    ? `Namaste, ${lowerFirst(identityQuestion(name))}`
    : `Namaste, ${lowerFirst(SELF_INTRODUCTION)} ${DISCLOSURE} ${identityQuestion('')}`;
}

/** Said once, right after the patient confirms who they are. Empty when the opening already said it. */
function buildConfirmedPreamble(patientName) {
  const name = spokenName(patientName);
  return name ? `${name} ji, ${lowerFirst(SELF_INTRODUCTION)} ${DISCLOSURE}` : '';
}

module.exports = {
  SELF_INTRODUCTION,
  DISCLOSURE,
  lowerFirst,
  joinSpoken,
  identityQuestion,
  buildOpeningLine,
  buildConfirmedPreamble
};
