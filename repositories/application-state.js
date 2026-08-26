const { mapRow, requireClientId } = require('./catalog-helpers');

function scope(clientId) {
  return clientId === null ? null : requireClientId(clientId);
}

function mapState(row) {
  if (!row) return null;
  const mapped = mapRow(row, ['client_id']);
  return { client_id: mapped.client_id, key: mapped.key, value: mapped.value, version: Number(mapped.version) };
}

function conflict() {
  const error = new Error('Application state version conflict');
  error.code = 'STATE_VERSION_CONFLICT';
  return error;
}

function createApplicationStateRepository(database) {
  if (!database || typeof database.query !== 'function') throw new TypeError('Application state repository requires a database query function');
  return {
    async get(clientIdOrNull, key) {
      const clientId = scope(clientIdOrNull);
      const result = await database.query(
        `select * from application_state
          where client_id is not distinct from $1 and key = $2`,
        [clientId, key]
      );
      return mapState(result.rows[0]);
    },
    async set(clientIdOrNull, key, value, expectedVersion) {
      const clientId = scope(clientIdOrNull);
      let result;
      if (expectedVersion === undefined) {
        result = await database.query(
          `insert into application_state (client_id, key, value)
           values ($1, $2, $3)
           on conflict on constraint application_state_scope_key_unique
           do update set value = excluded.value,
                         version = application_state.version + 1,
                         updated_at = now()
           returning *`,
          [clientId, key, value]
        );
      } else {
        result = await database.query(
          `update application_state
              set value = $3, version = version + 1, updated_at = now()
            where client_id is not distinct from $1 and key = $2 and version = $4
            returning *`,
          [clientId, key, value, expectedVersion]
        );
        if (result.rowCount !== 1) throw conflict();
      }
      return mapState(result.rows[0]);
    }
  };
}

module.exports = { createApplicationStateRepository };
