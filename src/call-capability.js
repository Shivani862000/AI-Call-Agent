'use strict';

/**
 * Refuses to dial when the system cannot actually hold a conversation.
 *
 * validateConfig() checks these credentials are *present*, which a placeholder
 * satisfies. A production deployment carrying `local-dev-placeholder` therefore
 * booted, accepted a scheduled call, connected the media, and delivered sixteen
 * seconds of silence to a real patient — costing a telephony charge and the
 * patient's goodwill, with nothing in the app to stop it.
 *
 * Pure and free of I/O so the rules can be tested directly.
 */

/** Values that are present but obviously not a real credential. */
const PLACEHOLDER_PATTERNS = [
  /placeholder/i,
  /^your[_-]/i,
  /^replace[_-]?with/i,
  /^change[_-]?me$/i,
  /^todo$/i,
  /^<.*>$/,
  /^x{4,}$/i,
  /^(test|dummy|sample|example)[_-]/i
];

function looksUnusable(value) {
  const text = String(value == null ? '' : value).trim();
  if (!text) return true;
  return PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Returns the names of credentials needed to speak on a call that are missing
 * or obviously placeholders. Empty means the system can hold a conversation.
 */
function unusableCredentials(env = process.env) {
  const unusable = [];
  const provider = String(env.AI_PROVIDER || 'gemini-live').toLowerCase();

  if (provider.startsWith('gemini')) {
    // Either key satisfies the requirement; the app accepts both.
    const gemini = env.GEMINI_API_KEY;
    const google = env.GOOGLE_API_KEY;
    if (looksUnusable(gemini) && looksUnusable(google)) unusable.push('GEMINI_API_KEY');
  }

  // Deepgram carries transcription and the speech fallback. Without it the
  // caller is heard by nobody and hears nothing when Gemini is slow.
  if (looksUnusable(env.DEEPGRAM_API_KEY)) unusable.push('DEEPGRAM_API_KEY');

  return unusable;
}

/** The message shown to whoever tried to place the call. */
function describeCallBlock(names) {
  return `Cannot place a call: ${names.join(' and ')} ${names.length > 1 ? 'are' : 'is'} `
    + 'not configured (still a placeholder). The call would connect and the patient '
    + 'would hear silence, so it has not been placed.';
}

module.exports = { unusableCredentials, describeCallBlock, looksUnusable, PLACEHOLDER_PATTERNS };
