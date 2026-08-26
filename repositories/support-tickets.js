const { boundedLimit, findById, insert, mapRow, requireClientId } = require('./catalog-helpers');

const FIELDS = ['customer_id', 'call_id', 'title', 'description', 'status', 'priority', 'assignee_user_id'];
const mapTicket = (row) => mapRow(row, ['id', 'client_id', 'customer_id', 'call_id']);

function createSupportTicketsRepository(database) {
  if (!database || typeof database.query !== 'function') throw new TypeError('Support tickets repository requires a database query function');
  return {
    create(clientId, input = {}) {
      return insert(database, 'support_tickets', clientId, input, FIELDS, mapTicket);
    },
    findById(clientId, id) {
      return findById(database, 'support_tickets', clientId, id, mapTicket);
    },
    async list(clientId, { status, limit = 100 } = {}) {
      const scopedClientId = requireClientId(clientId);
      const values = [scopedClientId];
      const statusClause = status ? `and status = $${values.push(status)}` : '';
      values.push(boundedLimit(limit));
      const result = await database.query(
        `select * from support_tickets where client_id = $1 ${statusClause}
         order by created_at desc, id desc limit $${values.length}`,
        values
      );
      return result.rows.map(mapTicket);
    }
  };
}

module.exports = { createSupportTicketsRepository };
