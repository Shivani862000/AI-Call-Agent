'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

process.env.ICALLMATE_WEBHOOK_SECRET = 'test-icallmate-callback-secret';
process.env.ICALLMATE_MEDIA_SHARED_SECRET = 'test-media-shared-secret-at-least-32-bytes';
process.env.APP_BASE_URL = '';
process.env.NGROK_URL = '';
process.env.WEBHOOK_URL = '';
process.env.SERVER_NAME = '';

const mountApiRoutes = require('../src/api-routes');
const { validateMediaToken } = require('../src/auth');
const { initiateCall } = require('../services/icallmate');
const { buildOutboundCampaignPayload } = require('../services/icallmate');

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

test('iCallMate provider responses and logs never echo provider-controlled secret text', async (t) => {
  const echoedSecret = 'provider-echoed-ukey-never-leak';
  const logs = [];
  const originalLog = console.log;
  console.log = (...values) => logs.push(values.join(' '));
  t.after(() => { console.log = originalLog; });

  const result = await initiateCall('+918810300000', 'customer-1', {
    wsurl: 'wss://voice.example.com/icallmate/media?token=existing',
    callbackapi: 'https://app.example.com/api/icallmate/callback?secret=callback-secret',
    getIntegrationRuntimeConfig: async () => ({
      settings: {
        enabled: true,
        outboundProvider: 'masterpost',
        masterPostApiEndpoint: 'https://provider.example/master',
        serviceNo: '',
        ivrTemplateId: ''
      },
      secrets: { ukey: echoedSecret }
    }),
    fetchImpl: async (url) => String(url).endsWith('/health')
      ? { ok: true, status: 200 }
      : { ok: true, status: 200, async text() { return JSON.stringify({ sid: 'safe-sid', reason: echoedSecret }); } }
  });

  assert.deepEqual(result, { sid: 'safe-sid', status: 'queued', providerReturnedSid: true });
  assert.equal(JSON.stringify(result).includes(echoedSecret), false);
  assert.equal(logs.join('\n').includes(echoedSecret), false);
});

test('iCallMate provider transport failures expose only a fixed safe error', async () => {
  const echoedSecret = 'transport-error-echoed-media-token';
  await assert.rejects(
    initiateCall('+918810300000', 'customer-1', {
      wsurl: 'wss://voice.example.com/icallmate/media?token=existing',
      getIntegrationRuntimeConfig: async () => ({
        settings: { enabled: true, outboundProvider: 'campaign' },
        secrets: { ukey: 'key' }
      }),
      fetchImpl: async () => { throw new Error(echoedSecret); }
    }),
    (error) => error.code === 'ICALLMATE_MEDIA_ENDPOINT_UNAVAILABLE'
      && !error.message.includes(echoedSecret)
  );

  let requestCount = 0;
  await assert.rejects(
    initiateCall('+918810300000', 'customer-1', {
      wsurl: 'wss://voice.example.com/icallmate/media?token=existing',
      callbackapi: 'https://app.example.com/api/icallmate/callback',
      getIntegrationRuntimeConfig: async () => ({
        settings: {
          enabled: true,
          outboundProvider: 'campaign',
          outboundApiEndpoint: 'https://provider.example',
          serviceNo: 'service',
          ivrTemplateId: 'template'
        },
        secrets: { ukey: 'key' }
      }),
      fetchImpl: async () => {
        requestCount += 1;
        if (requestCount === 1) return { ok: true, status: 200 };
        return { ok: true, status: 200, async text() { throw new Error(echoedSecret); } };
      }
    }),
    (error) => error.code === 'ICALLMATE_RESPONSE_READ_FAILED'
      && !error.message.includes(echoedSecret)
  );
});

test('disabled iCallMate integration rejects with a fixed safe error before any request', async () => {
  let requests = 0;
  await assert.rejects(
    initiateCall('+918810300000', 'customer-1', {
      getIntegrationRuntimeConfig: async () => ({ settings: { enabled: false }, secrets: { ukey: 'secret' } }),
      fetchImpl: async () => { requests += 1; throw new Error('must not request'); }
    }),
    (error) => error.code === 'INTEGRATION_DISABLED'
      && error.message === 'iCallMate integration is disabled'
  );
  assert.equal(requests, 0);
});

test('explicit zero iCallMate retry and talk-time settings beat environment values', (t) => {
  const previous = {
    max: process.env.ICALLMATE_MAX_TALK_TIME_SEC,
    retry: process.env.ICALLMATE_RETRY_ATTEMPT,
    duration: process.env.ICALLMATE_RETRY_DURATION
  };
  process.env.ICALLMATE_MAX_TALK_TIME_SEC = '60';
  process.env.ICALLMATE_RETRY_ATTEMPT = '4';
  process.env.ICALLMATE_RETRY_DURATION = '8';
  t.after(() => {
    for (const [key, value] of Object.entries({
      ICALLMATE_MAX_TALK_TIME_SEC: previous.max,
      ICALLMATE_RETRY_ATTEMPT: previous.retry,
      ICALLMATE_RETRY_DURATION: previous.duration
    })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });

  const payload = buildOutboundCampaignPayload('+918810300000', 'customer-1', {
    maxTalkTimeInSec: 0,
    retryatmpt: 0,
    retryduration: 0
  });

  assert.equal(payload.maxTalkTimeInSec, 0);
  assert.equal(payload.retryatmpt, '0');
  assert.equal(payload.retryduration, '0');
});

test('rejected iCallMate config resolution reaches Express error middleware', async () => {
  const app = express();
  mountApiRoutes(app, {
    getIntegrationRuntimeConfig: async () => { throw new Error('resolver failure'); }
  });
  const layer = app._router.stack.find((candidate) => candidate.route?.path === '/api/icallmate/config');
  const handler = layer.route.stack[0].handle;
  let forwarded = null;

  await handler(
    { protocol: 'https', headers: { host: 'app.example.com' }, get: () => 'app.example.com' },
    { json() { throw new Error('must not respond'); } },
    (error) => { forwarded = error; }
  );

  assert.equal(forwarded?.message, 'resolver failure');
});

test('incoming-config API returns only a safe provider result code', async () => {
  const echoedSecret = 'incoming-provider-echoed-webhook-secret';
  const app = express();
  app.use(express.json());
  mountApiRoutes(app, {
    getIntegrationRuntimeConfig: async () => ({
      settings: { enabled: true, did: '123', incomingApiEndpoint: 'https://provider.example' },
      secrets: { webhookSecret: 'callback-secret' }
    }),
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      async text() { return JSON.stringify({ status: 'success', reason: echoedSecret }); }
    })
  });
  const layer = app._router.stack.find((candidate) => candidate.route?.path === '/api/icallmate/incoming-config');
  const handler = layer.route.stack[0].handle;
  let responseBody = null;

  await handler({
    body: {},
    tenantId: 'tenant-1',
    protocol: 'https',
    headers: { host: 'app.example.com' },
    get: () => 'app.example.com'
  }, {
    status() { return this; },
    json(value) { responseBody = value; }
  });

  assert.equal(responseBody.success, true);
  assert.equal(responseBody.code, 'ICALLMATE_CONFIG_APPLIED');
  assert.equal(Object.hasOwn(responseBody, 'response'), false);
  assert.equal(JSON.stringify(responseBody).includes(echoedSecret), false);
  assert.equal(JSON.stringify(responseBody).includes('callback-secret'), false);
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
