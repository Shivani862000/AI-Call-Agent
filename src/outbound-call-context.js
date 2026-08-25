'use strict';

const crypto = require('crypto');
const mongoose = require('mongoose');
const Call = require('./models/Call');
const { activeRecordFilter } = require('./webmaster/lifecycle');
const { normalizePhoneLookupValue, normalizeOutboundCallType } = require('./helpers');

const PREPARED = 'prepared';
const PROVIDER_ACCEPTANCE_PENDING = 'provider_acceptance_pending';
const PROVIDER_FAILURE_PENDING = 'provider_failure_pending';
const PROVIDER_ACCEPTED = 'provider_accepted';
const PROVIDER_FAILED = 'provider_failed';
const ACTIVE_CONTEXT_STATES = [PROVIDER_ACCEPTANCE_PENDING, PROVIDER_ACCEPTED];
const MAX_RECONCILIATION_ATTEMPTS = 3;
const DEFAULT_RECOVERY_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const configuredReferenceSecret = String(process.env.AUTH_SIGNING_SECRET || '').trim();
const developmentRecoverySecret = crypto.randomBytes(32);

class OutboundCallContextError extends Error {
  constructor(code, message, status = 409) {
    super(message);
    this.name = 'OutboundCallContextError';
    this.code = code;
    this.status = status;
  }
}

function normalizeDisposition(value) {
  const disposition = String(value || '').trim().toLowerCase();
  if (!['accepted', 'failed'].includes(disposition)) {
    throw new OutboundCallContextError(
      'OUTBOUND_CONTEXT_DISPOSITION_INVALID',
      'Outbound call disposition must be accepted or failed',
      400
    );
  }
  return disposition;
}

function statesForDisposition(disposition) {
  return disposition === 'accepted'
    ? { pending: PROVIDER_ACCEPTANCE_PENDING, terminal: PROVIDER_ACCEPTED }
    : { pending: PROVIDER_FAILURE_PENDING, terminal: PROVIDER_FAILED };
}

function requireProviderCallId(disposition, providerCallId) {
  const providerId = String(providerCallId || '').trim();
  if (disposition === 'accepted' && !providerId) {
    throw new OutboundCallContextError(
      'OUTBOUND_CONTEXT_PROVIDER_ID_REQUIRED',
      'Provider call identifier is required for accepted reconciliation',
      400
    );
  }
  return providerId;
}

function requireObjectId(value, label) {
  if (!mongoose.isObjectIdOrHexString(value)) {
    throw new OutboundCallContextError(
      'OUTBOUND_CONTEXT_ID_INVALID',
      `${label} must be a valid ObjectId`,
      400
    );
  }
  return String(value);
}

function recoveryTokenError(code = 'OUTBOUND_CONTEXT_RECOVERY_TOKEN_INVALID') {
  return new OutboundCallContextError(
    code,
    code === 'OUTBOUND_CONTEXT_RECOVERY_TOKEN_EXPIRED'
      ? 'Outbound call recovery evidence has expired'
      : 'Outbound call recovery evidence is invalid',
    400
  );
}

