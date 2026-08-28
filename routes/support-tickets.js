'use strict';
const express = require('express');
const { TICKET_STATUS, createTicketId, validateSubmission } = require('../src/support-ticket');
const { supabase } = require('../src/supabase');

module.exports = function createSupportTicketsRouter({ notifyNewTicket } = {}) {
  const router = express.Router();
  router.post('/', async (req, res, next) => {
    try {
      const payload = validateSubmission(req.body);
      const session = req.adminSession;
      
      let ticket;
      let retries = 5;
      while (retries > 0) {
        try {
          const { data: maxSeqData } = await supabase.from('support_tickets').select('sequence').order('sequence', { ascending: false }).limit(1);
          const maxSeq = maxSeqData && maxSeqData.length > 0 ? maxSeqData[0].sequence : 0;
          const newSeq = Math.max(maxSeq, 1000) + 1; // start from 1001 like the original

          const insertData = {
            ticket_id: createTicketId(payload.type, newSeq),
            sequence: newSeq,
            tenant_id: req.tenantId ? String(req.tenantId) : null,
            type: payload.type,
            description: payload.description,
            status: TICKET_STATUS.NEW,
            reporter_username: session.username,
            reporter_role: session.role,
            page_url: payload.context.pageUrl,
            page_title: payload.context.pageTitle,
            context_json: payload.context
          };

          const { data, error } = await supabase.from('support_tickets').insert([insertData]).select().single();
          if (error) {
             if (error.code === '23505') { // unique violation
                 retries--;
                 continue;
             }
             throw error;
          }
          ticket = data;
          break; // success
        } catch (error) {
          retries--;
          if (retries === 0) throw error;
        }
      }
      
      const admin_url = `${payload.context.pageUrl.replace(/\/[^/]*$/, '')}/support-tickets.html?ticket=${encodeURIComponent(ticket.ticket_id)}`;
      notifyNewTicket?.({ ...ticket, admin_url }).catch(() => {});
      res.status(201).json({ ticket });
    } catch (error) { next(error); }
  });
  
  router.get('/', async (_req, res, next) => { 
    try { 
      const { data, error } = await supabase.from('support_tickets').select('*').order('updated_at', { ascending: false });
      if (error) throw error;
      res.json({ tickets: data || [] }); 
    } catch (error) { next(error); } 
  });
  
  router.get('/:ticketId', async (req, res, next) => { 
    try { 
      const { data: ticket, error } = await supabase.from('support_tickets').select('*').eq('ticket_id', req.params.ticketId).maybeSingle();
      if (error) throw error;
      if (!ticket) return res.status(404).json({ error: 'Ticket not found' }); 
      res.json({ ticket }); 
    } catch (error) { next(error); } 
  });
  
  router.patch('/:ticketId', async (req, res, next) => {
    try {
      const { data: current, error: findError } = await supabase.from('support_tickets').select('*').eq('ticket_id', req.params.ticketId).maybeSingle();
      if (findError) throw findError;
      if (!current) return res.status(404).json({ error: 'Ticket not found' });
      
      const status = req.body.status || current.status;
      if (!Object.values(TICKET_STATUS).includes(status)) return res.status(400).json({ error: 'Invalid status' });
      
      const resolution = String(req.body.resolutionNote ?? current.resolution_note ?? '').trim();
      if (status === TICKET_STATUS.RESOLVED && !resolution) return res.status(400).json({ error: 'Resolution note is required' });
      
      const updatePayload = {
        status, 
        assignee_username: String(req.body.assigneeUsername ?? current.assignee_username ?? '').trim() || null, 
        internal_update: String(req.body.internalUpdate ?? current.internal_update ?? '').trim() || null, 
        resolution_note: resolution || null
      };

      const { data: ticket, error: updateError } = await supabase.from('support_tickets').update(updatePayload).eq('ticket_id', req.params.ticketId).select().single();
      if (updateError) throw updateError;
      
      res.json({ ticket });
    } catch (error) { next(error); }
  });
  return router;
};
