'use strict';

function createDashboardService({ supabase, integrationStatus = async () => [], recentAudit = async () => [] } = {}) {
  if (!supabase) throw new TypeError('supabase client is required');
  
  async function lifecycleCounts(table) { 
    const [active, suspended, archived] = await Promise.all(['active', 'suspended', 'archived'].map(async status => {
      const { count } = await supabase.from(table).select('*', { count: 'exact', head: true }).eq('status', status);
      return count || 0;
    })); 
    return { active, suspended, archived }; 
  }
  
  async function get() {
    const [tenants, users] = await Promise.all([
      lifecycleCounts('tenants'), 
      lifecycleCounts('users')
    ]);

    const { count: calls } = await supabase.from('calls').select('*', { count: 'exact', head: true });
    const { count: failedCalls } = await supabase.from('calls').select('*', { count: 'exact', head: true }).eq('outcome', 'failed');
    
    const failedDeliveries = 0; // Notification deliveries not yet migrated to Supabase
    
    const [integrations, audit] = await Promise.all([
      integrationStatus(), recentAudit(8)
    ]);
    
    const attentionItems = [];
    if (failedDeliveries) attentionItems.push({ code: 'FAILED_NOTIFICATIONS', count: failedDeliveries, label: 'Notification deliveries need attention' });
    const unconfigured = integrations.filter(item => !item.configured).length;
    if (unconfigured) attentionItems.push({ code: 'UNCONFIGURED_INTEGRATIONS', count: unconfigured, label: 'Integrations need configuration' });
    
    return { tenants, users, usage: { calls: calls || 0, failedCalls: failedCalls || 0 }, health: { status: failedCalls ? 'attention' : 'healthy' }, integrations, recentAudit: audit, attentionItems };
  }
  return { get };
}
module.exports = { createDashboardService };
