const { boundedLimit, findById, insert, mapRow, requireClientId } = require('./catalog-helpers');

const FIELDS = ['name', 'provider', 'model', 'voice', 'language', 'prompt_version', 'status'];

function createAgentsRepository(database) {
  if (!database || typeof database.query !== 'function') throw new TypeError('Agents repository requires a database query function');
  return {
    create(clientId, input = {}) {
      return insert(database, 'agents', clientId, input, FIELDS);
    },
    findById(clientId, id) {
      return findById(database, 'agents', clientId, id);
    },
    async list(clientId, { status, limit = 100 } = {}) {
      const scopedClientId = requireClientId(clientId);
      const values = [scopedClientId];
      const statusClause = status ? `and status = $${values.push(status)}` : '';
      values.push(boundedLimit(limit));
      const result = await database.query(
        `select * from agents where client_id = $1 ${statusClause}
         order by name asc, id asc limit $${values.length}`,
        values
      );
      return result.rows.map((row) => mapRow(row));
    }
  };
}

module.exports = { createAgentsRepository };
