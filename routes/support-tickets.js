'use strict';
const express = require('express');
const crypto = require('crypto');
const { TICKET_STATUS, createTicketId, validateSubmission } = require('../src/support-ticket');

module.exports = function createSupportTicketsRouter({ dbRun, dbGet, dbAll, notifyNewTicket }) {
  const router = express.Router();
  const select = `SELECT ticket_id, type, description, status, reporter_username, reporter_role, page_url, page_title, context_json, assignee_username, internal_update, resolution_note, created_at, updated_at FROM support_tickets`;
  router.post('/', async (req, res, next) => {
    try {
      const payload = validateSubmission(req.body);
      const session = req.adminSession;
      const now = new Date().toISOString();
      await dbRun('BEGIN IMMEDIATE');
      let ticket;
      try {
        const insert = await dbRun(`INSERT INTO support_tickets (ticket_id,type,description,status,reporter_username,reporter_role,page_url,page_title,context_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
          [`PENDING-${crypto.randomUUID()}`, payload.type, payload.description, TICKET_STATUS.NEW, session.username, session.role, payload.context.pageUrl, payload.context.pageTitle, JSON.stringify(payload.context), now, now]);
        const ticketId = createTicketId(payload.type, insert.lastID + 1000);
        await dbRun('UPDATE support_tickets SET ticket_id = ? WHERE id = ?', [ticketId, insert.lastID]);
        ticket = await dbGet(`${select} WHERE ticket_id = ?`, [ticketId]);
        await dbRun('COMMIT');
      } catch (error) { await dbRun('ROLLBACK').catch(() => {}); throw error; }
      const admin_url = `${payload.context.pageUrl.replace(/\/[^/]*$/, '')}/support-tickets.html?ticket=${encodeURIComponent(ticket.ticket_id)}`;
      notifyNewTicket({ ...ticket, tenant_id: req.tenantId ?? null, admin_url }).catch(() => {});
      res.status(201).json({ ticket });
    } catch (error) { next(error); }
  });
  router.get('/', async (req, res, next) => { try { res.json({ tickets: await dbAll(`${select} ORDER BY updated_at DESC`) }); } catch (error) { next(error); } });
  router.get('/:ticketId', async (req, res, next) => { try { const ticket = await dbGet(`${select} WHERE ticket_id = ?`, [req.params.ticketId]); if (!ticket) return res.status(404).json({ error: 'Ticket not found' }); res.json({ ticket }); } catch (error) { next(error); } });
  router.patch('/:ticketId', async (req, res, next) => {
    try {
      const current = await dbGet(`${select} WHERE ticket_id = ?`, [req.params.ticketId]);
      if (!current) return res.status(404).json({ error: 'Ticket not found' });
      const status = req.body.status || current.status;
      if (!Object.values(TICKET_STATUS).includes(status)) return res.status(400).json({ error: 'Invalid status' });
      const resolution = String(req.body.resolutionNote ?? current.resolution_note ?? '').trim();
      if (status === TICKET_STATUS.RESOLVED && !resolution) return res.status(400).json({ error: 'Resolution note is required' });
      await dbRun('UPDATE support_tickets SET status=?, assignee_username=?, internal_update=?, resolution_note=?, updated_at=? WHERE ticket_id=?', [status, String(req.body.assigneeUsername ?? current.assignee_username ?? '').trim() || null, String(req.body.internalUpdate ?? current.internal_update ?? '').trim() || null, resolution || null, new Date().toISOString(), req.params.ticketId]);
      res.json({ ticket: await dbGet(`${select} WHERE ticket_id = ?`, [req.params.ticketId]) });
    } catch (error) { next(error); }
  });
  return router;
};
