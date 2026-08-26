const { toApiCall } = require('../persistence/mappers');
const { requireClientId } = require('./customers');

const WRITE_FIELDS = [
  'customer_id', 'called_at', 'outcome', 'outcome_detail', 'twilio_sid',
  'whatsapp_sent', 'transcript_text', 'consent_detected', 'language',
  'extracted_rating', 'extracted_review_text', 'feedback_saved_at',
  'recording_sid', 'recording_url', 'recording_status', 'transcript_status',
  'transcript_source', 'analysis_status', 'analysis_summary', 'analysis',
  'key_points', 'report_excerpt', 'analysis_completed_at', 'fallback_triggered',
  'sentiment_label', 'sentiment_score', 'hot_lead_score', 'next_action_at',
  'follow_up_task', 'recording_download_status', 'crm_sync_status',
  'whatsapp_summary_sent', 'revenue_attribution_status', 'call_script_version',
  'competitor_mentions', 'objections', 'interest_detected', 'callback_requested',
  'human_escalation_requested', 'supervisor_alert_level', 'supervisor_notes',
  'consent_message_played', 'recording_consent_captured', 'invoice_triggered',
  'proposal_triggered', 'live_sentiment_score', 'live_sentiment_label',
  'live_red_flag'
];

const BOOLEAN_FIELDS = new Set([
  'whatsapp_sent', 'consent_detected', 'fallback_triggered',
  'whatsapp_summary_sent', 'interest_detected', 'callback_requested',
  'human_escalation_requested', 'consent_message_played',
  'recording_consent_captured', 'invoice_triggered', 'proposal_triggered',
  'live_red_flag'
]);

const JSON_ALIASES = {
  analysis_json: 'analysis',
  key_points_json: 'key_points',
  objections_json: 'objections',
  competitor_mentions_json: 'competitor_mentions'
};

