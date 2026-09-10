/**
 * src/rating-question.js
 * The one question the review call asks for a number, kept in one place.
 *
 * Three things have to agree on this wording and none of them can own it:
 * prompts/review-calling.ts puts it in the system prompt,
 * src/conversation-state.js decides the turn it is asked on, and
 * services/call-feedback.js finds the answer afterwards by matching "1 se 5"
 * against the agent's line. conversation-state already imports review-calling
 * for the date helpers, so the string cannot live in either of them without a
 * require cycle.
 *
 * If the wording changes, RATING_PROMPT_PATTERN has to change with it, or the
 * number the donor says stops reaching the record.
 */

'use strict';

const RATING_QUESTION = '1 se 5 ke beech mein aap apne experience ko kitne number denge?';

/** How the transcript reader recognises the agent asking for a rating. */
const RATING_PROMPT_PATTERN = /(1 se 5|scale|rating|excellent|star|stars)/;

module.exports = { RATING_QUESTION, RATING_PROMPT_PATTERN };
