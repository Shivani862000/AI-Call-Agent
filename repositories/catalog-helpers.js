const { requireClientId } = require('./customers');

function safeId(value, field) {
  if (value === null || value === undefined) return value;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    const error = new Error(`${field} is outside JavaScript's safe integer range`);
    error.code = 'UNSAFE_DATABASE_ID';
    throw error;
  }
  return parsed;
}

function mapRow(row, idFields = ['id', 'client_id']) {
  if (!row) return null;
  const result = { ...row };
  for (const field of idFields) {
    if (Object.hasOwn(result, field)) result[field] = safeId(result[field], field);
  }
  for (const [field, value] of Object.entries(result)) {
    if (value instanceof Date) result[field] = value.toISOString();
  }
  return result;
}

function boundedLimit(value, fallback = 100) {
  return Math.max(1, Math.min(Number(value) || fallback, 500));
}

function selectedEntries(input, fields) {
  return fields.filter((field) => input[field] !== undefined).map((field) => [field, input[field]]);
}

async function insert(database, table, clientId, input, fields, mapper = mapRow) {
  const scopedClientId = requireClientId(clientId);
  const entries = selectedEntries(input, fields);
  const columns = ['client_id', ...entries.map(([field]) => field)];
  const values = [scopedClientId, ...entries.map(([, value]) => value)];
  const result = await database.query(
    `insert into ${table} (${columns.join(', ')})
     values (${values.map((_, index) => `$${index + 1}`).join(', ')}) returning *`,
    values
  );
  return mapper(result.rows[0]);
}

async function findById(database, table, clientId, id, mapper = mapRow) {
  const scopedClientId = requireClientId(clientId);
  const scopedId = safeId(id, `${table}.id`);
  const result = await database.query(
    `select * from ${table} where client_id = $1 and id = $2`,
    [scopedClientId, scopedId]
  );
  return mapper(result.rows[0]);
}

module.exports = { boundedLimit, findById, insert, mapRow, requireClientId, safeId };
