'use strict';

const { WebmasterError } = require('./errors');

function problem(status, code, message) { return new WebmasterError({ status, code, message }); }
function escapeHtml(value) { return String(value || '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]); }

function safeDelivery(record) {
  const item = record && typeof record.toObject === 'function' ? record.toObject() : record;
  return { id: String(item?._id || item?.id || ''), tenantId: item?.tenantId ? String(item.tenantId) : null, accountId: item?.accountId ? String(item.accountId) : null, event: item?.event, template: item?.template, status: item?.status, retryCount: Number(item?.retryCount || 0), retryable: item?.status === 'failed', failureCode: item?.failureCode || null, createdAt: item?.created_at || null, updatedAt: item?.updated_at || null };
}
function createNotificationService({ mailer, DeliveryModel, UserModel, TenantModel, auditService, templateProvider = async ({ event, scope }) => ({ subject: `${scope === 'account' ? 'Account' : 'Tenant'} ${event}`, body: `Your ${scope === 'account' ? 'user' : 'organization'} account is now ${event}.` }) } = {}) {
  if (!mailer?.send || !DeliveryModel?.create) throw new TypeError('Mailer and DeliveryModel are required');
  async function deliver({ tenant, user, event, actor, retryCount = 0, scope = 'tenant', delivery = null, claimed = false }) {
    let template;
    try { template = await templateProvider({ event, scope, tenantId: String(tenant.id || tenant._id) }); }
    catch (_error) { template = { subject: `${scope === 'account' ? 'Account' : 'Tenant'} ${event}`, body: `Your ${scope === 'account' ? 'user' : 'organization'} account is now ${event}.` }; }
    const row = delivery || await DeliveryModel.create({ tenantId: tenant.id || tenant._id, accountId: user.id || user._id, recipientCategory: scope === 'account' ? 'account' : 'tenant_admin', template: `${scope}.${event}`, event, metadata: { tenantId: String(tenant.id || tenant._id) }, status: 'pending', retryCount, lastAttemptAt: new Date() });
    if (delivery && !claimed) { row.status = 'pending'; row.retryCount = retryCount; row.lastAttemptAt = new Date(); row.failureCode = null; row.failureReason = null; row.sentAt = null; await row.save(); }
    try {
      const result = await mailer.send({ to: user.email, subject: template.subject, html: `<p>${escapeHtml(template.body)}</p>`, tenantId: tenant.id || tenant._id });
      if (result?.delivered === false) throw new Error('DELIVERY_UNAVAILABLE');
      row.status = 'delivered'; row.sentAt = new Date(); row.failureCode = null;
    } catch (_error) { row.status = 'failed'; row.failureCode = 'DELIVERY_FAILED'; row.failureReason = 'Provider delivery failed'; }
    await row.save();
    await auditService?.record({ actor, action: `notification.${row.status}`, target: { type: 'notification', id: String(row._id) }, tenantId: String(tenant.id || tenant._id), outcome: row.status === 'delivered' ? 'success' : 'failure', failureCode: row.failureCode });
    return safeDelivery(row);
  }
  async function sendLifecycle({ tenant, users = [], event, actor, scope = 'tenant' }) { if (!['suspended', 'archived', 'restored'].includes(event)) throw new TypeError('Unsupported lifecycle event'); return Promise.all(users.filter(user => user?.email).map(user => deliver({ tenant, user, event, actor, scope }))); }
  async function retry(id, actor) {
    if (!UserModel || !TenantModel || typeof DeliveryModel.findOneAndUpdate !== 'function') throw problem(503, 'NOTIFICATION_RETRY_UNAVAILABLE', 'Notification retry is unavailable');
    const retained = await DeliveryModel.findOneAndUpdate(
      { _id: id, status: 'failed' },
      { $set: { status: 'pending', failureCode: null, failureReason: null, lastAttemptAt: new Date(), sentAt: null }, $inc: { retryCount: 1 } },
      { new: true, runValidators: true }
    ).exec();
    if (!retained) throw problem(404, 'NOTIFICATION_NOT_RETRYABLE', 'Failed notification was not found');
    const [tenant, user] = await Promise.all([TenantModel.findById(retained.tenantId).lean(), UserModel.findById(retained.accountId).lean()]);
    if (!tenant || !user?.email) throw problem(409, 'NOTIFICATION_RECIPIENT_UNAVAILABLE', 'Notification recipient is no longer available');
    const scope = retained.recipientCategory === 'account' ? 'account' : 'tenant';
    return deliver({ tenant, user, event: retained.event, actor, retryCount: Number(retained.retryCount || 0), scope, delivery: retained, claimed: true });
  }
  return { sendLifecycle, retry, safeDelivery };
}
module.exports = { createNotificationService, safeDelivery };
