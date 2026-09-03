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
const { withSafetyRules } = require('../prompts/safety-rules.ts');
const { normalizeOutboundCallType, applyAgentTemplate } = require('./helpers');
const { dbGet } = require('../db');

/**
 * The placeholders an admin can use in an agent's saved prompt.
 *
 * Written as {{client_name}}, {{patient_name}} and so on; anything unknown
 * resolves to an empty string rather than being left visible to the donor.
 */
/**
 * The city named in the follow-up call's opening. It was hardcoded as "Palwal"
 * in a line that otherwise used the client name, so a second client would have
 * announced the wrong city. Set CALL_PROMPT_CLIENT_CITY to '' to drop it.
 */
function promptClientCity() {
  return process.env.CALL_PROMPT_CLIENT_CITY === undefined
    ? 'Palwal'
    : process.env.CALL_PROMPT_CLIENT_CITY;
}

function agentTemplateValues({ clientName, customerName, greeting, lastVisitDate }) {
  return {
    client_name: clientName,
    client_city: promptClientCity(),
    patient_name: String(customerName || '').trim(),
    greeting,
    last_visit: describeVisit(lastVisitDate),
    next_eligible: describeEligibility(lastVisitDate)
  };
}

/**
 * A script written on the settings screen, or '' when none is set.
 *
 * The safety rules are appended to the system prompt rather than left to the
 * author: an edit that dropped the automated-call disclosure or the identity
 * check would otherwise go out on a live health call. The opening line gets no
 * rules -- it is a single spoken sentence, not instructions.
 */
function customScript(scripts, callType, field, values) {
  const key = callType === CALL_TYPES.THREE_MONTH_FOLLOWUP ? 'three_month_followup' : 'review_call';
  const template = scripts && scripts[key] && String(scripts[key][field] || '').trim();
  if (!template) return '';

  const filled = applyAgentTemplate(template, values).replace(/\[GREETING\]/g, values.greeting);
  return field === 'system_prompt' ? withSafetyRules(filled) : filled;
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
  const filled = applyAgentTemplate(template, values).replace(/\[GREETING\]/g, values.greeting);
  return field === 'system_prompt' ? withSafetyRules(filled) : filled;
}

function buildCallTypeSystemPrompt(callType, clientName, customerName, extraOptions = {}, agentConfig = null) {
  const normalizedCallType = normalizeOutboundCallType(callType);
  const promptClientName = process.env.CALL_PROMPT_CLIENT_NAME || 'Apna Blood Centre';
  const greeting = getGreeting();

  const values = agentTemplateValues({
    clientName: promptClientName, customerName, greeting, lastVisitDate: extraOptions.lastVisitDate
  });

  // The settings screen wins over an agent row: it is the one an admin edits.
  const fromSettings = customScript(extraOptions.callScripts, normalizedCallType, 'system_prompt', values);
  if (fromSettings) return fromSettings;

  const override = agentPromptOverride(agentConfig, 'system_prompt', values);
  if (override) return override;

  if (normalizedCallType === CALL_TYPES.THREE_MONTH_FOLLOWUP) {
    return buildThreeMonthFollowupPrompt({
      clientName: promptClientName,
      clientCity: promptClientCity(),
      donorName: customerName,
      lastVisitDate: extraOptions.lastVisitDate
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

  const values = agentTemplateValues({
    clientName: promptClientName, customerName, greeting, lastVisitDate: extraOptions.lastVisitDate
  });

  const fromSettings = customScript(extraOptions.callScripts, normalizedCallType, 'opening_prompt', values);
  if (fromSettings) return fromSettings;

  const override = agentPromptOverride(agentConfig, 'opening_prompt', values);
  if (override) return override;

  if (normalizedCallType === CALL_TYPES.THREE_MONTH_FOLLOWUP) {
    return buildThreeMonthFollowupOpeningPrompt({
      clientName: promptClientName,
      clientCity: promptClientCity(),
      donorName: customerName,
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
