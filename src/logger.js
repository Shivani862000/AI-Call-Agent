'use strict';

const { AsyncLocalStorage } = require('node:async_hooks');
const util = require('util');

const asyncLocalStorage = new AsyncLocalStorage();

const LOG_LEVELS = {
  DEBUG: 10,
  INFO: 20,
  WARN: 30,
  ERROR: 40,
  FATAL: 50
};

const CURRENT_LEVEL = process.env.LOG_LEVEL 
  ? (LOG_LEVELS[process.env.LOG_LEVEL.toUpperCase()] || LOG_LEVELS.INFO) 
  : LOG_LEVELS.INFO;

const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const SERVICE_NAME = 'feedback-automation-system';

const originalConsoleLog = console.log;
const originalConsoleWarn = console.warn;
const originalConsoleError = console.error;

/**
 * Run a function within a logging context.
 */
function runWithContext(context, fn) {
  return asyncLocalStorage.run(context || {}, fn);
}

/**
 * Get the current logging context.
 */
function getContext() {
  return asyncLocalStorage.getStore() || {};
}

/**
 * Sanitize sensitive details.
 */
function maskValue(key, value) {
  if (value == null) return value;
  const k = String(key).toLowerCase();
  if (/(token|secret|password|authorization|apikey|ukey|key)/.test(k)) return '[REDACTED]';
  if (typeof value === 'object' && !Array.isArray(value)) {
    const masked = {};
    for (const [subK, subV] of Object.entries(value)) {
      masked[subK] = maskValue(subK, subV);
    }
    return masked;
  }
  return value;
}

function sanitizeDetails(details) {
  if (!details || typeof details !== 'object') return {};
  const clean = {};
  for (const [key, value] of Object.entries(details)) {
    if (value instanceof Error) {
      clean[key] = {
        name: value.name,
        message: value.message,
        code: value.code || undefined,
        stack: value.stack
      };
    } else {
      clean[key] = maskValue(key, value);
    }
  }
  return clean;
}

function writeLog(levelName, event, details = {}) {
  const levelValue = LOG_LEVELS[levelName] || LOG_LEVELS.INFO;
  if (levelValue < CURRENT_LEVEL) return;

  const context = getContext();
  
  // Extract error object if provided as details.error or if details is an Error
  let errorObj = undefined;
  let cleanDetails = {};
  
  if (details instanceof Error) {
    errorObj = details;
  } else {
    cleanDetails = sanitizeDetails(details);
    if (details.error instanceof Error) {
      errorObj = details.error;
    }
  }

  const logEntry = {
    timestamp: new Date().toISOString(),
    level: levelName,
    service: SERVICE_NAME,
    environment: process.env.NODE_ENV || 'development',
    event: event || 'LOG',
    ...context, // Automatically merges requestId, userId, tenantId, etc.
    ...cleanDetails
  };

  if (errorObj) {
    logEntry.error = {
      name: errorObj.name,
      message: errorObj.message,
      code: errorObj.code,
      stack: errorObj.stack
    };
  }

  if (IS_PRODUCTION) {
    // Structured JSON for production
    const out = JSON.stringify(logEntry);
    if (levelValue >= LOG_LEVELS.ERROR) {
      originalConsoleError(out);
    } else {
      originalConsoleLog(out);
    }
  } else {
    // Human readable for development
    const meta = Object.assign({}, context, cleanDetails);
    delete meta.event;
    delete meta.level;
    delete meta.timestamp;
    delete meta.service;
    delete meta.environment;
    
    let metaStr = '';
    for (const [k, v] of Object.entries(meta)) {
      if (v === undefined || k === 'error') continue;
      metaStr += ` ${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`;
    }

    const line = `[${logEntry.timestamp}] [${levelName}] [${logEntry.event}]${metaStr}`;
    
    if (levelValue >= LOG_LEVELS.ERROR) {
      originalConsoleError(line);
      if (logEntry.error && logEntry.error.stack) {
        originalConsoleError(logEntry.error.stack);
      }
    } else if (levelValue === LOG_LEVELS.WARN) {
      originalConsoleWarn(line);
    } else {
      originalConsoleLog(line);
    }
  }
}

const logger = {
  runWithContext,
  getContext,
  debug: (event, details) => writeLog('DEBUG', event, details),
  info: (event, details) => writeLog('INFO', event, details),
  warn: (event, details) => writeLog('WARN', event, details),
  error: (event, details) => writeLog('ERROR', event, details),
  fatal: (event, details) => writeLog('FATAL', event, details),
};

// Override global console to ensure 100% coverage of un-instrumented code and dependencies
console.log = function (...args) {
  if (args.length === 0) return;
  const msg = typeof args[0] === 'string' ? args[0] : 'CONSOLE_LOG';
  const details = args.length > 1 ? { data: args.slice(1) } : (typeof args[0] !== 'string' ? { data: args[0] } : {});
  logger.info(msg.replace(/[^a-zA-Z0-9_]/g, '_').toUpperCase() || 'CONSOLE_LOG', details);
};

console.warn = function (...args) {
  if (args.length === 0) return;
  const msg = typeof args[0] === 'string' ? args[0] : 'CONSOLE_WARN';
  const details = args.length > 1 ? { data: args.slice(1) } : (typeof args[0] !== 'string' ? { data: args[0] } : {});
  logger.warn(msg.replace(/[^a-zA-Z0-9_]/g, '_').toUpperCase() || 'CONSOLE_WARN', details);
};

console.error = function (...args) {
  if (args.length === 0) return;
  const msg = typeof args[0] === 'string' ? args[0] : 'CONSOLE_ERROR';
  const details = args.length > 1 ? { data: args.slice(1) } : (typeof args[0] !== 'string' ? { data: args[0] } : {});
  logger.error(msg.replace(/[^a-zA-Z0-9_]/g, '_').toUpperCase() || 'CONSOLE_ERROR', details);
};

module.exports = logger;
