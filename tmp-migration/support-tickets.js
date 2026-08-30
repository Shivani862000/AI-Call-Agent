'use strict';
const express = require('express');
const { TICKET_STATUS, createTicketId, validateSubmission } = require('../src/support-ticket');
const DefaultSupportTicket = require('../src/models/SupportTicket');
const DefaultTicketCounter = require('../src/models/SupportTicketCounter');

function toPlain(ticket) {
  return ticket?.toObject ? ticket.toObject() : ticket;
}

module.exports = function createSupportTicketsRouter({
  SupportTicket = DefaultSupportTicket,
  TicketCounter = DefaultTicketCounter,
  notifyNewTicket
} = {}) {
  const router = express.Router();
  router.post('/', async (req, res, next) => {
    try {
      const payload = validateSubmission(req.body);
      const session = req.adminSession;
      const counter = await TicketCounter.findOneAndUpdate(
        { _id: 'support-tickets' },
        { $inc: { sequence: 1 } },
        { new: true, upsert: true, setDefaultsOnInsert: true }
      );
      const sequence = counter.sequence + 1000;
      const ticket = toPlain(await SupportTicket.create({
        ticket_id: createTicketId(payload.type, sequence),
        sequence,
        tenant_id: req.tenantId ? String(req.tenantId) : null,
        type: payload.type,
        description: payload.description,
        status: TICKET_STATUS.NEW,
        reporter_username: session.username,
        reporter_role: session.role,
        page_url: payload.context.pageUrl,
        page_title: payload.context.pageTitle,
        context_json: payload.context
      }));
      const admin_url = `${payload.context.pageUrl.replace(/\/[^/]*$/, '')}/support-tickets.html?ticket=${encodeURIComponent(ticket.ticket_id)}`;
      notifyNewTicket?.({ ...ticket, tenant_id: ticket.tenant_id, admin_url }).catch(() => {});
      res.status(201).json({ ticket });
    } catch (error) { next(error); }
  });
  router.get('/', async (_req, res, next) => { try { res.json({ tickets: await SupportTicket.find({}).sort({ updated_at: -1 }).lean() }); } catch (error) { next(error); } });
  router.get('/:ticketId', async (req, res, next) => { try { const ticket = await SupportTicket.findOne({ ticket_id: req.params.ticketId }).lean(); if (!ticket) return res.status(404).json({ error: 'Ticket not found' }); res.json({ ticket }); } catch (error) { next(error); } });
  router.patch('/:ticketId', async (req, res, next) => {
    try {
      const current = await SupportTicket.findOne({ ticket_id: req.params.ticketId }).lean();
      if (!current) return res.status(404).json({ error: 'Ticket not found' });
      const status = req.body.status || current.status;
      if (!Object.values(TICKET_STATUS).includes(status)) return res.status(400).json({ error: 'Invalid status' });
      const resolution = String(req.body.resolutionNote ?? current.resolution_note ?? '').trim();
      if (status === TICKET_STATUS.RESOLVED && !resolution) return res.status(400).json({ error: 'Resolution note is required' });
      const ticket = await SupportTicket.findOneAndUpdate(
        { ticket_id: req.params.ticketId },
        { $set: { status, assignee_username: String(req.body.assigneeUsername ?? current.assignee_username ?? '').trim() || null, internal_update: String(req.body.internalUpdate ?? current.internal_update ?? '').trim() || null, resolution_note: resolution || null, updated_at: new Date() } },
        { new: true, runValidators: true }
      ).lean();
      res.json({ ticket });
    } catch (error) { next(error); }
  });
  return router;
};
