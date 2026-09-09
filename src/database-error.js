'use strict';

// Driver messages and causes may contain connection strings or SQL values.
// Emit only fixed diagnostics; never interpolate a driver-controlled value.
const DIAGNOSTICS = new Map([
  ['28P01', 'database authentication failed'],
  ['28000', 'database authorization failed'],
  ['ECONNREFUSED', 'database connection refused'],
  ['ECONNRESET', 'database connection reset'],
  ['ETIMEDOUT', 'database connection timed out'],
  ['ENOTFOUND', 'database host lookup failed'],
  ['EAI_AGAIN', 'database host lookup temporarily unavailable'],
  ['53300', 'database connection capacity exhausted'],
  ['57P01', 'database shutting down'],
  ['57P03', 'database is not ready'],
  ['SCHEMA_VERSION_MISMATCH', 'database schema is incompatible; run the reviewed migration procedure']
]);

function databaseErrorSummary(error) {
  return DIAGNOSTICS.get(error?.code) || 'database operation failed';
}

module.exports = { databaseErrorSummary };
