'use strict';

function parseScheduleInstant(value) {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : new Date(value.getTime());
  }
  const text = String(value == null ? '' : value).trim();
  if (!text) return null;
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function sameScheduleInstant(left, right) {
  const a = parseScheduleInstant(left);
  const b = parseScheduleInstant(right);
  return Boolean(a && b && a.getTime() === b.getTime());
}

module.exports = { parseScheduleInstant, sameScheduleInstant };
