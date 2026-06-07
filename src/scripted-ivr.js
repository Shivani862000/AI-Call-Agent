/**
 * src/scripted-ivr.js
 * Legacy TwiML scripted IVR flows.
 */

'use strict';

const { CLIENT_NAME } = require('./config');
const { getScriptedCopy } = require('./call-management');
const { buildXmlResponse, xmlEscape } = require('./helpers');
const { detectLanguageChoice, isAffirmativeResponse } = require('./speech-utils');

function buildScriptedTwiml(customerName, clientName) {
  const encodedCustomerName = encodeURIComponent(customerName || process.env.CUSTOMER_NAME || 'Customer');
  const encodedClientName = encodeURIComponent(clientName || CLIENT_NAME);
  const copy = getScriptedCopy('hi', customerName, clientName);

  return buildXmlResponse(`  <Gather input="dtmf speech" numDigits="1" timeout="6" speechTimeout="auto" language="hi-IN" actionOnEmptyResult="true" action="/call/scripted/consent?lang=hi&amp;customerName=${xmlEscape(encodedCustomerName)}&amp;clientName=${xmlEscape(encodedClientName)}" method="POST">
    <Say language="hi-IN">${xmlEscape(copy.intro)}</Say>
  </Gather>
  <Say language="hi-IN">${xmlEscape(copy.noLanguageResponse)}</Say>
  <Hangup />`);
}

function buildScriptedLanguageResponse(req) {
  const speech = String(req.body.SpeechResult || '').trim().toLowerCase();
  const digit = String(req.body.Digits || '').trim();
  const language = detectLanguageChoice(speech, digit);
  const copy = getScriptedCopy(language, req.query.customerName, req.query.clientName);
  const encodedCustomerName = encodeURIComponent(req.query.customerName || process.env.CUSTOMER_NAME || 'Customer');
  const encodedClientName = encodeURIComponent(req.query.clientName || CLIENT_NAME);

  return buildXmlResponse(`  <Gather input="speech dtmf" numDigits="1" timeout="7" speechTimeout="auto" language="${language === 'en' ? 'en-IN' : 'hi-IN'}" actionOnEmptyResult="true" action="/call/scripted/consent?lang=${xmlEscape(language)}&amp;customerName=${xmlEscape(encodedCustomerName)}&amp;clientName=${xmlEscape(encodedClientName)}" method="POST">
    <Say language="${language === 'en' ? 'en-IN' : 'hi-IN'}">${xmlEscape(copy.consent)}</Say>
  </Gather>
  <Say language="${language === 'en' ? 'en-IN' : 'hi-IN'}">${xmlEscape(copy.noConsentResponse)}</Say>
  <Hangup />`);
}

function buildScriptedConsentResponse(req) {
  const speech = String(req.body.SpeechResult || '').trim();
  const digit = String(req.body.Digits || '').trim();
  const language = req.query.lang === 'en' ? 'en' : 'hi';
  const copy = getScriptedCopy(language, req.query.customerName, req.query.clientName);
  const encodedCustomerName = encodeURIComponent(req.query.customerName || process.env.CUSTOMER_NAME || 'Customer');
  const encodedClientName = encodeURIComponent(req.query.clientName || CLIENT_NAME);

  if (!isAffirmativeResponse(speech, digit)) {
    return buildXmlResponse(`  <Say language="hi-IN">${xmlEscape(copy.decline)}</Say>
  <Hangup />`);
  }

  return buildXmlResponse(`  <Gather input="speech dtmf" numDigits="1" timeout="10" speechTimeout="auto" language="hi-IN" actionOnEmptyResult="true" action="/call/scripted/rating?lang=${xmlEscape(language)}&amp;customerName=${xmlEscape(encodedCustomerName)}&amp;clientName=${xmlEscape(encodedClientName)}" method="POST">
    <Say language="hi-IN">${xmlEscape(copy.rating)}</Say>
  </Gather>
  <Say language="hi-IN">${xmlEscape(copy.noRatingResponse)}</Say>
  <Hangup />`);
}

function buildScriptedRatingResponse(req) {
  const speech = String(req.body.SpeechResult || '').trim();
  const digit = String(req.body.Digits || '').trim();
  const language = req.query.lang === 'en' ? 'en' : 'hi';
  const copy = getScriptedCopy(language, req.query.customerName, req.query.clientName);
  const rating = digit || speech;

  console.log(`[SCRIPTED] Rating response: ${rating || 'none'}`);

  return buildXmlResponse(`  <Say language="hi-IN">${xmlEscape(copy.closing)}</Say>
  <Hangup />`);
}

module.exports = {
  buildScriptedTwiml,
  buildScriptedLanguageResponse,
  buildScriptedConsentResponse,
  buildScriptedRatingResponse
};
