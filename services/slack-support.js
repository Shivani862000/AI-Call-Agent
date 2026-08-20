'use strict';

function createSlackSupportNotifier({ webhookUrl = '', fetchImpl = global.fetch, logger = console } = {}) {
  return async function notifyNewTicket(ticket) {
    if (!webhookUrl || typeof fetchImpl !== 'function') return { delivered: false, skipped: true };
    const text = [`New support ticket ${ticket.ticket_id}`, `${ticket.type}: ${ticket.description}`, `Reporter role: ${ticket.reporter_role}`, `Page: ${ticket.page_url}`, `Admin: ${ticket.admin_url}`].join('\n');
    try {
      const response = await fetchImpl(webhookUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
      if (!response.ok) throw new Error(`Slack returned ${response.status}`);
      return { delivered: true };
    } catch (error) { logger.warn?.('[SUPPORT_TICKET_SLACK_DELIVERY_FAILED]', { ticketId: ticket.ticket_id, message: error.message }); return { delivered: false }; }
  };
}
module.exports = { createSlackSupportNotifier };
