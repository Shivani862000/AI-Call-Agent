'use strict';

const express = require('express');
const { TICKET_STATUS, createTicketId, validateSubmission } = require('../src/support-ticket');
const supabase = require('../src/supabase');

function createSupportTicketsRouter() {
  const router = express.Router();

  router.post('/', async (req, res, next) => {
    try {
      const payload = validateSubmission(req.body);
      const session = req.adminSession;
      
      // Simulate auto-incrementing sequence safely since Supabase sequence doesn't return value easily without RPC
      // Wait, Postgres sequences can be used using DEFAULT, but we need the ticket_id which depends on the sequence!
      // Let's just generate a UUID-based ticket ID or query the max sequence.
      // Since this is a simple adaptation, we can generate a random ID or fetch max sequence.
      const { data: maxTicket } = await supabase.from('support_tickets').select('sequence').order('sequence', { ascending: false }).limit(1).single();
      const nextSequence = (maxTicket?.sequence || 1000) + 1;
      const ticketId = createTicketId(payload.type, nextSequence);

      const ticketData = {
        ticket_id: ticketId,
        sequence: nextSequence,
        tenant_id: req.tenantId ? String(req.tenantId) : null,
        type: payload.type,
        description: payload.description,
        status: TICKET_STATUS.NEW,
        reporter_username: session?.username || 'anonymous',
        reporter_role: session?.role || 'GUEST',
        page_url: payload.context?.pageUrl || '',
        page_title: payload.context?.pageTitle || '',
        context_json: payload.context || {}
      };

      const { data: ticket, error } = await supabase.from('support_tickets').insert([ticketData]).select('*').single();
      
      if (error) {
        console.error('Support ticket creation error:', error);
        return res.status(500).json({ error: error.message });
      }

      res.status(201).json({ ticket });
    } catch (error) { 
      next(error); 
    }
  });

  router.get('/', async (req, res, next) => { 
    try { 
      const { data: tickets, error } = await supabase.from('support_tickets').select('*').order('updated_at', { ascending: false });
      if (error) throw error;
      res.json({ tickets }); 
    } catch (error) { 
      next(error); 
    } 
  });

  router.get('/:ticketId', async (req, res, next) => { 
    try { 
      const { data: ticket, error } = await supabase.from('support_tickets').select('*').eq('ticket_id', req.params.ticketId).single();
      if (error && error.code !== 'PGRST116') throw error;
      if (!ticket) return res.status(404).json({ error: 'Ticket not found' }); 
      res.json({ ticket }); 
    } catch (error) { 
      next(error); 
    } 
  });

  router.patch('/:ticketId', async (req, res, next) => {
    try {
      const { data: current, error: fetchError } = await supabase.from('support_tickets').select('*').eq('ticket_id', req.params.ticketId).single();
      if (fetchError && fetchError.code !== 'PGRST116') throw fetchError;
      if (!current) return res.status(404).json({ error: 'Ticket not found' });

      const status = req.body.status || current.status;
      if (!Object.values(TICKET_STATUS).includes(status)) return res.status(400).json({ error: 'Invalid status' });

      const resolution = String(req.body.resolutionNote ?? current.resolution_note ?? '').trim();
      if (status === TICKET_STATUS.RESOLVED && !resolution) return res.status(400).json({ error: 'Resolution note is required' });

      const updates = { 
        status, 
        assignee_username: String(req.body.assigneeUsername ?? current.assignee_username ?? '').trim() || null, 
        internal_update: String(req.body.internalUpdate ?? current.internal_update ?? '').trim() || null, 
        resolution_note: resolution || null, 
        updated_at: new Date().toISOString() 
      };

      const { data: ticket, error: updateError } = await supabase.from('support_tickets').update(updates).eq('ticket_id', req.params.ticketId).select('*').single();
      
      if (updateError) throw updateError;
      res.json({ ticket });
    } catch (error) { 
      next(error); 
    }
  });

  return router;
}

module.exports = createSupportTicketsRouter;
