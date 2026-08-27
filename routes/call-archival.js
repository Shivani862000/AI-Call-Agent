'use strict';

const express = require('express');
const { supabase } = require('../src/supabase');

function createCallArchiveRouter() {
  const router = express.Router();

  const archiveBulk = async (req, res) => {
    try {
      const ids = req.body?.ids;
      if (!Array.isArray(ids) || ids.length === 0) {
        return res.status(400).json({ error: 'No IDs provided for bulk operation' });
      }
      
      const username = req.adminSession?.username || req.user?.username || 'system';
      const updatePayload = {
        status: 'archived',
        archived_at: new Date().toISOString(),
        archived_by: username,
        archive_reason: 'Bulk archived'
      };

      const { data, error } = await supabase.from('calls').update(updatePayload).in('id', ids).eq('tenant_id', req.tenantId).neq('status', 'archived').select();
      if (error) throw error;
      
      res.json({ message: `${(data || []).length} calls archived successfully` });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  };

  const restoreBulk = async (req, res) => {
    try {
      const ids = req.body?.ids;
      if (!Array.isArray(ids) || ids.length === 0) {
        return res.status(400).json({ error: 'No IDs provided for bulk operation' });
      }

      const updatePayload = {
        status: 'completed', // fallback restore status for calls
        archived_at: null,
        archived_by: null,
        archive_reason: null
      };

      const { data, error } = await supabase.from('calls').update(updatePayload).in('id', ids).eq('tenant_id', req.tenantId).eq('status', 'archived').select();
      if (error) throw error;
      
      res.json({ message: `${(data || []).length} calls restored successfully` });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  };

  router.post('/bulk/archive', archiveBulk);
  router.delete('/bulk', archiveBulk);
  router.post('/bulk/restore', restoreBulk);
  return router;
}

module.exports = createCallArchiveRouter();
module.exports.createCallArchiveRouter = createCallArchiveRouter;
