'use strict';

function archiveFields(actor, reason = '') {
  return {
    status: 'archived',
    archived_at: new Date(),
    archived_by: actor?.username || 'system',
    archive_reason: String(reason).trim() || null
  };
}

function activeRecordFilter(extra = {}) {
  return { ...extra, status: { $ne: 'archived' } };
}

function recordFilterFromRequest(req, extra = {}) {
  return String(req.query?.status || '').toLowerCase() === 'archived'
    ? { ...extra, status: 'archived' }
    : activeRecordFilter(extra);
}

function activeOperationalFilter(extra = {}) {
  return { $and: [activeRecordFilter(), extra] };
}

function restoreFields(status = 'active') {
  return {
    status,
    archived_at: null,
    archived_by: null,
    archive_reason: null
  };
}

function lifecycleResource(record) {
  return {
    id: record?._id || record?.id,
    status: record?.status,
    archived_at: record?.archived_at || null,
    archived_by: record?.archived_by || null,
    archive_reason: record?.archive_reason || null
  };
}

function actorFromRequest(req) {
  return req.adminSession || { username: 'system' };
}

function tenantScope(req, extra = {}) {
  return { ...extra, tenantId: req.tenantId };
}

function createMongooseArchiveHandlers({ Model, resourceName, restoreStatus = 'active', scopeFromRequest = tenantScope }) {
  if (!Model || !resourceName) throw new TypeError('Model and resourceName are required');

  async function archive(req, res) {
    try {
      const fields = archiveFields(actorFromRequest(req), req.body?.reason);
      const record = await Model.findOneAndUpdate(
        scopeFromRequest(req, { _id: req.params.id }),
        { $set: fields },
        { new: true }
      );
      if (!record) return res.status(404).json({ error: `${resourceName} not found` });
      return res.status(200).json({
        message: `${resourceName} archived successfully`,
        resource: lifecycleResource(record)
      });
    } catch (error) {
      return res.status(500).json({ error: `Unable to archive ${resourceName}` });
    }
  }

  async function restore(req, res) {
    try {
      const record = await Model.findOneAndUpdate(
        scopeFromRequest(req, { _id: req.params.id, status: 'archived' }),
        { $set: restoreFields(restoreStatus) },
        { new: true }
      );
      if (!record) return res.status(404).json({ error: `${resourceName} not found` });
      return res.status(200).json({
        message: `${resourceName} restored successfully`,
        resource: lifecycleResource(record)
      });
    } catch (error) {
      return res.status(500).json({ error: `Unable to restore ${resourceName}` });
    }
  }

  async function archiveBulk(req, res) {
    try {
      const fields = archiveFields(actorFromRequest(req), req.body?.reason);
      const result = await Model.updateMany(
        activeRecordFilter(scopeFromRequest(req)),
        { $set: fields }
      );
      return res.status(200).json({
        message: `${resourceName} records archived successfully`,
        archivedCount: Number(result?.modifiedCount || 0),
        resource: {
          status: fields.status,
          archived_at: fields.archived_at,
          archived_by: fields.archived_by,
          archive_reason: fields.archive_reason
        }
      });
    } catch (error) {
      return res.status(500).json({ error: `Unable to archive ${resourceName} records` });
    }
  }

  return { archive, restore, archiveBulk };
}

function assertSqlIdentifier(value) {
  if (!/^[a-z][a-z0-9_]*$/i.test(String(value || ''))) {
    throw new TypeError('Invalid SQL identifier');
  }
  return value;
}

function createSqlArchiveHandlers({ dbGet, dbRun, tableName, resourceName, restoreStatus = 'active' }) {
  assertSqlIdentifier(tableName);
  if (!dbGet || !dbRun || !resourceName) throw new TypeError('dbGet, dbRun, and resourceName are required');

  async function findScoped(req) {
    return dbGet(
      `SELECT id, status FROM ${tableName} WHERE id = ? AND tenant_id = ?`,
      [req.params.id, String(req.tenantId)]
    );
  }

  async function archive(req, res) {
    try {
      const existing = await findScoped(req);
      if (!existing) return res.status(404).json({ error: `${resourceName} not found` });
      const fields = archiveFields(actorFromRequest(req), req.body?.reason);
      await dbRun(
        `UPDATE ${tableName}
            SET status = 'archived', archived_at = ?, archived_by = ?, archive_reason = ?
          WHERE id = ? AND tenant_id = ?`,
        [fields.archived_at.toISOString(), fields.archived_by, fields.archive_reason, req.params.id, String(req.tenantId)]
      );
      return res.status(200).json({
        message: `${resourceName} archived successfully`,
        resource: lifecycleResource({ id: existing.id, ...fields })
      });
    } catch (error) {
      return res.status(500).json({ error: `Unable to archive ${resourceName}` });
    }
  }

  async function restore(req, res) {
    try {
      const existing = await findScoped(req);
      if (!existing || existing.status !== 'archived') {
        return res.status(404).json({ error: `${resourceName} not found` });
      }
      const fields = restoreFields(restoreStatus);
      await dbRun(
        `UPDATE ${tableName}
            SET status = ?, archived_at = NULL, archived_by = NULL, archive_reason = NULL
          WHERE id = ? AND tenant_id = ?`,
        [fields.status, req.params.id, String(req.tenantId)]
      );
      return res.status(200).json({
        message: `${resourceName} restored successfully`,
        resource: lifecycleResource({ id: existing.id, ...fields })
      });
    } catch (error) {
      return res.status(500).json({ error: `Unable to restore ${resourceName}` });
    }
  }

  return { archive, restore };
}

module.exports = {
  archiveFields,
  activeRecordFilter,
  recordFilterFromRequest,
  activeOperationalFilter,
  restoreFields,
  lifecycleResource,
  createMongooseArchiveHandlers,
  createSqlArchiveHandlers
};
