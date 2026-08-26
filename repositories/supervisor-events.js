const { toApiSupervisorEvent } = require('../persistence/mappers');
const { requireClientId } = require('./customers');

function payloadValue(input) {
  const value = input.payload === undefined ? input.payload_json : input.payload;
  if (value === undefined) return {};
  if (value === null || typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    const error = new Error('Invalid supervisor event payload JSON');
    error.code = 'INVALID_JSON_FIELD';
    throw error;
  }
}

function createSupervisorEventsRepository(database) {
  if (!database || typeof database.query !== 'function') {
    throw new TypeError('Supervisor events repository requires a database query function');
  }

  return {
    async append(clientId, input = {}) {
      const scopedClientId = requireClientId(clientId);
      const result = await database.query(
        `insert into call_supervisor_events (
           client_id, call_id, event_type, severity, payload, created_at
         ) values ($1, $2, $3, $4, $5, coalesce($6::timestamptz, now()))
         returning *`,
        [
          scopedClientId,
          input.call_id,
          input.event_type,
          input.severity || 'info',
          payloadValue(input),
          input.created_at || null
        ]
      );
      return toApiSupervisorEvent(result.rows[0]);
    },

    async listForCall(clientId, callId, { limit = 50 } = {}) {
      const scopedClientId = requireClientId(clientId);
      const boundedLimit = Math.max(1, Math.min(Number(limit) || 50, 200));
      const result = await database.query(
        `select * from call_supervisor_events
          where client_id = $1 and call_id = $2
          order by created_at desc, id desc
          limit $3`,
        [scopedClientId, callId, boundedLimit]
      );
      return result.rows.map(toApiSupervisorEvent);
    }
  };
}

module.exports = { createSupervisorEventsRepository };
