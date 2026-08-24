'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  createDeepgramListenUrl,
  createDeepgramTranscriptBuffer
} = require('../src/speech-utils');
const { generateGeminiReply, transcribeAudioFile } = require('../services/gemini');
const setupWebSocketBridge = require('../src/websocket-bridge');

test('live media sessions resolve Gemini and Deepgram configuration for their tenant', async () => {
  // Mutation caught: live sessions retain module-load provider keys while other provider paths are dynamic.
  const calls = [];
  const config = await setupWebSocketBridge.resolveLiveProviderConfig({
    tenantId: 'tenant-1',
    getIntegrationRuntimeConfig: async (integration, tenantId) => {
      calls.push([integration, tenantId]);
      if (integration === 'gemini') {
        return {
          settings: { provider: 'gemini-live', model: 'database-live-model', voice: 'Aoede' },
          secrets: { apiKey: 'database-gemini-live-key' }
        };
      }
      return {
        settings: { listenModel: 'database-listen', ttsModel: 'database-tts', endpointingMs: 345 },
        secrets: { apiKey: 'database-deepgram-live-key' }
      };
    }
  });

  assert.deepEqual(calls, [['gemini', 'tenant-1'], ['deepgram', 'tenant-1']]);
  assert.equal(config.gemini.settings.model, 'database-live-model');
  assert.equal(config.gemini.secrets.apiKey, 'database-gemini-live-key');
  assert.equal(config.deepgram.settings.ttsModel, 'database-tts');
  assert.equal(config.deepgram.secrets.apiKey, 'database-deepgram-live-key');
});

test('Gemini resolves database model and API key at request time', async () => {
  // Mutation caught: a Gemini request keeps module-load environment configuration.
  let request = null;
  const reply = await generateGeminiReply({
    systemPrompt: 'Keep it short.',
    userText: 'Hello',
    tenantId: 'tenant-1',
    getIntegrationRuntimeConfig: async (integration, tenantId) => {
      assert.equal(integration, 'gemini');
      assert.equal(tenantId, 'tenant-1');
      return {
        settings: { model: 'database-gemini-model', temperature: 0.15, maxOutputTokens: 77, thinkingBudget: 4 },
        secrets: { apiKey: 'database-gemini-key' }
      };
    },
    fetchImpl: async (url, options) => {
      request = { url: String(url), options };
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Resolved reply' }] } }] });
        }
      };
    }
  });

  assert.equal(reply, 'Resolved reply');
  assert.match(request.url, /database-gemini-model:generateContent$/);
  assert.equal(request.options.headers['x-goog-api-key'], 'database-gemini-key');
  const body = JSON.parse(request.options.body);
  assert.equal(body.generationConfig.temperature, 0.15);
  assert.equal(body.generationConfig.maxOutputTokens, 77);
  assert.equal(body.generationConfig.thinkingConfig.thinkingBudget, 4);
});

test('disabled Gemini rejects before a request and provider error text stays private', async () => {
  let requests = 0;
  await assert.rejects(
    generateGeminiReply({
      systemPrompt: 'Safe',
      userText: 'Hello',
      getIntegrationRuntimeConfig: async () => ({ settings: { enabled: false }, secrets: { apiKey: 'key' } }),
      fetchImpl: async () => { requests += 1; throw new Error('must not request'); }
    }),
    (error) => error.code === 'INTEGRATION_DISABLED' && error.message === 'Gemini integration is disabled'
  );
  assert.equal(requests, 0);

  const echoedSecret = 'gemini-provider-echoed-secret';
  await assert.rejects(
    generateGeminiReply({
      systemPrompt: 'Safe',
      userText: 'Hello',
      getIntegrationRuntimeConfig: async () => ({
        settings: { enabled: true, model: 'safe-model' },
        secrets: { apiKey: 'key' }
      }),
      fetchImpl: async () => ({
        ok: false,
        status: 500,
        statusText: 'Failed',
        async text() { return echoedSecret; }
      })
    }),
    (error) => error.code === 'GEMINI_REQUEST_FAILED'
      && !error.message.includes(echoedSecret)
  );

  await assert.rejects(
    generateGeminiReply({
      systemPrompt: 'Safe',
      userText: 'Hello',
      getIntegrationRuntimeConfig: async () => ({
        settings: { enabled: true, model: 'safe-model' },
        secrets: { apiKey: 'key' }
      }),
      fetchImpl: async () => { throw new Error(echoedSecret); }
    }),
    (error) => error.code === 'GEMINI_REQUEST_FAILED'
      && !error.message.includes(echoedSecret)
  );

  await assert.rejects(
    generateGeminiReply({
      systemPrompt: 'Safe',
      userText: 'Hello',
      getIntegrationRuntimeConfig: async () => ({
        settings: { enabled: true, model: 'safe-model' },
        secrets: { apiKey: 'key' }
      }),
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        async text() { throw new Error(echoedSecret); }
      })
    }),
    (error) => error.code === 'GEMINI_RESPONSE_READ_FAILED'
      && !error.message.includes(echoedSecret)
  );
});