function createRecoveryTokenCodec({ secret, now, ttlMs }) {
  const secretMaterial = secret === undefined
    ? (configuredReferenceSecret || developmentRecoverySecret)
    : secret;
  const key = crypto.createHmac('sha256', secretMaterial)
    .update('outbound-call-recovery:v1')
    .digest();
  const aad = Buffer.from('outbound-call-recovery:v1', 'utf8');

  function issue({ tenantId, contextId, disposition, providerCallId = null }) {
    const scopedTenantId = requireObjectId(tenantId, 'Authorized tenant');
    const scopedContextId = requireObjectId(contextId, 'Call context');
    const normalizedDisposition = normalizeDisposition(disposition);
    const providerId = requireProviderCallId(normalizedDisposition, providerCallId);
    const issuedAt = now().getTime();
    const payload = Buffer.from(JSON.stringify({
      version: 1,
      tenantId: scopedTenantId,
      contextId: scopedContextId,
      disposition: normalizedDisposition,
      providerCallId: providerId || null,
      issuedAt,
      exp: issuedAt + ttlMs
    }), 'utf8');
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(aad);
    const ciphertext = Buffer.concat([cipher.update(payload), cipher.final()]);
    return `v1.${iv.toString('base64url')}.${ciphertext.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}`;
  }

  function verify(token) {
    try {
      const parts = String(token || '').split('.');
      if (parts.length !== 4 || parts[0] !== 'v1') throw recoveryTokenError();
      const iv = Buffer.from(parts[1], 'base64url');
      const ciphertext = Buffer.from(parts[2], 'base64url');
      const authTag = Buffer.from(parts[3], 'base64url');
      if (iv.length !== 12 || !ciphertext.length || authTag.length !== 16) throw recoveryTokenError();
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAAD(aad);
      decipher.setAuthTag(authTag);
      const evidence = JSON.parse(Buffer.concat([
        decipher.update(ciphertext),
        decipher.final()
      ]).toString('utf8'));
      const scopedTenantId = requireObjectId(evidence?.tenantId, 'Authorized tenant');
      const scopedContextId = requireObjectId(evidence?.contextId, 'Call context');
      const disposition = normalizeDisposition(evidence?.disposition);
      const providerCallId = requireProviderCallId(disposition, evidence?.providerCallId);
      const issuedAt = Number(evidence?.issuedAt);
      const expiresAt = Number(evidence?.exp);
      const currentTime = now().getTime();
      if (
        evidence?.version !== 1
        || !Number.isFinite(issuedAt)
        || !Number.isFinite(expiresAt)
        || expiresAt <= issuedAt
        || expiresAt - issuedAt !== ttlMs
        || issuedAt > currentTime + 60_000
      ) {
        throw recoveryTokenError();
      }
      if (expiresAt <= currentTime) {
        throw recoveryTokenError('OUTBOUND_CONTEXT_RECOVERY_TOKEN_EXPIRED');
      }
      return {
        tenantId: scopedTenantId,
        contextId: scopedContextId,
        disposition,
        providerCallId
      };
    } catch (error) {
      if (
        error instanceof OutboundCallContextError
        && error.code === 'OUTBOUND_CONTEXT_RECOVERY_TOKEN_EXPIRED'
      ) {
        throw error;
      }
      throw recoveryTokenError();
    }
  }

  return { issue, verify };
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

  function assertCompatibleProviderId(record, disposition, providerId) {
    if (
      disposition === 'accepted'
      && record.provider_call_id
      && record.provider_call_id !== providerId
    ) {
      throw new OutboundCallContextError(
        'OUTBOUND_CONTEXT_PROVIDER_CONFLICT',
        'Outbound call context is already bound to another provider call'
      );
    }
  }

  async function reconcileProviderOutcome({ tenantId, contextId, disposition, providerCallId = null }) {
    const normalizedDisposition = normalizeDisposition(disposition);
    const providerId = requireProviderCallId(normalizedDisposition, providerCallId);
    const states = statesForDisposition(normalizedDisposition);
    const existing = await readScopedContext({ tenantId, contextId });
    if (!existing) {
      throw new OutboundCallContextError(
        'OUTBOUND_CONTEXT_NOT_FOUND',
        'Outbound call context was not found for the authorized tenant',
        404
      );
    }
    assertCompatibleProviderId(existing, normalizedDisposition, providerId);

    if (existing.context_state === states.terminal) {
      return safeState(existing);
    }
    if (![PREPARED, states.pending].includes(existing.context_state)) {
      throw new OutboundCallContextError(
        'OUTBOUND_CONTEXT_STATE_CONFLICT',
        'Outbound call context has a conflicting provider disposition'
      );
    }

    let staged = existing;
    if (existing.context_state === PREPARED) {
      await CallModel.updateOne(
        activeRecordFilter({
          _id: existing._id,
          tenantId: existing.tenantId,
          context_state: PREPARED
        }),
        {
          $set: {
            provider_call_id: normalizedDisposition === 'accepted' ? providerId : null,
            context_state: states.pending,
            outcome: states.pending,
            status: normalizedDisposition === 'accepted' ? 'queued' : 'failed'
          }
        },
        { runValidators: true }
      );
      staged = await readScopedContext({ tenantId, contextId });
      if (!staged) {
        throw new OutboundCallContextError(
          'OUTBOUND_CONTEXT_NOT_FOUND',
          'Outbound call context was not found for the authorized tenant',
          404
        );
      }
      assertCompatibleProviderId(staged, normalizedDisposition, providerId);
      if (staged.context_state === states.terminal) return safeState(staged);
      if (staged.context_state !== states.pending) {
        throw new OutboundCallContextError(
          'OUTBOUND_CONTEXT_PERSISTENCE_UNAVAILABLE',
          'Outbound call context outcome staging did not persist',
          503
        );
      }
    }

    await CallModel.updateOne(
      activeRecordFilter({
        _id: staged._id,
        tenantId: staged.tenantId,
        context_state: states.pending,
        ...(normalizedDisposition === 'accepted' ? { provider_call_id: providerId } : {})
      }),
      {
        $set: {
          context_state: states.terminal,
          outcome: normalizedDisposition === 'accepted' ? 'initiated' : 'provider_failed',
          status: normalizedDisposition === 'accepted' ? 'queued' : 'failed'
        }
      },
      { runValidators: true }
    );
    const finalized = await readScopedContext({ tenantId, contextId });
    if (!finalized) {
      throw new OutboundCallContextError(
        'OUTBOUND_CONTEXT_NOT_FOUND',
        'Outbound call context was not found for the authorized tenant',
        404
      );
    }
    assertCompatibleProviderId(finalized, normalizedDisposition, providerId);
    if (finalized.context_state !== states.terminal) {
      throw new OutboundCallContextError(
        'OUTBOUND_CONTEXT_PERSISTENCE_UNAVAILABLE',
        'Outbound call context finalization did not persist',
        503
      );
    }
    return safeState(finalized);
  }

  async function markProviderAccepted({ tenantId, contextId, providerCallId }) {
    return reconcileProviderOutcome({
      tenantId,
      contextId,
      disposition: 'accepted',
      providerCallId
    });
  }

  async function markProviderFailed({ tenantId, contextId }) {
    return reconcileProviderOutcome({
      tenantId,
      contextId,
      disposition: 'failed'
    });
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
    readState: async ({ tenantId, contextId }) => safeState(await readScopedContext({ tenantId, contextId })),
    reconcileProviderOutcome,
    markProviderAccepted,
    markProviderFailed,
    findRecentByPhone
  };
}

