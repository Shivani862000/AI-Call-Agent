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

function buildCallTypeSystemPrompt(callType, clientName, customerName) {
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
    clientName: promptClientName
  }).replace(/\[GREETING\]/g, greeting);
}

function buildCallTypeOpeningPrompt(callType, clientName, customerName) {
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
    greeting
  });
}

function buildAgentSystemPrompt(clientName, customerName, agentConfig = null, callType = CALL_TYPES.REVIEW_CALL) {
  const normalizedCallType = normalizeOutboundCallType(callType);
  return buildCallTypeSystemPrompt(normalizedCallType, clientName, customerName);
}

function buildOpeningPrompt(clientName, customerName, agentConfig = null, callType = CALL_TYPES.REVIEW_CALL) {
  const normalizedCallType = normalizeOutboundCallType(callType);
  return buildCallTypeOpeningPrompt(normalizedCallType, clientName, customerName);
}

async function getAgentConfigById(agentId) {
  if (!agentId) return null;
  return dbGet('SELECT * FROM agents WHERE id = ? AND is_active = 1', [agentId]);
}

async function getDefaultAgentConfig() {
  return dbGet('SELECT * FROM agents WHERE is_default = 1 AND is_active = 1 ORDER BY id ASC LIMIT 1');
}

module.exports = {
  buildCallTypeSystemPrompt,
  buildCallTypeOpeningPrompt,
  buildAgentSystemPrompt,
  buildOpeningPrompt,
  getAgentConfigById,
  getDefaultAgentConfig
};