function validId(id) {
  const value = Number(id);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function booleanValue(value) {
  return value === true || value === 1 || value === '1' || value === 'true';
}

function jsonValue(value) {
  if (value === null) return value;
  try {
    return JSON.stringify(typeof value === 'string' ? JSON.parse(value) : value);
  } catch {
    const error = new Error('Invalid JSON compatibility field');
    error.code = 'INVALID_JSON_FIELD';
    throw error;
  }
}

function normalizeInput(input = {}) {
  const normalized = { ...input };
  for (const [legacy, native] of Object.entries(JSON_ALIASES)) {
    if (normalized[native] === undefined && normalized[legacy] !== undefined) {
      normalized[native] = normalized[legacy];
    }
  }
  return WRITE_FIELDS
    .filter((field) => normalized[field] !== undefined)
    .map((field) => {
      let value = normalized[field];
      if (BOOLEAN_FIELDS.has(field) && value !== null) value = booleanValue(value);
      if (['analysis', 'key_points', 'objections', 'competitor_mentions'].includes(field)) value = jsonValue(value);
      return [field, value];
    });
}

function translateError(error) {
  if (error?.code === '23505' && error.constraint === 'calls_twilio_sid_unique') {
    const duplicate = new Error('A call with this Twilio SID already exists');
    duplicate.code = 'CALL_SID_EXISTS';
    duplicate.constraint = error.constraint;
    duplicate.cause = error;
    throw duplicate;
  }
  if (error?.code === '23514' && error.constraint === 'calls_payload_size_check') {
    const oversized = new Error('Call payload exceeds the 2 MiB limit');
    oversized.code = 'CALL_PAYLOAD_TOO_LARGE';
    oversized.constraint = error.constraint;
    oversized.cause = error;
    throw oversized;
  }
  throw error;
}

async function insertCall(queryable, clientId, input) {
  const entries = normalizeInput(input);
  const columns = ['client_id', ...entries.map(([field]) => field)];
  const values = [clientId, ...entries.map(([, value]) => value)];
  const placeholders = values.map((_, index) => `$${index + 1}`).join(', ');
  try {
    const result = await queryable.query(
      `insert into calls (${columns.join(', ')})
       values (${placeholders})
       returning *`,
      values
    );
    return toApiCall(result.rows[0]);
  } catch (error) {
    return translateError(error);
  }
}

function createCallsRepository(database) {
  if (!database || typeof database.query !== 'function' || typeof database.transaction !== 'function') {
    throw new TypeError('Calls repository requires database query and transaction functions');
  }

  return {
    async create(clientId, input = {}) {
      return insertCall(database, requireClientId(clientId), input);
    },

    async createAndMarkCustomer(clientId, input = {}) {
      const scopedClientId = requireClientId(clientId);
      const customerId = validId(input.customer_id);
      return database.transaction(async (client) => {
        const customer = await client.query(
          `update customers
              set status = $3, updated_at = now()
            where client_id = $1 and id = $2
            returning id`,
          [scopedClientId, customerId, input.customer_status || 'called']
        );
        if (customer.rowCount !== 1) {
          const error = new Error('Customer not found');
          error.code = 'CUSTOMER_NOT_FOUND';
          throw error;
        }
        return insertCall(client, scopedClientId, input);
      });
    },

    async findById(clientId, id) {
      const scopedClientId = requireClientId(clientId);
      const scopedId = validId(id);
      if (!scopedId) return null;
      const result = await database.query(
        'select * from calls where client_id = $1 and id = $2',
        [scopedClientId, scopedId]
      );
      return toApiCall(result.rows[0] || null);
    },

    async findByTwilioSid(clientId, twilioSid) {
      const scopedClientId = requireClientId(clientId);
      const result = await database.query(
        'select * from calls where client_id = $1 and twilio_sid = $2',
        [scopedClientId, twilioSid]
      );
      return toApiCall(result.rows[0] || null);
    },

    async findByIdWithCustomer(clientId, id) {
      const scopedClientId = requireClientId(clientId);
      const scopedId = validId(id);
      if (!scopedId) return null;
      const result = await database.query(
        `select calls.*, customers.name as customer_name, customers.phone as customer_phone
           from calls
           join customers
             on customers.client_id = calls.client_id
            and customers.id = calls.customer_id
          where calls.client_id = $1 and calls.id = $2`,
        [scopedClientId, scopedId]
      );
      return toApiCall(result.rows[0] || null);
    },

    async findByTwilioSidWithCustomer(clientId, twilioSid) {
      const scopedClientId = requireClientId(clientId);
      const result = await database.query(
        `select calls.*, customers.name as customer_name, customers.phone as customer_phone
           from calls
           join customers
             on customers.client_id = calls.client_id
            and customers.id = calls.customer_id
          where calls.client_id = $1 and calls.twilio_sid = $2`,
        [scopedClientId, twilioSid]
      );
      return toApiCall(result.rows[0] || null);
    },

    async update(clientId, id, patch = {}) {
      const scopedClientId = requireClientId(clientId);
      const scopedId = validId(id);
      if (!scopedId) return null;
      const entries = normalizeInput(patch);
      if (entries.length === 0) return this.findById(scopedClientId, scopedId);
      const assignments = entries.map(([field], index) => `${field} = $${index + 3}`);
      const values = [scopedClientId, scopedId, ...entries.map(([, value]) => value)];
      try {
        const result = await database.query(
          `update calls
              set ${assignments.join(', ')}, updated_at = now()
            where client_id = $1 and id = $2
            returning *`,
          values
        );
        return toApiCall(result.rows[0] || null);
      } catch (error) {
        return translateError(error);
      }
    },

    async updateByTwilioSid(clientId, twilioSid, patch = {}) {
      const scopedClientId = requireClientId(clientId);
      const entries = normalizeInput(patch);
      if (entries.length === 0) return this.findByTwilioSid(scopedClientId, twilioSid);
      const assignments = entries.map(([field], index) => `${field} = $${index + 3}`);
      const values = [scopedClientId, twilioSid, ...entries.map(([, value]) => value)];
      try {
        const result = await database.query(
          `update calls
              set ${assignments.join(', ')}, updated_at = now()
            where client_id = $1 and twilio_sid = $2
            returning *`,
          values
        );
        return toApiCall(result.rows[0] || null);
      } catch (error) {
        return translateError(error);
      }
    },

    async listRecent(clientId, { limit = 25 } = {}) {
      const scopedClientId = requireClientId(clientId);
      const boundedLimit = Math.max(1, Math.min(Number(limit) || 25, 100));
      const result = await database.query(
        `select calls.*, customers.name as customer_name, customers.phone as customer_phone
           from calls
           join customers
             on customers.client_id = calls.client_id
            and customers.id = calls.customer_id
          where calls.client_id = $1
          order by calls.id desc
          limit $2`,
        [scopedClientId, boundedLimit]
      );
      return result.rows.map(toApiCall);
    },

    async listForCustomer(clientId, customerId, { limit = 20 } = {}) {
      const scopedClientId = requireClientId(clientId);
      const scopedCustomerId = validId(customerId);
      if (!scopedCustomerId) return [];
      const boundedLimit = Math.max(1, Math.min(Number(limit) || 20, 100));
      const result = await database.query(
        `select * from calls
          where client_id = $1 and customer_id = $2
          order by called_at desc nulls last, id desc
          limit $3`,
        [scopedClientId, scopedCustomerId, boundedLimit]
      );
      return result.rows.map(toApiCall);
    }
  };
}

module.exports = { createCallsRepository };
