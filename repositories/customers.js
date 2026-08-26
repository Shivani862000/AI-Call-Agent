const { toApiCustomer } = require('../persistence/mappers');

const WRITE_FIELDS = [
  'name',
  'phone',
  'preferred_slot',
  'status',
  'customer_value',
  'urgency_level',
  'priority_score',
  'ai_score',
  'preferred_language',
  'preferred_dialect',
  'do_not_call',
  'consent_status',
  'last_contact_outcome',
  'next_retry_at',
  'retry_count',
  'wrong_number_flag',
  'admin_review_required',
  'callback_requested_at',
  'last_called_at',
  'best_call_slot',
  'last_pickup_slot',
  'pickup_rate_score',
  'outstanding_issues',
  'pending_follow_ups',
  'last_sentiment_score',
  'last_sentiment_label',
  'revenue_stage',
  'revenue_estimate',
  'last_competitor_mention',
  'data_retention_until',
  'dnd_checked_at'
];

const BOOLEAN_FIELDS = new Set([
  'do_not_call',
  'wrong_number_flag',
  'admin_review_required'
]);

function requireClientId(clientId) {
  const value = Number(clientId);
  if (!Number.isSafeInteger(value) || value <= 0) {
    const error = new Error('A valid clientId is required');
    error.code = 'CLIENT_ID_REQUIRED';
    throw error;
  }
  return value;
}

function recordId(id) {
  const value = Number(id);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function databaseValue(field, value) {
  if (BOOLEAN_FIELDS.has(field) && value !== null) return Boolean(value);
  return value;
}

function selectedEntries(input = {}) {
  return WRITE_FIELDS
    .filter((field) => input[field] !== undefined)
    .map((field) => [field, databaseValue(field, input[field])]);
}

function translateConstraintError(error) {
  if (error?.code !== '23505' || error.constraint !== 'customers_client_phone_unique') {
    throw error;
  }

  const duplicate = new Error('A customer with this phone number already exists');
  duplicate.code = 'CUSTOMER_PHONE_EXISTS';
  duplicate.constraint = error.constraint;
  duplicate.cause = error;
  throw duplicate;
}

function createCustomersRepository(database) {
  if (!database || typeof database.query !== 'function' || typeof database.transaction !== 'function') {
    throw new TypeError('Customer repository requires database query and transaction functions');
  }

  async function findById(clientId, id) {
    const scopedClientId = requireClientId(clientId);
    const scopedId = recordId(id);
    if (!scopedId) return null;
    const result = await database.query(
      'select * from customers where client_id = $1 and id = $2',
      [scopedClientId, scopedId]
    );
    return toApiCustomer(result.rows[0] || null);
  }

  return {
    async create(clientId, input = {}) {
      const scopedClientId = requireClientId(clientId);
      const entries = selectedEntries(input);
      const columns = ['client_id', ...entries.map(([field]) => field)];
      const values = [scopedClientId, ...entries.map(([, value]) => value)];
      const placeholders = values.map((_, index) => `$${index + 1}`).join(', ');

      try {
        const result = await database.query(
          `insert into customers (${columns.join(', ')})
           values (${placeholders})
           returning *`,
          values
        );
        return toApiCustomer(result.rows[0]);
      } catch (error) {
        return translateConstraintError(error);
      }
    },

    findById,

    async findByPhone(clientId, phone) {
      const scopedClientId = requireClientId(clientId);
      const result = await database.query(
        'select * from customers where client_id = $1 and phone = $2',
        [scopedClientId, phone]
      );
      return toApiCustomer(result.rows[0] || null);
    },

    async list(clientId) {
      const scopedClientId = requireClientId(clientId);
      const result = await database.query(
        `select * from customers
          where client_id = $1
          order by priority_score desc, created_at desc`,
        [scopedClientId]
      );
      return result.rows.map(toApiCustomer);
    },

    async update(clientId, id, patch = {}) {
      const scopedClientId = requireClientId(clientId);
      const scopedId = recordId(id);
      if (!scopedId) return null;
      const entries = selectedEntries(patch);
      if (entries.length === 0) return findById(scopedClientId, scopedId);

      const assignments = entries.map(([field], index) => `${field} = $${index + 3}`);
      const values = [scopedClientId, scopedId, ...entries.map(([, value]) => value)];
      try {
        const result = await database.query(
          `update customers
              set ${assignments.join(', ')}, updated_at = now()
            where client_id = $1 and id = $2
            returning *`,
          values
        );
        return toApiCustomer(result.rows[0] || null);
      } catch (error) {
        return translateConstraintError(error);
      }
    },

    async scheduleRetry(clientId, id, retryAt) {
      const scopedClientId = requireClientId(clientId);
      const scopedId = recordId(id);
      if (!scopedId) return null;
      const result = await database.query(
        `update customers
            set status = 'retry_scheduled',
                next_retry_at = $3,
                retry_count = retry_count + 1,
                updated_at = now()
          where client_id = $1 and id = $2
          returning *`,
        [scopedClientId, scopedId, retryAt]
      );
      return toApiCustomer(result.rows[0] || null);
    },

    async deleteWithRelations(clientId, id) {
      const scopedClientId = requireClientId(clientId);
      const scopedId = recordId(id);
      if (!scopedId) return false;
      return database.transaction(async (client) => {
        const result = await client.query(
          'delete from customers where client_id = $1 and id = $2 returning id',
          [scopedClientId, scopedId]
        );
        return result.rowCount === 1;
      });
    },

    async findEligibleForScheduler(clientId, {
      currentSlot,
      now = new Date(),
      recentCallMinutes = 45,
      limit = 100
    } = {}) {
      const scopedClientId = requireClientId(clientId);
      const boundedLimit = Math.max(1, Math.min(Number(limit) || 100, 500));
      const boundedRecentMinutes = Math.max(0, Math.min(Number(recentCallMinutes) || 45, 1440));
      const result = await database.query(
        `select c.*
           from customers c
          where c.client_id = $1
            and c.do_not_call = false
            and c.wrong_number_flag = false
            and c.admin_review_required = false
            and c.consent_status <> 'denied'
            and (
              (c.status = 'pending' and coalesce(c.best_call_slot, c.preferred_slot) = $2)
              or (
                c.status in ('retry_scheduled', 'callback_scheduled')
                and c.next_retry_at is not null
                and c.next_retry_at <= $3::timestamptz
              )
            )
            and not exists (
              select 1
                from calls recent_call
               where recent_call.client_id = c.client_id
                 and recent_call.customer_id = c.id
                 and recent_call.called_at >= $3::timestamptz - ($4::int * interval '1 minute')
            )
          order by c.priority_score desc, c.created_at asc
          limit $5`,
        [scopedClientId, currentSlot, now, boundedRecentMinutes, boundedLimit]
      );
      return result.rows.map(toApiCustomer);
    }
  };
}

module.exports = {
  createCustomersRepository,
  requireClientId
};
