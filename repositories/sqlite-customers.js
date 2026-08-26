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

function entries(input = {}) {
  return WRITE_FIELDS
    .filter((field) => input[field] !== undefined)
    .map((field) => [field, input[field]]);
}

function translateDuplicate(error) {
  if (!error?.message?.includes('UNIQUE constraint failed: customers.phone')) throw error;
  const duplicate = new Error('A customer with this phone number already exists');
  duplicate.code = 'CUSTOMER_PHONE_EXISTS';
  throw duplicate;
}

function createSqliteCustomersRepository({ dbRun, dbGet, dbAll }) {
  return {
    async create(_clientId, input) {
      const selected = entries(input);
      try {
        const result = await dbRun(
          `INSERT INTO customers (${selected.map(([field]) => field).join(', ')})
           VALUES (${selected.map(() => '?').join(', ')})`,
          selected.map(([, value]) => value)
        );
        return dbGet('SELECT * FROM customers WHERE id = ?', [result.lastID]);
      } catch (error) {
        return translateDuplicate(error);
      }
    },

    findById(_clientId, id) {
      return dbGet('SELECT * FROM customers WHERE id = ?', [id]);
    },

    findByPhone(_clientId, phone) {
      return dbGet('SELECT * FROM customers WHERE phone = ?', [phone]);
    },

    list() {
      return dbAll('SELECT * FROM customers ORDER BY COALESCE(priority_score, 0) DESC, created_at DESC');
    },

    async update(_clientId, id, patch) {
      const selected = entries(patch);
      if (selected.length > 0) {
        try {
          await dbRun(
            `UPDATE customers SET ${selected.map(([field]) => `${field} = ?`).join(', ')} WHERE id = ?`,
            [...selected.map(([, value]) => value), id]
          );
        } catch (error) {
          return translateDuplicate(error);
        }
      }
      return dbGet('SELECT * FROM customers WHERE id = ?', [id]);
    },

    async scheduleRetry(_clientId, id, retryAt) {
      await dbRun(
        `UPDATE customers
            SET status = ?, next_retry_at = ?, retry_count = COALESCE(retry_count, 0) + 1
          WHERE id = ?`,
        ['retry_scheduled', retryAt, id]
      );
      return dbGet('SELECT * FROM customers WHERE id = ?', [id]);
    },

    async deleteWithRelations(_clientId, id) {
      const existing = await dbGet('SELECT id FROM customers WHERE id = ?', [id]);
      if (!existing) return false;
      await dbRun('DELETE FROM feedback WHERE customer_id = ?', [id]);
      await dbRun('DELETE FROM calls WHERE customer_id = ?', [id]);
      await dbRun('DELETE FROM customers WHERE id = ?', [id]);
      return true;
    },

    findEligibleForScheduler(_clientId, { currentSlot }) {
      return dbAll(
        `SELECT c.*
           FROM customers c
           LEFT JOIN calls recent_call
             ON recent_call.customer_id = c.id
            AND DATETIME(recent_call.called_at) >= DATETIME('now', '-45 minutes')
          WHERE COALESCE(c.do_not_call, 0) = 0
            AND COALESCE(c.wrong_number_flag, 0) = 0
            AND COALESCE(c.admin_review_required, 0) = 0
            AND COALESCE(c.consent_status, 'unknown') != 'denied'
            AND (
              (c.status = 'pending' AND COALESCE(c.best_call_slot, c.preferred_slot) = ?)
              OR (c.status IN ('retry_scheduled', 'callback_scheduled') AND c.next_retry_at IS NOT NULL AND DATETIME(c.next_retry_at) <= DATETIME('now'))
            )
            AND recent_call.id IS NULL
          ORDER BY COALESCE(c.priority_score, 0) DESC, c.created_at ASC`,
        [currentSlot]
      );
    }
  };
}

module.exports = { createSqliteCustomersRepository };
