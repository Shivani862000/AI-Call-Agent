'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  istDate,
  istMidnight,
  countWorkingDays,
  resolveRange,
  expectedCount,
  workingDaysInRange,
  compareLabel,
  isAttentionKey
} = require('../services/overview');

// 2026-09-14 is a Monday; 2026-09-13 a Sunday.
const MONDAY_10AM_IST = new Date('2026-09-14T04:30:00Z');

test('the day is the Indian day, not the server day', () => {
  // 20:00 UTC on the 13th is 01:30 IST on the 14th.
  assert.equal(istDate(new Date('2026-09-13T20:00:00Z')), '2026-09-14');
  assert.equal(istMidnight('2026-09-14').toISOString(), '2026-09-13T18:30:00.000Z');
});

test('working days are Monday to Saturday', () => {
  assert.equal(countWorkingDays('2026-09-08', '2026-09-14'), 6, 'Tue..Mon spans one Sunday');
  assert.equal(countWorkingDays('2026-09-13', '2026-09-13'), 0, 'a Sunday alone');
  assert.equal(countWorkingDays('2026-09-12', '2026-09-12'), 1, 'a Saturday alone');
  assert.equal(countWorkingDays('2026-09-14', '2026-09-13'), 0, 'an empty span');
});

test('ranges start at Indian midnight', () => {
  assert.equal(resolveRange('today', MONDAY_10AM_IST).start.toISOString(), '2026-09-13T18:30:00.000Z');
  const yesterday = resolveRange('yesterday', MONDAY_10AM_IST);
  assert.equal(yesterday.start.toISOString(), '2026-09-12T18:30:00.000Z');
  assert.equal(yesterday.end.toISOString(), '2026-09-13T18:30:00.000Z');
  assert.equal(resolveRange('month', MONDAY_10AM_IST).start.toISOString(), '2026-08-31T18:30:00.000Z');
  assert.equal(resolveRange('7d', MONDAY_10AM_IST).start.toISOString(), '2026-09-07T18:30:00.000Z');
});

test('an unknown range falls back to the last 24 hours', () => {
  assert.equal(resolveRange('forever', MONDAY_10AM_IST).key, '24h');
});

const rates = { perDay: 20, byTimeOfDay: 5 };

// A Sunday is not a working day, so an average Sunday produced nothing.
test('yesterday being Sunday expects nothing', () => {
  assert.equal(expectedCount(resolveRange('yesterday', MONDAY_10AM_IST), rates, MONDAY_10AM_IST), 0);
  assert.equal(compareLabel(resolveRange('yesterday', MONDAY_10AM_IST), MONDAY_10AM_IST), 'not a working day');
});

test('today compares with what normally happens by this time', () => {
  assert.equal(expectedCount(resolveRange('today', MONDAY_10AM_IST), rates, MONDAY_10AM_IST), 5);
});

// Monday 10 AM: the last 24 hours are Sunday's tail (no calls) plus Monday so far.
test('the rolling 24 hours count only the working part of the window', () => {
  assert.equal(expectedCount(resolveRange('24h', MONDAY_10AM_IST), rates, MONDAY_10AM_IST), 5);

  const tuesday10am = new Date('2026-09-15T04:30:00Z');
  assert.equal(expectedCount(resolveRange('24h', tuesday10am), rates, tuesday10am), 20,
    "Monday's remaining 15 plus Tuesday's first 5");
});

test('longer ranges scale by working days, with today as a part-day', () => {
  // 7d on Monday: Tue 8 .. Sun 13 is five working days, plus Monday so far.
  const week = resolveRange('7d', MONDAY_10AM_IST);
  assert.equal(expectedCount(week, rates, MONDAY_10AM_IST), 5 * 20 + 5);
  assert.equal(workingDaysInRange(week, MONDAY_10AM_IST), 6);

  // 1–13 Sep has two Sundays (6th, 13th): eleven working days.
  assert.equal(expectedCount(resolveRange('month', MONDAY_10AM_IST), rates, MONDAY_10AM_IST), 11 * 20 + 5);
});

test('on the first of the month only today counts', () => {
  const firstOfOctober = new Date('2026-10-01T04:30:00Z');
  assert.equal(expectedCount(resolveRange('month', firstOfOctober), rates, firstOfOctober), 5);
});

test('a Sunday contributes nothing even as today', () => {
  const sunday = new Date('2026-09-13T04:30:00Z');
  assert.equal(expectedCount(resolveRange('today', sunday), rates, sunday), 0);
});

test('only well-formed attention keys are accepted', () => {
  assert.equal(isAttentionKey('call:12:complaint'), true);
  assert.equal(isAttentionKey('queue:7:wrong_number'), true);
  assert.equal(isAttentionKey('call:12:anything'), false);
  assert.equal(isAttentionKey("call:1:complaint' OR 1=1"), false);
  assert.equal(isAttentionKey(''), false);
});
