/**
 * src/prompt-builder.js
 * Call prompt assembly for system prompts, opening prompts, and agent configs.
 */

'use strict';

const { getGreeting } = require('../utils/greeting');
const {
  buildReviewCallingPrompt,
  buildReviewCallingOpeningPrompt,
  describeVisit,
  describeEligibility
} = require('../prompts/review-calling.ts');
const { buildThreeMonthFollowupPrompt, buildThreeMonthFollowupOpeningPrompt } = require('../prompts/three-month-followup.ts');
const { CALL_TYPES } = require('./config');
const { normalizeOutboundCallType, applyAgentTemplate } = require('./helpers');
const { dbGet } = require('../db');

/**
 * The placeholders an admin can use in an agent's saved prompt.
 *
 * Written as {{client_name}}, {{patient_name}} and so on; anything unknown
 * resolves to an empty string rather than being left visible to the donor.
 */
function agentTemplateValues({ clientName, customerName, greeting, lastVisitDate }) {
  return {
    client_name: clientName,
    patient_name: String(customerName || '').trim(),
    greeting,
    last_visit: describeVisit(lastVisitDate),
    next_eligible: describeEligibility(lastVisitDate)
  };
}

/**
 * An agent row's saved prompt, or '' when it has none.
 *
 * The agents table has carried system_prompt and opening_prompt since the
 * first migration and the Agents screen lets an admin edit them, but nothing
 * ever read them: agentConfig was accepted here and dropped. The screen
 * appeared to configure calls while every call used the built-in script.
 *
 * A saved prompt replaces the built-in one entirely, including its rules about
 * disclosure and not inventing facts, so whoever writes one owns those.
 */
function agentPromptOverride(agentConfig, field, values) {
  const template = agentConfig && String(agentConfig[field] || '').trim();
  if (!template) return '';
  return applyAgentTemplate(template, values).replace(/\[GREETING\]/g, values.greeting);
}

function buildCallTypeSystemPrompt(callType, clientName, customerName, extraOptions = {}, agentConfig = null) {
  const normalizedCallType = normalizeOutboundCallType(callType);
  const promptClientName = process.env.CALL_PROMPT_CLIENT_NAME || 'Apna Blood Centre';
  const greeting = getGreeting();

  const override = agentPromptOverride(agentConfig, 'system_prompt', agentTemplateValues({
    clientName: promptClientName, customerName, greeting, lastVisitDate: extraOptions.lastVisitDate
  }));
  if (override) return override;

  if (normalizedCallType === CALL_TYPES.THREE_MONTH_FOLLOWUP) {
    return buildThreeMonthFollowupPrompt({
      clientName: promptClientName,
      donorName: customerName || 'Donor'
    }).replace(/\[GREETING\]/g, greeting);
  }

  return buildReviewCallingPrompt({
    clientName: promptClientName,
    patientName: customerName,
    lastVisitDate: extraOptions.lastVisitDate
  }).replace(/\[GREETING\]/g, greeting);
}

function buildCallTypeOpeningPrompt(callType, clientName, customerName, extraOptions = {}, agentConfig = null) {
  const normalizedCallType = normalizeOutboundCallType(callType);
  const promptClientName = process.env.CALL_PROMPT_CLIENT_NAME || 'Apna Blood Centre';
  const greeting = getGreeting();

  const override = agentPromptOverride(agentConfig, 'opening_prompt', agentTemplateValues({
    clientName: promptClientName, customerName, greeting, lastVisitDate: extraOptions.lastVisitDate
  }));
  if (override) return override;

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
    patientName: customerName,
    lastVisitDate: extraOptions.lastVisitDate
  });
}

function buildAgentSystemPrompt(clientName, customerName, agentConfig = null, callType = CALL_TYPES.REVIEW_CALL, extraOptions = {}) {
  const normalizedCallType = normalizeOutboundCallType(callType);
  return buildCallTypeSystemPrompt(normalizedCallType, clientName, customerName, extraOptions, agentConfig);
}

function buildOpeningPrompt(clientName, customerName, agentConfig = null, callType = CALL_TYPES.REVIEW_CALL, extraOptions = {}) {
  const normalizedCallType = normalizeOutboundCallType(callType);
  return buildCallTypeOpeningPrompt(normalizedCallType, clientName, customerName, extraOptions, agentConfig);
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
