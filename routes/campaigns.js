'use strict';

const express = require('express');
const Campaign = require('../src/models/Campaign');
const { activeRecordFilter, recordFilterFromRequest, createMongooseArchiveHandlers } = require('../src/webmaster/lifecycle');

function normalizePayload(payload = {}) {
  return {
    name: String(payload.name || '').trim(),
    service_name: String(payload.service_name || '').trim() || null,
    monthly_spend_inr: Number(payload.monthly_spend_inr || 0) || 0,
    status: String(payload.status || 'active').trim().toLowerCase() || 'active'
  };
}

function serialize(record) {
  const value = record?.toObject ? record.toObject() : { ...record };
  if (value._id !== undefined) value.id = String(value._id);
  delete value._id;
  delete value.archived_by;
  return value;
}

function createCampaignsRouter({ Model = Campaign } = {}) {
  const router = express.Router();
  const archiveHandlers = createMongooseArchiveHandlers({ Model, resourceName: 'Campaign' });

  router.get('/', async (req, res) => {
    try {
      const rows = await Model.find(recordFilterFromRequest(req, { tenantId: req.tenantId })).sort({ created_at: -1, name: 1 }).lean();
      res.json(rows.map(serialize));
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  router.post('/', async (req, res) => {
    try {
      const payload = normalizePayload(req.body);
      if (!payload.name) return res.status(400).json({ error: 'Campaign name is required' });
      const record = await Model.create({ ...payload, tenantId: req.tenantId });
      res.json({ id: String(record._id), message: 'Campaign created successfully' });
    } catch (error) {
      res.status(error.code === 11000 ? 409 : 500).json({ error: error.code === 11000 ? 'Campaign already exists' : error.message });
    }
  });

  router.put('/:id', async (req, res) => {
    try {
      const payload = normalizePayload(req.body);
      if (!payload.name) return res.status(400).json({ error: 'Campaign name is required' });
      const record = await Model.findOneAndUpdate(
        activeRecordFilter({ _id: req.params.id, tenantId: req.tenantId }),
        { $set: payload },
        { new: true, runValidators: true }
      );
      if (!record) return res.status(404).json({ error: 'Campaign not found' });
      res.json({ message: 'Campaign updated successfully' });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  router.post('/:id/archive', archiveHandlers.archive);
  router.post('/:id/restore', archiveHandlers.restore);
  router.delete('/:id', archiveHandlers.archive);
  return router;
}

module.exports = createCampaignsRouter();
module.exports.createCampaignsRouter = createCampaignsRouter;
