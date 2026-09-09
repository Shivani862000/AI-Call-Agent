'use strict';

const SCHEDULE_TIME_ZONE = 'Asia/Kolkata';
const ISO_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})?$/;

function realCalendarComponents(year, month, day, hour, minute, second) {
  const numbers = [year, month, day, hour, minute, second].map(Number);
  const [y, m, d, h, min, sec] = numbers;
  if (m < 1 || m > 12 || d < 1 || h > 23 || min > 59 || sec > 59) return false;
  const calendar = new Date(Date.UTC(y, m - 1, d));
  return calendar.getUTCFullYear() === y && calendar.getUTCMonth() === m - 1
    && calendar.getUTCDate() === d;
}

function parseScheduleInstant(value) {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : new Date(value.getTime());
  }
  const text = String(value == null ? '' : value).trim();
  if (!text) return null;
  const components = ISO_TIMESTAMP.exec(text);
  if (!components || !realCalendarComponents(...components.slice(1, 7).map((part) => part || '0'))) {
    return null;
  }
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function scheduleInstantParts(value) {
  const instant = parseScheduleInstant(value);
  if (!instant) return null;
  const values = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: SCHEDULE_TIME_ZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(instant).filter((part) => part.type !== 'literal')
    .map((part) => [part.type, part.value]));
  return {
    date: `${values.year}-${values.month}-${values.day}`,
    time: `${values.hour}:${values.minute}`,
    hour: Number(values.hour)
  };
}

function sameScheduleInstant(left, right) {
  const a = parseScheduleInstant(left);
  const b = parseScheduleInstant(right);
  return Boolean(a && b && a.getTime() === b.getTime());
}

module.exports = { SCHEDULE_TIME_ZONE, parseScheduleInstant, scheduleInstantParts, sameScheduleInstant };
