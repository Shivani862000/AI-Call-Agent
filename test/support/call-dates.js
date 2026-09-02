'use strict';

/**
 * Dates for prompt tests, relative to the day the test runs.
 *
 * The prompts describe a donation as "kal" or "8 August ko" by comparing the
 * stored date to today, so a hardcoded date passes on the day it is written and
 * fails every day after. These tests were committed with '2026-08-30' expecting
 * "kal" and broke three days later.
 */
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

const toIso = (date) => date.toISOString().slice(0, 10);

/** Local midnight today, as UTC, so day arithmetic cannot cross a timezone. */
function todayUtc(now = new Date()) {
  return new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
}

function daysAgo(count, now = new Date()) {
  const date = todayUtc(now);
  date.setUTCDate(date.getUTCDate() - count);
  return toIso(date);
}

/**
 * How the prompt should name the day the donor becomes eligible again: 90 days
 * after the donation. Worked out here independently of the prompt code, so a
 * regression in describeEligibility still fails the test.
 */
function eligibilityLabel(visitIso, deferralDays = 90) {
  const [year, month, day] = String(visitIso).slice(0, 10).split('-').map(Number);
  const eligible = new Date(Date.UTC(year, month - 1, day + deferralDays));
  return `${eligible.getUTCDate()} ${MONTHS[eligible.getUTCMonth()]} ke baad`;
}

module.exports = { daysAgo, eligibilityLabel, YESTERDAY: daysAgo(1) };
