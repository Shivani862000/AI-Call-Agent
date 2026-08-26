const { boundedLimit, findById, insert, mapRow, requireClientId } = require('./catalog-helpers');

const FIELDS = ['agent_id', 'name', 'status', 'schedule_policy', 'retry_policy', 'script_version'];

function createCampaignConfigurationsRepository(database) {
  if (!database || typeof database.query !== 'function') throw new TypeError('Campaign repository requires a database query function');
  return {
    create(clientId, input = {}) {
      return insert(database, 'campaign_configurations', clientId, input, FIELDS, (row) => mapRow(row, ['id', 'client_id', 'agent_id']));
    },
    findById(clientId, id) {
      return findById(database, 'campaign_configurations', clientId, id, (row) => mapRow(row, ['id', 'client_id', 'agent_id']));
    },
    async list(clientId, { status, limit = 100 } = {}) {
      const scopedClientId = requireClientId(clientId);
      const values = [scopedClientId];
      const statusClause = status ? `and status = $${values.push(status)}` : '';
      values.push(boundedLimit(limit));
      const result = await database.query(
        `select * from campaign_configurations where client_id = $1 ${statusClause}
         order by name asc, id asc limit $${values.length}`,
        values
      );
      return result.rows.map((row) => mapRow(row, ['id', 'client_id', 'agent_id']));
    }
  };
}

module.exports = { createCampaignConfigurationsRepository };
