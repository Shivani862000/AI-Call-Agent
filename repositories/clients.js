const { toApiClient } = require('../persistence/mappers');

const CREATE_FIELDS = ['slug', 'name', 'status', 'timezone', 'metadata'];

function selectedEntries(input, fields) {
  return fields
    .filter((field) => input[field] !== undefined)
    .map((field) => [field, input[field]]);
}

function createClientsRepository(database) {
  if (!database || typeof database.query !== 'function') {
    throw new TypeError('Client repository requires a database query function');
  }

  return {
    async create(input = {}) {
      const entries = selectedEntries(input, CREATE_FIELDS);
      const columns = entries.map(([field]) => field).join(', ');
      const placeholders = entries.map((_, index) => `$${index + 1}`).join(', ');
      const values = entries.map(([, value]) => value);
      const result = await database.query(
        `insert into clients (${columns})
         values (${placeholders})
         returning *`,
        values
      );
      return toApiClient(result.rows[0]);
    },

    async findById(id) {
      const result = await database.query(
        'select * from clients where id = $1',
        [id]
      );
      return toApiClient(result.rows[0] || null);
    },

    async findBySlug(slug) {
      const result = await database.query(
        'select * from clients where slug = $1',
        [slug]
      );
      return toApiClient(result.rows[0] || null);
    },

    async listActive() {
      const result = await database.query(
        "select * from clients where status = 'active' order by id asc"
      );
      return result.rows.map(toApiClient);
    }
  };
}

module.exports = { createClientsRepository };
