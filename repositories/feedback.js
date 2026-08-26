const { toApiFeedback } = require('../persistence/mappers');
const { requireClientId } = require('./customers');

const WRITE_FIELDS = ['customer_id', 'call_id', 'review_text', 'category', 'stars', 'source', 'submitted_at'];

function entries(input = {}) {
  return WRITE_FIELDS
    .filter((field) => input[field] !== undefined)
    .map((field) => [field, input[field]]);
}

function createFeedbackRepository(database) {
  if (!database || typeof database.query !== 'function') {
    throw new TypeError('Feedback repository requires a database query function');
  }

  return {
    async create(clientId, input = {}) {
      const scopedClientId = requireClientId(clientId);
      const selected = entries(input);
      const values = [scopedClientId, ...selected.map(([, value]) => value)];
      const result = await database.query(
        `insert into feedback (client_id, ${selected.map(([field]) => field).join(', ')})
         values (${values.map((_, index) => `$${index + 1}`).join(', ')})
         returning *`,
        values
      );
      return toApiFeedback(result.rows[0]);
    },

    async upsertForCall(clientId, input = {}) {
      const scopedClientId = requireClientId(clientId);
      const result = await database.query(
        `insert into feedback (
           client_id, customer_id, call_id, review_text, category, stars, source, submitted_at
         ) values ($1, $2, $3, $4, $5, $6, $7, coalesce($8::timestamptz, now()))
         on conflict (call_id) where call_id is not null
         do update set
           review_text = excluded.review_text,
           category = excluded.category,
           stars = excluded.stars,
           source = excluded.source,
           submitted_at = excluded.submitted_at
         where feedback.client_id = excluded.client_id
           and feedback.customer_id = excluded.customer_id
         returning feedback.*`,
        [
          scopedClientId,
          input.customer_id,
          input.call_id,
          input.review_text ?? null,
          input.category ?? null,
          input.stars ?? null,
          input.source || 'call',
          input.submitted_at || null
        ]
      );
      if (result.rowCount !== 1) {
        const error = new Error('Feedback call scope does not match');
        error.code = 'FEEDBACK_SCOPE_MISMATCH';
        throw error;
      }
      return toApiFeedback(result.rows[0]);
    },

    async findByCallId(clientId, callId) {
      const scopedClientId = requireClientId(clientId);
      const result = await database.query(
        'select * from feedback where client_id = $1 and call_id = $2',
        [scopedClientId, callId]
      );
      return toApiFeedback(result.rows[0] || null);
    },

    async list(clientId, { limit = 500 } = {}) {
      const scopedClientId = requireClientId(clientId);
      const boundedLimit = Math.max(1, Math.min(Number(limit) || 500, 1000));
      const result = await database.query(
        `select f.*, c.name as customer_name
           from feedback f
           join customers c
             on c.client_id = f.client_id
            and c.id = f.customer_id
          where f.client_id = $1
          order by f.submitted_at desc, f.id desc
          limit $2`,
        [scopedClientId, boundedLimit]
      );
      return result.rows.map(toApiFeedback);
    }
  };
}

module.exports = { createFeedbackRepository };