test('recording transcription resolves Deepgram configuration at request time', async (t) => {
  // Mutation caught: recording transcription bypasses managed Deepgram configuration.
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'deepgram-runtime-'));
  const recording = path.join(directory, 'recording.mp3');
  fs.writeFileSync(recording, Buffer.from('test-audio'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let request = null;

  const transcript = await transcribeAudioFile(recording, {
    tenantId: 'tenant-1',
    language: 'en',
    getIntegrationRuntimeConfig: async (integration, tenantId) => {
      assert.equal(integration, 'deepgram');
      assert.equal(tenantId, 'tenant-1');
      return {
        settings: { listenModel: 'database-listen-model', language: 'hi' },
        secrets: { apiKey: 'database-deepgram-key' }
      };
    },
    fetchImpl: async (url, options) => {
      request = { url: String(url), options };
      return {
        ok: true,
        async json() {
          return { results: { channels: [{ alternatives: [{ transcript: 'database transcript' }] }] } };
        }
      };
    }
  });

  assert.equal(transcript, 'database transcript');
  const url = new URL(request.url);
  assert.equal(url.searchParams.get('model'), 'database-listen-model');
  assert.equal(url.searchParams.get('language'), 'en');
  assert.equal(request.options.headers.Authorization, 'Token database-deepgram-key');
});

test('disabled Deepgram skips before a request and error logs omit provider response text', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'deepgram-disabled-'));
  const recording = path.join(directory, 'recording.mp3');
  fs.writeFileSync(recording, Buffer.from('test-audio'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let requests = 0;

  const disabled = await transcribeAudioFile(recording, {
    getIntegrationRuntimeConfig: async () => ({ settings: { enabled: false }, secrets: { apiKey: 'key' } }),
    fetchImpl: async () => { requests += 1; throw new Error('must not request'); }
  });
  assert.equal(disabled, null);
  assert.equal(requests, 0);

  const echoedSecret = 'deepgram-provider-echoed-secret';
  const logs = [];
  const originalError = console.error;
  console.error = (...values) => logs.push(values.join(' '));
  try {
    await transcribeAudioFile(recording, {
      getIntegrationRuntimeConfig: async () => ({
        settings: { enabled: true, listenModel: 'model', language: 'en' },
        secrets: { apiKey: 'key' }
      }),
      fetchImpl: async () => ({ ok: false, status: 500, async text() { return echoedSecret; } })
    });
  } finally {
    console.error = originalError;
  }
  assert.equal(logs.join('\n').includes(echoedSecret), false);
});

test('Deepgram live URL enables interim speech and utterance fallback events', () => {
  const url = new URL(createDeepgramListenUrl());
  assert.equal(url.searchParams.get('interim_results'), 'true');
  assert.equal(url.searchParams.get('vad_events'), 'true');
  assert.ok(Number(url.searchParams.get('utterance_end_ms')) >= 1000);
});

test('speech-final caller text dispatches immediately', () => {
  const transcripts = [];
  const buffer = createDeepgramTranscriptBuffer({
    onTranscript: (text) => transcripts.push(text)
  });

  const result = buffer.handleResult({
    is_final: true,
    speech_final: true,
    channel: { alternatives: [{ transcript: 'haan kar rahi hoon' }] }
  });

  assert.equal(result.hasSpeech, true);
  assert.deepEqual(transcripts, ['haan kar rahi hoon']);
  buffer.close();
});

test('final caller text flushes even when Deepgram omits speech-final', async () => {
  const transcripts = [];
  const buffer = createDeepgramTranscriptBuffer({
    flushDelayMs: 5,
    onTranscript: (text) => transcripts.push(text)
  });

  buffer.handleResult({
    is_final: true,
    speech_final: false,
    channel: { alternatives: [{ transcript: 'yes' }] }
  });
  await new Promise((resolve) => setTimeout(resolve, 80));

  assert.deepEqual(transcripts, ['yes']);
  buffer.close();
});
