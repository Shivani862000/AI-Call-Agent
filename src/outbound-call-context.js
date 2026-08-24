'use strict';

const Call = require('./models/Call');
const Customer = require('./models/Customer');
const { activeRecordFilter } = require('./webmaster/lifecycle');
const { normalizePhoneLookupValue, normalizeOutboundCallType } = require('./helpers');

function requireTenantId(tenantId) {
  if (!tenantId) throw new TypeError('A concrete authorized tenant is required for outbound call context');
  return tenantId;
}

function normalizeRecord(record) {
  if (!record) return null;
  return { ...record, id: String(record._id) };
}

function createOutboundCallContextRepository({ CallModel = Call, CustomerModel = Customer, now = () => new Date() } = {}) {
  async function persistInitiatedCall({
    tenantId,
    customerId,
    agentId = null,
    providerCallId,
    callType,
    clientName = null,
    source = 'icallmate',
    providerPayload = null
  }) {
    requireTenantId(tenantId);
    if (!customerId) throw new TypeError('Customer is required for outbound call persistence');
    const record = await CallModel.create({
      tenantId,
      customerId,
      agentId: agentId || null,
      provider_call_id: providerCallId || null,
      call_type: normalizeOutboundCallType(callType),
      call_direction: 'outbound',
      call_source: source,
      client_name: clientName,
      provider_payload_json: providerPayload,
      status: 'queued',
      outcome: 'initiated',
      started_at: now()
    });
    return normalizeRecord(record.toObject ? record.toObject() : record);
  }

  async function findRecentByPhone({ phone, tenantId }) {
    requireTenantId(tenantId);
    const normalizedPhone = normalizePhoneLookupValue(phone);
    if (!normalizedPhone) return null;
    const customers = await CustomerModel.find(activeRecordFilter({ tenantId })).limit(200).lean();
    const customer = customers.find((candidate) => normalizePhoneLookupValue(candidate.phone) === normalizedPhone);
    if (!customer) return null;
    const call = await CallModel.findOne(activeRecordFilter({
      tenantId,
      customerId: customer._id,
      call_direction: 'outbound',
      started_at: { $gte: new Date(now().getTime() - 30 * 60 * 1000) }
    })).sort({ started_at: -1 }).lean();
    if (!call) return null;
    return { customer: normalizeRecord(customer), call: normalizeRecord(call) };
  }

  return { persistInitiatedCall, findRecentByPhone };
}

const outboundCallContextRepository = createOutboundCallContextRepository();

module.exports = { createOutboundCallContextRepository, outboundCallContextRepository };
