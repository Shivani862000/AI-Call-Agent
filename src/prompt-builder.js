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
const supabase = require('../src/supabase');

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

async function getAgentConfigById(agentId) {
  if (!agentId) return null;
  const { data } = await supabase.from('agents').select('*').eq('id', agentId).eq('is_active', 1).single();
  return data;
}

async function getDefaultAgentConfig() {
  const { data } = await supabase.from('agents').select('*').eq('is_default', 1).eq('is_active', 1).order('id', { ascending: true }).limit(1);
  return data && data.length > 0 ? data[0] : null;
}

module.exports = {
  buildCallTypeSystemPrompt,
  buildCallTypeOpeningPrompt,
  buildAgentSystemPrompt,
  buildOpeningPrompt,
  getAgentConfigById,
  getDefaultAgentConfig
};
