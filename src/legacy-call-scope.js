'use strict';

function createLegacyCallScope(tenantId, { alias = 'calls', archived = false } = {}) {
  if (!tenantId) throw new TypeError('A concrete authorized tenant is required for call access');
  if (!/^[a-z][a-z0-9_]*$/i.test(alias)) throw new TypeError('Invalid call table alias');
  return {
    clause: `${alias}.tenant_id = ? AND ${alias}.status ${archived ? '=' : '<>'} 'archived'`,
    params: [String(tenantId)]
  };
}

function tenantVisibleRows(rows, tenantId) {
  if (!tenantId) throw new TypeError('A concrete authorized tenant is required for live call access');
  return rows.filter((row) => String(row.tenantId || row.tenant_id || '') === String(tenantId));
}

module.exports = { createLegacyCallScope, tenantVisibleRows };
