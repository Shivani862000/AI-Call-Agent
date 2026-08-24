'use strict';

const crypto = require('crypto');
const mongoose = require('mongoose');
const Call = require('./models/Call');
const { activeRecordFilter } = require('./webmaster/lifecycle');
const { normalizePhoneLookupValue, normalizeOutboundCallType } = require('./helpers');

const PREPARED = 'prepared';
const PROVIDER_ACCEPTED = 'provider_accepted';
const PROVIDER_FAILED = 'provider_failed';
const ACTIVE_CONTEXT_STATES = [PREPARED, PROVIDER_ACCEPTED];
const configuredReferenceSecret = String(process.env.AUTH_SIGNING_SECRET || '').trim();

function requireObjectId(value, label) {
  if (!mongoose.isObjectIdOrHexString(value)) {
    throw new TypeError(`${label} must be a valid ObjectId`);
  }
  return String(value);
}

function requireLegacyCompatibleCustomerId(value) {
  if (value === null || value === undefined) {
    throw new TypeError('Customer is required for outbound call persistence');
  }
  const normalized = String(value).trim();
  if (!normalized || normalized.length > 256) {
    throw new TypeError('Customer identifier is invalid for outbound call persistence');
  }
  return normalized;
}

function deriveOpaqueReference(kind, tenantId, value) {
  const material = `outbound-call-context:v1\0${kind}\0${tenantId}\0${value}`;
  return configuredReferenceSecret
    ? crypto.createHmac('sha256', configuredReferenceSecret).update(material).digest('hex')
    : crypto.createHash('sha256').update(material).digest('hex');
}

function prepareCustomerReferences({ tenantId, customerId, customerPhone }) {
  const normalizedCustomerId = requireLegacyCompatibleCustomerId(customerId);
  const normalizedPhone = normalizePhoneLookupValue(customerPhone);
  if (!normalizedPhone) {
    throw new TypeError('Customer phone is required for outbound call context');
  }

  return {
    customerId: mongoose.isObjectIdOrHexString(customerId) ? String(customerId) : null,
    legacyCustomerRefHash: mongoose.isObjectIdOrHexString(customerId)
      ? null
      : deriveOpaqueReference('legacy-customer', tenantId, normalizedCustomerId),
    customerPhoneRefHash: deriveOpaqueReference('phone', tenantId, normalizedPhone)
  };
}

function normalizeSource(value) {
  const source = String(value || 'icallmate').trim();
  if (!source || source.length > 100) throw new TypeError('Outbound call source is invalid');
  return source;
}

function normalizeRecord(record) {
  if (!record) return null;
  return record.toObject ? record.toObject() : record;
}

function safeState(record) {
  const normalized = normalizeRecord(record);
  if (!normalized) return null;
  return {
    id: String(normalized._id),
    state: normalized.context_state || PREPARED
  };
}

function safeHydrationContext(record) {
  const normalized = normalizeRecord(record);
  if (!normalized) return null;
  return {
    call: {
      id: String(normalized._id),
      providerCallId: normalized.provider_call_id || '',
      callType: normalized.call_type,
      source: normalized.call_source || null,
      state: normalized.context_state || PREPARED
    }
  };
}

async function leanOne(query) {
  const result = query && typeof query.lean === 'function' ? await query.lean() : await query;
  return normalizeRecord(result);
}