function createOutboundCallContextCoordinator({
  repository,
  recoveryTokenSecret,
  recoveryTokenTtlMs = DEFAULT_RECOVERY_TOKEN_TTL_MS,
  now = () => new Date()
} = {}) {
  if (!repository) throw new TypeError('Outbound call context repository is required');
  if (!Number.isSafeInteger(recoveryTokenTtlMs) || recoveryTokenTtlMs <= 0) {
    throw new TypeError('Outbound call recovery token TTL must be a positive integer');
  }
  const recoveryTokens = createRecoveryTokenCodec({
    secret: recoveryTokenSecret,
    now,
    ttlMs: recoveryTokenTtlMs
  });

  async function currentState({ tenantId, contextId }, fallback) {
    try {
      return await repository.readState({ tenantId, contextId }) || fallback;
    } catch (_error) {
      return fallback;
    }
  }

  async function reconcileAttestedOutcome({ tenantId, contextId, disposition, providerCallId = null }) {
    let lastError;

    for (let attempt = 0; attempt < MAX_RECONCILIATION_ATTEMPTS; attempt += 1) {
      try {
        const context = await repository.reconcileProviderOutcome({
          tenantId,
          contextId,
          disposition,
          providerCallId
        });
        return {
          context,
          persistence: { state: context.state, retryable: false }
        };
      } catch (error) {
        lastError = error;
        if (
          error instanceof OutboundCallContextError
          && error.code !== 'OUTBOUND_CONTEXT_PERSISTENCE_UNAVAILABLE'
        ) {
          throw error;
        }
      }
    }

    const context = await currentState(
      { tenantId, contextId },
      { id: String(contextId), state: PREPARED }
    );
    if ([PROVIDER_ACCEPTED, PROVIDER_FAILED].includes(context.state)) {
      return {
        context,
        persistence: { state: context.state, retryable: false }
      };
    }
    return {
      context,
      persistence: { state: context.state, retryable: true },
      errorCode: 'OUTBOUND_CONTEXT_PERSISTENCE_UNAVAILABLE'
    };
  }

  async function reconcile({ tenantId, contextId, recoveryToken }) {
    const scopedTenantId = requireObjectId(tenantId, 'Authorized tenant');
    const scopedContextId = requireObjectId(contextId, 'Call context');
    const evidence = recoveryTokens.verify(recoveryToken);
    if (evidence.tenantId !== scopedTenantId || evidence.contextId !== scopedContextId) {
      throw new OutboundCallContextError(
        'OUTBOUND_CONTEXT_NOT_FOUND',
        'Outbound call context was not found for the authorized tenant',
        404
      );
    }
    return reconcileAttestedOutcome(evidence);
  }

  async function initiate({ placeProviderCall, ...context }) {
    if (typeof placeProviderCall !== 'function') throw new TypeError('Provider call function is required');
    const prepared = await repository.prepareInitiatedCall(context);
    let providerCall;
    try {
      providerCall = await placeProviderCall();
    } catch (error) {
      const evidence = {
        tenantId: context.tenantId,
        contextId: prepared.id,
        disposition: 'failed',
        providerCallId: null
      };
      const recoveryToken = recoveryTokens.issue(evidence);
      try {
        error.outboundCallContext = {
          ...await reconcileAttestedOutcome(evidence),
          recoveryToken
        };
      } catch (_reconciliationError) {
        error.outboundCallContext = {
          context: await currentState(
            { tenantId: context.tenantId, contextId: prepared.id },
            prepared
          ),
          persistence: { state: PREPARED, retryable: true },
          recoveryToken
        };
      }
      throw error;
    }

    const evidence = {
      tenantId: context.tenantId,
      contextId: prepared.id,
      disposition: 'accepted',
      providerCallId: providerCall?.sid
    };
    const recoveryToken = recoveryTokens.issue(evidence);
    let reconciled;
    try {
      reconciled = await reconcileAttestedOutcome(evidence);
    } catch (error) {
      const contextState = await currentState(
        { tenantId: context.tenantId, contextId: prepared.id },
        prepared
      );
      const typedConflict = error instanceof OutboundCallContextError;
      reconciled = {
        context: contextState,
        persistence: {
          state: contextState.state,
          retryable: !typedConflict
        },
        errorCode: typedConflict
          ? error.code
          : 'OUTBOUND_CONTEXT_PERSISTENCE_UNAVAILABLE'
      };
    }
    return { providerCall, ...reconciled, recoveryToken };
  }

  return { initiate, reconcile };
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
