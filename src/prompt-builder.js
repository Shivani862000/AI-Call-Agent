/**
 * src/prompt-builder.js
 * Call prompt assembly for system prompts, opening prompts, and agent configs.
 */

'use strict';


const { getGreeting } = require('../utils/greeting');
const { buildReviewCallingPrompt, buildReviewCallingOpeningPrompt } = require('../prompts/review-calling.ts');
const { buildThreeMonthFollowupPrompt, buildThreeMonthFollowupOpeningPrompt } = require('../prompts/three-month-followup.ts');
const { CALL_TYPES } = require('./config');
const { normalizeOutboundCallType, applyAgentTemplate } = require('./helpers');
const { dbGet } = require('../db');
const { activeRecordFilter } = require('./webmaster/lifecycle');

function buildCallTypeSystemPrompt(callType, clientName, customerName, extraOptions = {}) {
  const normalizedCallType = normalizeOutboundCallType(callType);
  const promptClientName = process.env.CALL_PROMPT_CLIENT_NAME || 'Apna Blood Centre';
  const greeting = getGreeting();
  if (normalizedCallType === CALL_TYPES.THREE_MONTH_FOLLOWUP) {
    return buildThreeMonthFollowupPrompt({
      clientName: promptClientName,
      donorName: customerName || 'Donor'
    }).replace(/\[GREETING\]/g, greeting);
  }

  return buildReviewCallingPrompt({
    clientName: promptClientName,
    videoSent: extraOptions.videoSent,
    lastVisitDate: extraOptions.lastVisitDate
  }).replace(/\[GREETING\]/g, greeting);
}

function buildCallTypeOpeningPrompt(callType, clientName, customerName, extraOptions = {}) {
  const normalizedCallType = normalizeOutboundCallType(callType);
  const promptClientName = process.env.CALL_PROMPT_CLIENT_NAME || 'Apna Blood Centre';
  const greeting = getGreeting();
  if (normalizedCallType === CALL_TYPES.THREE_MONTH_FOLLOWUP) {
    return buildThreeMonthFollowupOpeningPrompt({
      clientName: promptClientName,
      donorName: customerName || 'Donor',
      greeting
    });
  }

  return buildReviewCallingOpeningPrompt({
    clientName: promptClientName,
    greeting,
    lastVisitDate: extraOptions.lastVisitDate
  });
}

function buildAgentSystemPrompt(clientName, customerName, agentConfig = null, callType = CALL_TYPES.REVIEW_CALL, extraOptions = {}) {
  const normalizedCallType = normalizeOutboundCallType(callType);
  return buildCallTypeSystemPrompt(normalizedCallType, clientName, customerName, extraOptions);
}

function buildOpeningPrompt(clientName, customerName, agentConfig = null, callType = CALL_TYPES.REVIEW_CALL, extraOptions = {}) {
  const normalizedCallType = normalizeOutboundCallType(callType);
  return buildCallTypeOpeningPrompt(normalizedCallType, clientName, customerName, extraOptions);
}

function requireTenantId(tenantId) {
  if (!tenantId) throw new TypeError('A concrete authorized tenant is required for agent selection');
  return tenantId;
}

function normalizeRequestedAgentId(value) {
  return String(value || '').trim() || null;
}

function normalizeAgentRecord(record) {
  if (!record) return null;
  return { ...record, id: String(record._id) };
}

function createAgentConfigLookup({ AgentModel = null } = {}) {
  async function getAgentConfigById(agentId, tenantId) {
    requireTenantId(tenantId);
    const normalizedId = normalizeRequestedAgentId(agentId);
    if (!normalizedId || !mongoose.isValidObjectId(normalizedId)) return null;
    const record = await AgentModel.findOne(activeRecordFilter({
      _id: normalizedId,
      tenantId,
      is_active: true
    })).lean();
    return normalizeAgentRecord(record);
  }

  async function getDefaultAgentConfig(tenantId) {
    requireTenantId(tenantId);
    const record = await AgentModel.findOne(activeRecordFilter({
      tenantId,
      is_default: true,
      is_active: true
    })).sort({ _id: 1 }).lean();
    return normalizeAgentRecord(record);
  }

  return { getAgentConfigById, getDefaultAgentConfig };
}

const agentConfigLookup = createAgentConfigLookup();

module.exports = {
  buildCallTypeSystemPrompt,
  buildCallTypeOpeningPrompt,
  buildAgentSystemPrompt,
  buildOpeningPrompt,
  getAgentConfigById: agentConfigLookup.getAgentConfigById,
  getDefaultAgentConfig: agentConfigLookup.getDefaultAgentConfig,
  createAgentConfigLookup,
  normalizeRequestedAgentId
};
