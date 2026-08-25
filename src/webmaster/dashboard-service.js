'use strict';

function createDashboardService({ TenantModel, UserModel, CallModel, NotificationModel, integrationStatus = async () => [], recentAudit = async () => [] } = {}) {
  if (!TenantModel || !UserModel) throw new TypeError('TenantModel and UserModel are required');
  async function lifecycleCounts(Model, base = {}) { const [active, suspended, archived] = await Promise.all(['active', 'suspended', 'archived'].map(status => Model.countDocuments({ ...base, status }))); return { active, suspended, archived }; }
  async function get() {
    const [tenants, users, calls, failedCalls, failedDeliveries, integrations, audit] = await Promise.all([
      lifecycleCounts(TenantModel), lifecycleCounts(UserModel), CallModel?.countDocuments({ status: { $ne: 'archived' } }) || 0,
      CallModel?.countDocuments({ status: 'failed' }) || 0, NotificationModel?.countDocuments({ status: 'failed' }) || 0,
      integrationStatus(), recentAudit(8)
    ]);
    const attentionItems = [];
    if (failedDeliveries) attentionItems.push({ code: 'FAILED_NOTIFICATIONS', count: failedDeliveries, label: 'Notification deliveries need attention' });
    const unconfigured = integrations.filter(item => !item.configured).length;
    if (unconfigured) attentionItems.push({ code: 'UNCONFIGURED_INTEGRATIONS', count: unconfigured, label: 'Integrations need configuration' });
    return { tenants, users, usage: { calls, failedCalls }, health: { status: failedCalls ? 'attention' : 'healthy' }, integrations, recentAudit: audit, attentionItems };
  }
  return { get };
}
module.exports = { createDashboardService };
