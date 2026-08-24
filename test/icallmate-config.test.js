'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

process.env.ICALLMATE_WEBHOOK_SECRET = 'test-icallmate-callback-secret';
process.env.APP_BASE_URL = '';
process.env.NGROK_URL = '';
process.env.WEBHOOK_URL = '';
process.env.SERVER_NAME = '';

const mountApiRoutes = require('../src/api-routes');
const { validateMediaToken } = require('../src/auth');
const { initiateCall } = require('../services/icallmate');

test('iCallMate public config DTO uses safe runtime fields and excludes resolved secrets', () => {
  // Mutation caught: a callback credential is embedded in an API response URL.
  const config = mountApiRoutes.createIcallMateConfigDto({
    requestBaseUrl: 'https://app.example.com',
    token: 'media-token',
    runtime: {
      settings: {
        did: 'database-did',
        testNumber: '+910000000000',
        incomingApiEndpoint: 'https://incoming.database.example',
        outboundApiEndpoint: 'https://outbound.database.example'
      },
      secrets: { webhookSecret: 'never-return-this' }
    }
  });

  assert.equal(config.did, 'database-did');
  assert.equal(config.callback_url, 'https://app.example.com/api/icallmate/callback');
  assert.equal(JSON.stringify(config).includes('never-return-this'), false);
});

test('iCallMate configuration responses redact media and callback credentials', () => {
  // Mutation caught: dry-run/provider responses expose a reusable media token or callback secret.
  const safe = mountApiRoutes.sanitizeIcallMateMacros([
    { dnisNo: 'did', macroName: 'llm_wssurl', macroValue: 'wss://voice.example.com/icallmate/media?token=media-secret' },
    { dnisNo: 'did', macroName: 'llm_callbackapi', macroValue: 'https://app.example.com/api/icallmate/callback?secret=callback-secret' },
    { dnisNo: 'did', macroName: 'llm_agentid', macroValue: 'agent-1' }
  ]);

  const json = JSON.stringify(safe);
  assert.equal(json.includes('media-secret'), false);
  assert.equal(json.includes('callback-secret'), false);
  assert.equal(safe[2].macroValue, 'agent-1');
});

test('iCallMate resolves persisted tenant configuration immediately before provider use', async () => {
  // Mutation caught: an outbound call keeps using module-load environment values instead of database settings.
  const requests = [];
  const result = await initiateCall('+918810300000', 'customer-1', {
    tenantId: 'tenant-1',
    wsurl: 'wss://voice.example.com/icallmate/media?token=existing',
    callbackapi: 'https://app.example.com/api/icallmate/callback?secret=callback-secret',
    getIntegrationRuntimeConfig: async (integration, tenantId) => {
      assert.equal(integration, 'icallmate');
      assert.equal(tenantId, 'tenant-1');
      return {
        settings: {
          outboundProvider: 'campaign',
          outboundApiEndpoint: 'https://database.icallmate.example',
          serviceNo: 'database-service',
          ivrTemplateId: 'database-template',
          agentId: 'database-agent',
          botId: 'database-bot',
          retryAttempt: 3,
          retryDurationMinutes: 7,
          callbackEnabled: true
        },
        secrets: { ukey: 'database-ukey' }
      };
    },
    fetchImpl: async (url, options) => {
      requests.push({ url: String(url), options });
      if (String(url).endsWith('/health')) return { ok: true, status: 200 };
      return { ok: true, status: 200, async text() { return JSON.stringify({ sid: 'provider-sid' }); } };
    }
  });

  assert.equal(requests.length, 2);
  assert.equal(requests[1].url, 'https://database.icallmate.example/OBDAPI/webresources/CreateOBDCampaignPost');
  const payload = JSON.parse(requests[1].options.body);
  assert.equal(payload.ukey, 'database-ukey');
  assert.equal(payload.serviceno, 'database-service');
  assert.equal(payload.ivrtemplateid, 'database-template');
  assert.equal(payload.msisdnlist[0].agentid, 'database-agent');
  assert.equal(payload.msisdnlist[0].botid, 'database-bot');
  assert.equal(result.sid, 'provider-sid');
  assert.equal(JSON.stringify(result).includes('database-ukey'), false);
  assert.equal(JSON.stringify(result).includes('callback-secret'), false);
});

test('iCallMate config returns an authenticated media URL without disclosing callback credentials', async (t) => {
  const app = express();
  app.use(express.json());
  mountApiRoutes(app, {
    getIntegrationRuntimeConfig: async (integration) => {
      assert.equal(integration, 'icallmate');
      return {
        settings: {
          did: 'database-did',
          testNumber: '+910000000000',
          incomingApiEndpoint: 'https://incoming.database.example',
          outboundApiEndpoint: 'https://outbound.database.example'
        },
        secrets: { webhookSecret: 'database-callback-secret' }
      };
    }
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const address = server.address();
  const response = await fetch(`http://127.0.0.1:${address.port}/api/icallmate/config`);
  assert.equal(response.status, 200);

  const config = await response.json();
  const mediaUrl = new URL(config.websocket_url);
  const token = mediaUrl.searchParams.get('token');
  assert.equal(mediaUrl.pathname, '/icallmate/media');
  assert.ok(token);
  assert.equal(validateMediaToken(token), true);

  const callbackUrl = new URL(config.callback_url);
  assert.equal(callbackUrl.pathname, '/api/icallmate/callback');
  assert.equal(callbackUrl.searchParams.get('secret'), null);
  assert.equal(JSON.stringify(config).includes('database-callback-secret'), false);
  assert.equal(config.did, 'database-did');
  assert.equal(config.incoming_api_endpoint, 'https://incoming.database.example');

  const rejectedCallback = await fetch(`http://127.0.0.1:${address.port}/api/icallmate/callback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ call_type: 'outbound', event: 'test' })
  });
  assert.equal(rejectedCallback.status, 401);

  const acceptedCallback = await fetch(config.callback_url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-webhook-secret': 'database-callback-secret' },
    body: JSON.stringify({ call_type: 'outbound', event: 'test' })
  });
  assert.equal(acceptedCallback.status, 200);
});
