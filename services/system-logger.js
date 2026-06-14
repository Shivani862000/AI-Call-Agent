const fs = require('fs');
const path = require('path');

const LOG_DIR = path.join(process.cwd(), 'logs');
const LOG_FILE = path.join(LOG_DIR, 'system.log');
const DEBUG_ENABLED = /^(1|true|yes|on)$/i.test(String(process.env.DEBUG_LOGS || process.env.LOG_DEBUG || ''));
const LEVELS = new Set(['INFO', 'WARN', 'ERROR', 'DEBUG']);

function pad(value) {
  return String(value).padStart(2, '0');
}

function formatTimestamp(date = new Date()) {
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate())
  ].join('-') + ' ' + [
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds())
  ].join(':');
}

function normalizeLevel(level) {
  const normalized = String(level || 'INFO').trim().toUpperCase();
  return LEVELS.has(normalized) ? normalized : 'INFO';
}

function normalizeEvent(event) {
  return String(event || 'SYSTEM_EVENT').trim().toUpperCase().replace(/[^A-Z0-9_]/g, '_');
}

function quoteValue(value) {
  if (value === null || value === undefined || value === '') return null;
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function formatDetails(details = {}) {
  return Object.entries(details)
    .map(([key, value]) => {
      const quoted = quoteValue(value);
      return quoted === null ? null : `${key}="${quoted}"`;
    })
    .filter(Boolean)
    .join(' ');
}

function writeLine(line) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, `${line}\n`);
  } catch (error) {
    console.error('[LOGGER_ERROR]', error.message);
  }
}

function log(level, event, details = {}) {
  const normalizedLevel = normalizeLevel(level);
  if (normalizedLevel === 'DEBUG' && !DEBUG_ENABLED) return;

  const line = [
    `[${formatTimestamp()}]`,
    `[${normalizedLevel}]`,
    `[${normalizeEvent(event)}]`,
    formatDetails(details)
  ].filter(Boolean).join(' ');

  if (normalizedLevel === 'ERROR') {
    console.error(line);
  } else if (normalizedLevel === 'WARN') {
    console.warn(line);
  } else {
    console.log(line);
  }
  writeLine(line);
}

function info(event, details) {
  log('INFO', event, details);
}

function warn(event, details) {
  log('WARN', event, details);
}

function error(event, details) {
  log('ERROR', event, details);
}

function debug(event, details) {
  log('DEBUG', event, details);
}

function isDebugEnabled() {
  return DEBUG_ENABLED;
}

function formatCallType(value) {
  const normalized = String(value || '').toUpperCase();
  return normalized === 'THREE_MONTH_FOLLOWUP' ? '3 Month Follow-up' : 'Review Calling';
}

function formatHumanDateTime(value) {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  const dateText = date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  const timeText = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return `${dateText} ${timeText}`;
}

function formatDuration(seconds) {
  const totalSeconds = Math.max(0, Number(seconds || 0));
  const minutes = Math.floor(totalSeconds / 60);
  const remainingSeconds = Math.round(totalSeconds % 60);
  if (!minutes) return `${remainingSeconds}s`;
  return `${minutes}m ${remainingSeconds}s`;
}

module.exports = {
  LOG_FILE,
  debug,
  error,
  formatCallType,
  formatDuration,
  formatHumanDateTime,
  formatTimestamp,
  info,
  isDebugEnabled,
  log,
  warn
};