function createOutboundCallContextRepository({ CallModel = Call, now = () => new Date() } = {}) {
  async function prepareInitiatedCall({
    tenantId,
    customerId,
    customerPhone,
    agentId = null,
    callType,
    source = 'icallmate'
  }) {
    const scopedTenantId = requireObjectId(tenantId, 'Authorized tenant');
    const scopedAgentId = agentId ? requireObjectId(agentId, 'Agent') : null;
    const references = prepareCustomerReferences({
      tenantId: scopedTenantId,
      customerId,
      customerPhone
    });
    const record = await CallModel.create({
      tenantId: scopedTenantId,
      customerId: references.customerId,
      legacy_customer_ref_hash: references.legacyCustomerRefHash,
      customer_phone_ref_hash: references.customerPhoneRefHash,
      agentId: scopedAgentId,
      provider_call_id: null,
      call_type: normalizeOutboundCallType(callType),
      call_direction: 'outbound',
      call_source: normalizeSource(source),
      context_state: PREPARED,
      status: 'queued',
      outcome: 'preparing',
      started_at: now()
    });
    return safeState(record);
  }

  async function readScopedContext({ tenantId, contextId }) {
    const scopedTenantId = requireObjectId(tenantId, 'Authorized tenant');
    const scopedContextId = requireObjectId(contextId, 'Call context');
    return leanOne(CallModel.findOne(activeRecordFilter({
      _id: scopedContextId,
      tenantId: scopedTenantId
    })));
  }

  async function markProviderAccepted({ tenantId, contextId, providerCallId }) {
    const providerId = String(providerCallId || '').trim();
    if (!providerId) throw new TypeError('Provider call identifier is required');
    const existing = await readScopedContext({ tenantId, contextId });
    if (!existing) throw new Error('Prepared outbound call context was not found');
    if (existing.context_state === PROVIDER_ACCEPTED) {
      if (existing.provider_call_id !== providerId) {
        throw new Error('Outbound call context is already bound to another provider call');
      }
      return safeState(existing);
    }
    if (existing.context_state !== PREPARED) {
      throw new Error('Outbound call context is not available for provider acceptance');
    }

    await CallModel.updateOne(
      activeRecordFilter({
        _id: existing._id,
        tenantId: existing.tenantId,
        context_state: PREPARED
      }),
      {
        $set: {
          provider_call_id: providerId,
          context_state: PROVIDER_ACCEPTED,
          outcome: 'initiated',
          status: 'queued'
        }
      },
      { runValidators: true }
    );
    const updated = await readScopedContext({ tenantId, contextId });
    if (!updated || updated.context_state !== PROVIDER_ACCEPTED || updated.provider_call_id !== providerId) {
      throw new Error('Outbound call context finalization did not persist');
    }
    return safeState(updated);
  }

  async function markProviderFailed({ tenantId, contextId }) {
    const existing = await readScopedContext({ tenantId, contextId });
    if (!existing || existing.context_state !== PREPARED) return safeState(existing);
    await CallModel.updateOne(
      activeRecordFilter({
        _id: existing._id,
        tenantId: existing.tenantId,
        context_state: PREPARED
      }),
      {
        $set: {
          context_state: PROVIDER_FAILED,
          outcome: 'provider_failed',
          status: 'failed'
        }
      },
      { runValidators: true }
    );
    return safeState(await readScopedContext({ tenantId, contextId }));
  }

  async function findRecentByPhone({ phone, tenantId, customerId }) {
    const scopedTenantId = requireObjectId(tenantId, 'Authorized tenant');
    if (customerId === null || customerId === undefined || String(customerId).trim() === '') return null;
    const references = prepareCustomerReferences({
      tenantId: scopedTenantId,
      customerId,
      customerPhone: phone
    });
    const customerReferenceFilter = references.customerId
      ? { customerId: references.customerId }
      : { legacy_customer_ref_hash: references.legacyCustomerRefHash };
    const query = CallModel.findOne(activeRecordFilter({
      tenantId: scopedTenantId,
      ...customerReferenceFilter,
      customer_phone_ref_hash: references.customerPhoneRefHash,
      context_state: { $in: ACTIVE_CONTEXT_STATES },
      call_direction: 'outbound',
      started_at: { $gte: new Date(now().getTime() - 30 * 60 * 1000) }
    }));
    const call = await leanOne(query && typeof query.sort === 'function' ? query.sort({ started_at: -1 }) : query);
    return safeHydrationContext(call);
  }

  return {
    prepareInitiatedCall,
    markProviderAccepted,
    markProviderFailed,
    findRecentByPhone
  };
}

function createOutboundCallContextCoordinator({ repository } = {}) {
  if (!repository) throw new TypeError('Outbound call context repository is required');

  async function initiate({ placeProviderCall, ...context }) {
    if (typeof placeProviderCall !== 'function') throw new TypeError('Provider call function is required');
    const prepared = await repository.prepareInitiatedCall(context);
    let providerCall;
    try {
      providerCall = await placeProviderCall();
    } catch (error) {
      try {
        await repository.markProviderFailed({
          tenantId: context.tenantId,
          contextId: prepared.id
        });
      } catch (_persistenceError) {
        // The durable prepared row is retained for operational diagnosis.
      }
      throw error;
    }

    try {
      const accepted = await repository.markProviderAccepted({
        tenantId: context.tenantId,
        contextId: prepared.id,
        providerCallId: providerCall?.sid
      });
      return {
        providerCall,
        context: accepted,
        persistence: { state: PROVIDER_ACCEPTED, retryable: false }
      };
    } catch (_error) {
      return {
        providerCall,
        context: prepared,
        persistence: { state: PREPARED, retryable: true }
      };
    }
  }

  return { initiate };
}

const outboundCallContextRepository = createOutboundCallContextRepository();
const outboundCallContextCoordinator = createOutboundCallContextCoordinator({
  repository: outboundCallContextRepository
});

module.exports = {
  createOutboundCallContextRepository,
  createOutboundCallContextCoordinator,
  outboundCallContextRepository,
  outboundCallContextCoordinator
};
