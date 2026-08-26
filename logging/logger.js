const SENSITIVE_KEYS = /authorization|cookie|password|secret|token|phone|transcript|feedback|review/i;

function redactString(value) {
  return String(value)
    .replace(/(postgres(?:ql)?:\/\/[^:\s/]+:)[^@\s/]+@/gi, '$1[REDACTED]@')
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9+/=._-]+/gi, '$1 [REDACTED]')
    .replace(/\+[1-9]\d{9,14}\b/g, '[REDACTED_PHONE]')
    .replace(/(cookie|authorization|password|secret|token)=?[^\s,;]*/gi, '$1=[REDACTED]')
    .replace(/\[(CUSTOMER|AGENT)\]:.*$/gim, '[$1]: [REDACTED]');
}

function sanitize(value, key = '') {
  if (SENSITIVE_KEYS.test(key)) return '[REDACTED]';
  if (typeof value === 'string') return redactString(value);
  if (value instanceof Error) return { name: value.name, code: value.code || 'UNKNOWN', message: redactString(value.message) };
  if (Array.isArray(value)) return value.map((item) => sanitize(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([field, item]) => [field, sanitize(item, field)]));
  }
  return value;
}

function createLogger({ sink = console, clock = () => new Date() } = {}) {
  function write(level, event, fields = {}) {
    const record = sanitize({ timestamp: clock().toISOString(), level, event, ...fields });
    const line = JSON.stringify(record);
    (level === 'error' ? sink.error : sink.log).call(sink, line);
  }
  return {
    info(event, fields) { write('info', event, fields); },
    warn(event, fields) { write('warn', event, fields); },
    error(event, fields) { write('error', event, fields); }
  };
}

module.exports = { createLogger, redactString, sanitize };
