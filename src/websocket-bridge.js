/**
 * src/websocket-bridge.js
 * WebSocket bridge for iCallMate media streaming and AI integration.
 */

'use strict';

const WebSocket = require('ws');
const crypto = require('crypto');

const {
  AI_PROVIDER,
  CALL_TYPES,
  CLIENT_NAME,
  GEMINI_MODEL,
  GEMINI_VOICE,
  LIVE_TEMPERATURE,
  GEMINI_LIVE_MAX_OUTPUT_TOKENS,
  GEMINI_LIVE_THINKING_LEVEL,
  GEMINI_LIVE_PREFIX_PADDING_MS,
  GEMINI_LIVE_SILENCE_DURATION_MS,
  GEMINI_LIVE_DIRECT_AUDIO,
  DEEPGRAM_TTS_MODEL,
  FINAL_AUDIO_GRACE_MS,
  DEEPGRAM_ENDPOINTING_MS,
  MAX_CALL_DURATION_SECONDS
} = require('./config');

const {
  normalizeCallDirection,
  normalizeOutboundCallType,
  parseIcallMateExtraParams,
  pushTranscriptTurn,
  normalizeIcallTimestamp,
  runInBackground
} = require('./helpers');

const {
  buildAgentSystemPrompt,
  buildOpeningPrompt
} = require('./prompt-builder');

const { dbGet, dbRun } = require('../db');
const { saveCallFeedbackFromTranscript } = require('../services/call-feedback');
const { processCompletedCallPipeline } = require('../services/post-call-pipeline');
const { generateGeminiReply } = require('../services/gemini');
const {
  resamplePcm16,
  parsePcmRate
} = require('./speech-utils');

const {
  shouldAutoHangupAfterAgentTurn,
  estimateHangupDelayMs,
  buildOutboundDemoTurnInstruction
} = require('./conversation-state');

const {
  hydrateIcallMateSessionContext,
  upsertIcallMateCallFromMedia
} = require('./call-management');

const { validateMediaToken } = require('./auth');

function createDeepgramListenUrl() {
  const url = new URL('wss://api.deepgram.com/v1/listen');
  url.searchParams.set('model', 'nova-2');
  url.searchParams.set('smart_format', 'true');
  url.searchParams.set('encoding', 'linear16');
  url.searchParams.set('sample_rate', '8000');
  url.searchParams.set('channels', '1');
  url.searchParams.set('language', 'hi');
  url.searchParams.set('endpointing', '400');
  url.searchParams.set('vad_events', 'true');
  url.searchParams.set('interim_results', 'false');
  return url.toString();
}

function createDeepgramSpeakUrl() {
  const url = new URL('wss://api.deepgram.com/v1/speak');
  url.searchParams.set('model', DEEPGRAM_TTS_MODEL);
  url.searchParams.set('encoding', 'linear16');
  url.searchParams.set('sample_rate', '8000');
  return url.toString();
}

module.exports = function setupWebSocketBridge(server) {
  const icallMateWss = new WebSocket.Server({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const urlObj = new URL(req.url || '/', 'http://localhost');
    let pathname = decodeURIComponent(urlObj.pathname);
    let token = urlObj.searchParams.get('token');

    // Handle iCallMate bug where the '?' is URL-encoded into the path
    if (pathname.includes('/icallmate/media?token=')) {
      token = pathname.split('?token=')[1];
      pathname = '/icallmate/media';
    }

    console.log(`[WS UPGRADE] path=${pathname} host=${req.headers.host || ''} origin=${req.headers.origin || ''} upgrade=${req.headers.upgrade || ''} remote=${req.socket.remoteAddress || 'unknown'}`);

    if (pathname === '/icallmate/media') {
      if (!token || !validateMediaToken(token)) {
        console.warn(`[WS UPGRADE] Rejected invalid or missing token for /icallmate/media`);
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }

      icallMateWss.handleUpgrade(req, socket, head, (ws) => {
        icallMateWss.emit('connection', ws, req);
      });
      return;
    }

    console.warn(`[WS UPGRADE] Rejected unknown path=${pathname}`);
    socket.destroy();
  });

  function sendIcallMateJson(ws, payload) {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(payload));
  }

  function sendIcallMateMark(ws, message, name) {
    sendIcallMateJson(ws, {
      event: 'mark',
      sequenceNumber: String(Date.now()),
      ChKey: message.ChKey,
      streamId: message.streamId,
      mark: { name }
    });
  }

  function clearAudioQueue(session) {
    if (session.audioBuffer) {
      session.audioBuffer = Buffer.alloc(0);
    }
  }

  function sendReverseMediaStop(ws, session) {
    clearAudioQueue(session);
    sendIcallMateJson(ws, {
      event: 'reverse-media-stop',
      callerId: session.callerId,
      streamId: session.streamId
    });
  }

  function sendIcallMateReverseMedia(ws, session, pcmBuffer, flush = false) {
    if (ws.readyState !== WebSocket.OPEN || !session.streamId) return;

    if (!session.outChunkCount) session.outChunkCount = 0;
    
    const buffer = Buffer.isBuffer(pcmBuffer) ? pcmBuffer : Buffer.from(pcmBuffer || []);
    
    if (!session.audioBuffer) session.audioBuffer = Buffer.alloc(0);

    if (buffer.length) {
      session.audioBuffer = Buffer.concat([session.audioBuffer, buffer]);
    }

    if (flush) {
      session.turnComplete = true;
    } else {
      // If we receive new audio, we are no longer complete
      if (buffer.length > 0) {
        session.turnComplete = false;
      }
    }

    if (!session.audioInterval) {
      session.audioInterval = setInterval(() => {
        if (ws.readyState !== WebSocket.OPEN) {
          clearInterval(session.audioInterval);
          session.audioInterval = null;
          return;
        }

        if (ws.bufferedAmount && ws.bufferedAmount > 32000) {
          console.warn(`[ICALLMATE] WebSocket backpressure detected. bufferedAmount=${ws.bufferedAmount}`);
          return;
        }

        if (session.audioBuffer.length >= 320) {
          const chunk = session.audioBuffer.subarray(0, 320);
          session.audioBuffer = session.audioBuffer.subarray(320);
          
          session.outChunkCount++;
          if (session.outChunkCount % 100 === 0) {
            console.log(`[STAGE 7: Audio Stream] Sending TTS audio chunk ${session.outChunkCount} back to Caller`);
          }

          const remainingMs = (session.audioBuffer.length / 2 / 8000) * 1000;
          session.aiSpeakingUntil = Date.now() + remainingMs + 500;

          if (!session.firstChunkSentAt) {
            session.firstChunkSentAt = Date.now();
            
            // Calculate latencies
            const sttProducedAt = session.sttProducedAt || session.firstChunkSentAt;
            const llmFirstAudioAt = session.geminiLiveFirstAudioAt || session.firstChunkSentAt;
            
            // In Gemini Live Direct Audio, LLM hears speech directly and STT runs in parallel.
            // STT Latency is roughly the endpointing time (which is known), but we track when the final text was emitted.
            const sttLatencyMs = DEEPGRAM_ENDPOINTING_MS;
            // LLM Latency: from STT being produced (or user finishing speaking) to first audio chunk from LLM
            const llmLatencyMs = Math.max(0, llmFirstAudioAt - sttProducedAt);
            // TTS Latency: from first audio chunk from LLM to sending to the caller
            const ttsLatencyMs = Math.max(0, session.firstChunkSentAt - llmFirstAudioAt);
            // E2E Latency: from user finishing speaking (approximated by STT event minus endpointing) to audio sent
            const estimatedUserSpeechEndAt = sttProducedAt - DEEPGRAM_ENDPOINTING_MS;
            const e2eLatencyMs = Math.max(0, session.firstChunkSentAt - estimatedUserSpeechEndAt);
            
            console.log(`[LATENCY TRACKING] 
  STT Latency: ~${sttLatencyMs}ms (endpointing)
  LLM Latency: ${llmLatencyMs}ms
  TTS Latency: ${ttsLatencyMs}ms
  End-to-End Latency: ${e2eLatencyMs}ms
`);
            console.log(`[STAGE 7: Audio Stream] First chunk sent to Caller. e2eLatencyMs=${e2eLatencyMs}`);
          }

          sendIcallMateJson(ws, {
            event: 'reverse-media',
            encoding: 'LINEAR16',
            streamId: session.streamId,
            callerId: session.callerId,
            did: session.did,
            source: 'ai',
            payload: chunk.toString('base64')
          });
        } else if (session.turnComplete && session.audioBuffer.length > 0) {
          // Send remaining tail bytes
          const tail = session.audioBuffer;
          session.audioBuffer = Buffer.alloc(0);
          session.turnComplete = false; // Reset so we don't send empty chunks
          
          session.outChunkCount++;
          const remainingMs = (session.audioBuffer.length / 2 / 8000) * 1000;
          session.aiSpeakingUntil = Date.now() + remainingMs + 500;
          
          sendIcallMateJson(ws, {
            event: 'reverse-media',
            encoding: 'LINEAR16',
            streamId: session.streamId,
            callerId: session.callerId,
            did: session.did,
            source: 'ai',
            payload: tail.toString('base64')
          });
          
          // Clear latency tracking for next turn
          session.firstChunkSentAt = null;
          session.geminiLiveFirstAudioAt = null;
          session.sttProducedAt = null;
        } else if (session.turnComplete && session.audioBuffer.length === 0) {
          session.turnComplete = false;
          // Clear latency tracking for next turn
          session.firstChunkSentAt = null;
          session.geminiLiveFirstAudioAt = null;
          session.sttProducedAt = null;
        }
      }, 20); // Match ~8kHz chunk rate
    }
  }

  function createIcallMateAiBridge(ws, session) {
    let aiWs = null;
    let deepgramWs = null;
    let ttsWs = null;
    let geminiLiveSession = null;
    let geminiLiveConnecting = false;
    let geminiLiveReady = false;
    let geminiLivePromptSentAt = null;
    let bridgeClosed = false;
    let openingPromptSent = false;
    let lastLlmResponseAt = Date.now();
    let llmWatchdogInterval = null;
    let deepgramReady = false;
    let deepgramTtsReady = false;
    let pendingTtsTexts = [];
    let finalTranscriptBuffer = [];
    let pendingHangup = false;
    let hangupFinalizeTimer = null;
    let completionPersisted = false;
    let finalResponseInProgress = false;
    let activeResponseId = null;
    let callDurationInterval = null;
    let callDurationSeconds = 0;
    let durationWarningSent = false;
    const transcript = [];
    const outboundDemoState = {
      step: 'intro',
      conversationState: 'IN_PROGRESS',
      conversationCompleted: false,
      endCall: false,
      endCallAfterNextReply: false
    };

    const getSessionLabel = () => session.streamId || session.callerId || 'unknown';
    const isOutboundSession = () => normalizeCallDirection(session.callDirection) === 'outbound';
    const getSessionClientName = () => session.clientName || CLIENT_NAME;
    const getSessionCustomerName = () => session.customerName || process.env.CUSTOMER_NAME || 'sir/maam';
    const getSessionCallType = () => normalizeOutboundCallType(session.callType);
    const getSystemPrompt = () => buildAgentSystemPrompt(getSessionClientName(), getSessionCustomerName(), null, getSessionCallType(), { videoSent: session.videoSent, lastVisitDate: session.lastVisitDate });
    const getOpeningPrompt = () => buildOpeningPrompt(getSessionClientName(), getSessionCustomerName(), null, getSessionCallType(), { videoSent: session.videoSent, lastVisitDate: session.lastVisitDate });
    const openingInstruction = `System Instruction: This is an active voice call over WebSockets. Please start the conversation immediately by speaking this opening text naturally:\n"${getOpeningPrompt()}"`;
    const useGemini = () => AI_PROVIDER === 'gemini';
    const useGeminiLive = () => AI_PROVIDER === 'gemini-live';
    const useGeminiFamily = () => useGemini() || useGeminiLive();

    function sendDeepgramTtsText(text) {
      if (bridgeClosed) return;
      console.log(`[STAGE 6: TTS Stream] Sending text to Deepgram TTS: ${text}`);
      const safeText = String(text || '').replace(/\s+/g, ' ').trim();
      if (bridgeClosed || !safeText) {
        return;
      }

      if (ttsWs?.readyState === WebSocket.OPEN && deepgramTtsReady) {
        lastLlmResponseAt = Date.now();
        ttsWs.send(JSON.stringify({ type: 'Speak', text: safeText }));
        ttsWs.send(JSON.stringify({ type: 'Flush' }));
        return;
      }

      pendingTtsTexts.push(safeText);
      connectDeepgramTts();
    }

    function toPlainTranscript() {
      return transcript
        .filter((turn) => turn?.role && String(turn?.text || '').trim())
        .map((turn) => `${turn.role}: ${String(turn.text).trim()}`)
        .join('\n');
    }

    async function persistConversationCompletion(reason = 'conversation_completed') {
      if (completionPersisted || !isOutboundSession()) {
        return;
      }

      completionPersisted = true;
      const nowIso = new Date().toISOString();
      const transcriptText = toPlainTranscript();

      try {
        if (session.callId) {
          await dbRun(
            `UPDATE calls
              SET outcome = ?,
                  outcome_detail = ?,
                  transcript_text = COALESCE(NULLIF(?, ''), transcript_text),
                  transcript_status = ?,
                  transcript_source = COALESCE(transcript_source, ?),
                  analysis_status = CASE
                    WHEN COALESCE(analysis_status, '') = 'completed' THEN analysis_status
                    ELSE 'processing'
                  END,
                  ended_at = COALESCE(ended_at, ?),
                  last_event = ?,
                  notes = ?
            WHERE id = ?`,
            [
              'completed',
              reason,
              transcriptText,
              transcriptText ? 'completed' : 'missing',
              transcriptText ? 'live_stream' : null,
              nowIso,
              'ai-completed',
              reason === 'max_duration_reached' ? 'Max duration reached, forcing hangup' : 'AI conversation completed and auto hangup requested',
              session.callId
            ]
          );
          
          await dbRun('UPDATE calls SET call_duration = ?, call_end_reason = ? WHERE id = ?', [
            callDurationSeconds,
            reason || 'workflow_completed',
            session.callId
          ]);
        }

        // Update customer status so UI badge changes from "Calling..." to "Completed"
        if (session.customerId) {
          await dbRun(
            'UPDATE customers SET status = ?, last_called_at = ? WHERE id = ?',
            ['completed', nowIso, session.customerId]
          );
          console.log(`[CALL STATUS] Calling -> Completed (customerId=${session.customerId})`);
        }

        if (session.providerCallId && transcript.length) {
          await saveCallFeedbackFromTranscript({
            dbGet,
            dbRun,
            callSid: session.providerCallId,
            customerId: session.customerId,
            transcript,
            overwriteExisting: true
          });

          runInBackground('POST CALL PIPELINE ERROR', async () => {
            const result = await processCompletedCallPipeline({ dbGet, dbRun, callSid: session.providerCallId });
            if (result.ok) {
              console.log(`[POST CALL PIPELINE] Processed auto-completed call ${session.providerCallId} with feedback ${result.feedbackId}`);
            } else {
              console.log(`[POST CALL PIPELINE] Skipped auto-completed call ${session.providerCallId}: ${result.reason}`);
            }
          });
        }
      } catch (error) {
        completionPersisted = false;
        console.error(`[ICALLMATE][COMPLETION SAVE ERROR] streamId=${getSessionLabel()} reason=${reason} error=${error.message}`);
      }
    }

    function stopListeningForCallerAudio() {
      finalTranscriptBuffer = [];
      deepgramReady = false;
      if (deepgramWs && deepgramWs.readyState < WebSocket.CLOSING) {
        deepgramWs.close();
      }
    }

    async function sendGeminiClientTurn(text, options = {}) {
      const safeText = String(text || '').trim();
      if (bridgeClosed || !safeText) {
        return;
      }

      if (options.interrupt) {
        if (ws.readyState === WebSocket.OPEN) {
          sendReverseMediaStop(ws, session);
        } if (ttsWs?.readyState === WebSocket.OPEN) {
          ttsWs.send(JSON.stringify({ type: 'Clear' }));
        }
      }

      try {
        console.log(`[STAGE 4: Conversation Manager] Sending prompt to Gemini. streamId=${getSessionLabel()} model=${GEMINI_MODEL}`);
        const aiText = await generateGeminiReply({
          systemPrompt: getSystemPrompt(),
          transcript,
          userText: safeText,
          model: GEMINI_MODEL
        });

        if (bridgeClosed) {
          return;
        }

        transcript.push({ role: 'CUSTOMER', text: safeText, time: new Date().toISOString() });
        transcript.push({ role: 'AGENT', text: aiText, time: new Date().toISOString() });
        console.log(`[STAGE 5: Gemini LLM] Generated text: ${aiText}`);
        sendDeepgramTtsText(aiText);

        if (outboundDemoState.endCallAfterNextReply) {
          outboundDemoState.conversationEnded = true;
          console.log(`[ICALLMATE] Auto-hangup closing message detected but auto-hangup is disabled.`);
        }
      } catch (error) {
        console.error('[ICALLMATE][GEMINI ERROR]', error.message);
        const fallback = isOutboundSession()
          ? 'Maaf kijiye, thodi technical dikkat aa rahi hai. Hum aapse baad mein sampark karenge. Dhanyavaad.'
          : 'Maaf kijiye, thodi technical dikkat aa rahi hai. Hamari team aapse sampark karegi. Dhanyavaad.';
        transcript.push({ role: 'AGENT', text: fallback, time: new Date().toISOString() });
        sendDeepgramTtsText(fallback);
        requestCallHangup('gemini_error_fallback');
        scheduleFinalizeCallHangup('gemini_error_fallback', fallback);
      }
    }

    function sendGeminiLiveText(text, options = {}) {
      const safeText = String(text || '').trim();
      if (bridgeClosed || !safeText || !geminiLiveSession || !geminiLiveReady) {
        return;
      }

      if (options.interrupt) {
        sendReverseMediaStop(ws, session);
      }

      geminiLivePromptSentAt = Date.now();
      lastLlmResponseAt = Date.now();
      session.geminiLiveFirstAudioAt = null;
      session.firstChunkSentAt = null;
      if (session._geminiDiag) {
        session._geminiDiag = { audioParts: 0, textParts: 0, msgCount: 0, totalAudioBytes: 0 };
      }
      geminiLiveSession.sendClientContent({
        turns: [
          {
            role: 'user',
            parts: [{ text: safeText }]
          }
        ],
        turnComplete: true
      });
    }

    async function connectGeminiLive() {
      if (bridgeClosed || geminiLiveConnecting || geminiLiveSession) {
        return;
      }

      geminiLiveConnecting = true;
      try {
        // Wait for any in-progress session hydration to complete
        // so we read the correct callType for the system prompt
        if (session._hydrationPromise) {
          await session._hydrationPromise;
        }

        const { GoogleGenAI, Modality } = await import('@google/genai');
        const ai = new GoogleGenAI({
          apiKey: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY
        });

        const config = {
          responseModalities: [GEMINI_LIVE_DIRECT_AUDIO ? Modality.AUDIO : Modality.TEXT],
          systemInstruction: getSystemPrompt(),
          speechConfig: GEMINI_LIVE_DIRECT_AUDIO ? {
            voiceConfig: {
              prebuiltVoiceConfig: {
                voiceName: GEMINI_VOICE
              }
            }
          } : undefined,
          temperature: LIVE_TEMPERATURE,
          maxOutputTokens: GEMINI_LIVE_MAX_OUTPUT_TOKENS,
          thinkingConfig: {
            thinkingLevel: GEMINI_LIVE_THINKING_LEVEL
          },
          realtimeInputConfig: {
            automaticActivityDetection: {
              disabled: false,
              prefixPaddingMs: GEMINI_LIVE_PREFIX_PADDING_MS,
              silenceDurationMs: GEMINI_LIVE_SILENCE_DURATION_MS
            }
          },
          outputAudioTranscription: {}
        };

        console.log(
          `[ICALLMATE][GEMINI LIVE] Connecting streamId=${getSessionLabel()} ` +
          `model=${GEMINI_MODEL} voice=${GEMINI_VOICE} thinking=${GEMINI_LIVE_THINKING_LEVEL} ` +
          `silenceMs=${GEMINI_LIVE_SILENCE_DURATION_MS} ` +
          `directAudio=${GEMINI_LIVE_DIRECT_AUDIO} ` +
          `responseModalities=${JSON.stringify(config.responseModalities)} ` +
          `hasSpeechConfig=${!!config.speechConfig}`
        );

        geminiLiveSession = await ai.live.connect({
          model: GEMINI_MODEL,
          config,
          callbacks: {
            onopen: () => {
              geminiLiveReady = true;
              lastLlmResponseAt = Date.now();
              console.log(`[ICALLMATE][GEMINI LIVE] Connected streamId=${getSessionLabel()}`);

              // LLM watchdog interval removed
            },
            onmessage: (message) => {
              if (bridgeClosed) {
                return;
              }
              lastLlmResponseAt = Date.now();

              // ── Diagnostic counters ──
              if (!session._geminiDiag) {
                session._geminiDiag = { audioParts: 0, textParts: 0, msgCount: 0, totalAudioBytes: 0 };
              }
              session._geminiDiag.msgCount++;

              const modelTurnParts = message?.serverContent?.modelTurn?.parts || [];

              // Log every part's shape for diagnosis
              modelTurnParts.forEach((part, idx) => {
                const inlineData = part.inlineData || part.inline_data;
                const hasText = !!part.text;
                const hasAudio = !!(inlineData?.data);
                const mime = inlineData?.mimeType || inlineData?.mime_type || null;
                const audioLen = hasAudio ? Buffer.from(inlineData.data, 'base64').length : 0;

                if (hasText) session._geminiDiag.textParts++;
                if (hasAudio) { session._geminiDiag.audioParts++; session._geminiDiag.totalAudioBytes += audioLen; }

                // Log first 20 parts, then every 50th
                if (session._geminiDiag.audioParts + session._geminiDiag.textParts <= 20 ||
                  (session._geminiDiag.audioParts + session._geminiDiag.textParts) % 50 === 0) {
                  console.log(
                    `[GEMINI DIAG] msg#${session._geminiDiag.msgCount} part#${idx} ` +
                    `hasText=${hasText}${hasText ? '(len=' + part.text.length + ')' : ''} ` +
                    `hasAudio=${hasAudio}${hasAudio ? '(bytes=' + audioLen + ',mime=' + mime + ')' : ''} ` +
                    `totals: audioParts=${session._geminiDiag.audioParts} textParts=${session._geminiDiag.textParts} ` +
                    `totalAudioBytes=${session._geminiDiag.totalAudioBytes}`
                  );
                }
              });

              // If we got model turn parts but zero had audio, warn
              if (modelTurnParts.length > 0 && !modelTurnParts.some(p => (p.inlineData || p.inline_data)?.data)) {
                if (session._geminiDiag.audioParts === 0 && session._geminiDiag.msgCount <= 10) {
                  console.warn(
                    `[GEMINI DIAG WARNING] ${session._geminiDiag.msgCount} messages received, ` +
                    `0 audio parts so far! Gemini may be running in TEXT-ONLY mode. ` +
                    `Check responseModalities config. GEMINI_LIVE_DIRECT_AUDIO=${GEMINI_LIVE_DIRECT_AUDIO}`
                  );
                }
              }

              modelTurnParts.forEach((part) => {
                const inlineData = part.inlineData || part.inline_data;
                const base64Audio = inlineData?.data;
                if (!base64Audio) {
                  return;
                }

                const mimeType = inlineData.mimeType || inlineData.mime_type || 'audio/pcm;rate=24000';
                const sampleRate = parsePcmRate(mimeType, 24000);
                const pcm16 = Buffer.from(base64Audio, 'base64');
                if (!session.geminiLiveFirstAudioAt) {
                  session.geminiLiveFirstAudioAt = Date.now();
                  const responseMs = geminiLivePromptSentAt ? session.geminiLiveFirstAudioAt - geminiLivePromptSentAt : null;
                  console.log(
                    `[ICALLMATE][GEMINI LIVE] First audio chunk streamId=${getSessionLabel()} ` +
                    `responseMs=${responseMs ?? 'unknown'} sampleRate=${sampleRate} bytes=${pcm16.length}`
                  );
                }
                if (!session.geminiLiveRawBuffer) session.geminiLiveRawBuffer = Buffer.alloc(0);
                session.geminiLiveRawBuffer = Buffer.concat([session.geminiLiveRawBuffer, pcm16]);

                while (session.geminiLiveRawBuffer.length >= 4800) {
                  const chunkToResample = session.geminiLiveRawBuffer.subarray(0, 4800);
                  session.geminiLiveRawBuffer = session.geminiLiveRawBuffer.subarray(4800);
                  sendIcallMateReverseMedia(ws, session, resamplePcm16(chunkToResample, sampleRate, 8000));
                }
              });

              const outputTranscript = message?.serverContent?.outputTranscription?.text
                || message?.serverContent?.output_transcription?.text
                || '';
              if (outputTranscript) {
                const cleanTranscript = String(outputTranscript)
                  .replace(/\bEND_CALL\s*=\s*true\b/gi, '')
                  .replace(/\bend_call\b/gi, '')
                  .trim();
                if (cleanTranscript) {
                  console.log(`[STAGE 5: Gemini LLM] Generated text: ${cleanTranscript}`);
                  pushTranscriptTurn(transcript, 'AGENT', cleanTranscript);
                  if (!GEMINI_LIVE_DIRECT_AUDIO) {
                    sendDeepgramTtsText(cleanTranscript);
                  }
                }
                if (/\bend_call\b|END_CALL\s*=\s*true/i.test(String(outputTranscript))) {
                  console.log(`[ICALLMATE] End call marker detected, but auto-hangup is disabled.`);
                }
              }

              if (message?.serverContent?.turnComplete || message?.serverContent?.generationComplete) {
                const d = session._geminiDiag || { audioParts: 0, textParts: 0, msgCount: 0, totalAudioBytes: 0 };
                const queuedBytes = session.audioBuffer ? session.audioBuffer.length : 0;
                console.log(
                  `[GEMINI DIAG] turnComplete! msgs=${d.msgCount} audioParts=${d.audioParts} ` +
                  `textParts=${d.textParts} totalAudioBytes=${d.totalAudioBytes} ` +
                  `audioQueuePending=${queuedBytes} rawBufferPending=${session.geminiLiveRawBuffer?.length || 0}`
                );
                // Flush remaining raw buffer into audioBuffer
                if (session.geminiLiveRawBuffer && session.geminiLiveRawBuffer.length > 0) {
                  const resampled = resamplePcm16(session.geminiLiveRawBuffer, 24000, 8000);
                  session.geminiLiveRawBuffer = Buffer.alloc(0);
                  if (!session.audioBuffer) session.audioBuffer = Buffer.alloc(0);
                  session.audioBuffer = Buffer.concat([session.audioBuffer, resampled]);
                }

                // Signal the interval to flush the tail when buffer drains below 3200
                session.turnComplete = true;

                // Schedule hangup AFTER audio finishes playing, not immediately
                const pendingAudioMs = ((session.audioBuffer?.length || 0) / 2 / 8000) * 1000;
                const hangupDelay = pendingAudioMs + 1500; // wait for audio + 1.5s grace

                // Turn complete hangup logic removed
                finalResponseInProgress = false;
              }

              if (message?.serverContent?.interrupted) {
                const pendingBytes = session.audioBuffer?.length || 0;
                console.warn(
                  `[GEMINI DIAG] Interrupted signal received! streamId=${getSessionLabel()} ` +
                  `pendingAudioBytes=${pendingBytes} pendingAudioMs=${Math.round(pendingBytes / 2 / 8000 * 1000)}`
                );
                sendReverseMediaStop(ws, session);
                session.firstChunkSentAt = null;
                session.geminiLiveFirstAudioAt = null;
                session.sttProducedAt = null;
              }
            },
            onerror: (error) => {
              if (bridgeClosed) {
                return;
              }
              console.error('[ICALLMATE][GEMINI LIVE ERROR]', error.message || error);
            },
            onclose: (event) => {
              geminiLiveReady = false;
              console.log(`[ICALLMATE][GEMINI LIVE] Closed streamId=${getSessionLabel()} reason=${event?.reason || 'n/a'}`);
            }
          }
        });
        sendOpeningPrompt();
      } catch (error) {
        console.error('[ICALLMATE][GEMINI LIVE CONNECT ERROR]', error.message);
      } finally {
        geminiLiveConnecting = false;
      }
    }

    function sendOpeningPrompt() {
      if (bridgeClosed || openingPromptSent) {
        return;
      }

      openingPromptSent = true;
      console.log(`[ICALLMATE][${useGeminiLive() ? 'GEMINI LIVE' : 'GEMINI'}] Sending opening prompt streamId=${getSessionLabel()}`);
      console.log(`[ICALLMATE][PROMPT] provider=${AI_PROVIDER} direction=${isOutboundSession() ? 'outbound' : 'incoming'} callType=${getSessionCallType()} client="${getSessionClientName()}" customer="${getSessionCustomerName()}" system="${getSystemPrompt().slice(0, 180)}" opening="${getOpeningPrompt()}"`);

      if (useGeminiLive()) {
        sendGeminiLiveText(getOpeningPrompt(), { interrupt: true });
        return;
      }

      if (useGemini()) {
        sendGeminiClientTurn(getOpeningPrompt(), { interrupt: true });
      }
    }

    function requestCallHangup(reason = 'model_requested_end_call') {
      if (pendingHangup || bridgeClosed) {
        return;
      }

      pendingHangup = true;
      outboundDemoState.conversationState = 'COMPLETED';
      outboundDemoState.conversationCompleted = true;
      outboundDemoState.endCall = true;
      stopListeningForCallerAudio();
      console.log(`[ICALLMATE][VOICE] Hangup requested reason=${reason} streamId=${getSessionLabel()}`);
    }

    function scheduleFinalizeCallHangup(reason = 'model_requested_end_call', spokenText = '') {
      if (bridgeClosed || !pendingHangup) {
        return;
      }

      if (hangupFinalizeTimer) {
        clearTimeout(hangupFinalizeTimer);
      }

      const pendingMs = ((session.audioBuffer?.length || 0) / 2 / 8000) * 1000;
      const delayMs = Math.max(estimateHangupDelayMs(spokenText), FINAL_AUDIO_GRACE_MS, pendingMs + 1000);
      console.log(
        `[ICALLMATE][VOICE] Auto hangup scheduled streamId=${getSessionLabel()} ` +
        `reason=${reason} delayMs=${delayMs}`
      );
      hangupFinalizeTimer = setTimeout(() => {
        finalizeCallHangup(reason);
      }, delayMs);
    }

    async function finalizeCallHangup(reason = 'model_requested_end_call') {
      if (bridgeClosed || !pendingHangup) {
        return;
      }

      if (hangupFinalizeTimer) {
        clearTimeout(hangupFinalizeTimer);
        hangupFinalizeTimer = null;
      }

      await persistConversationCompletion(reason);

      await upsertIcallMateCallFromMedia({
        streamId: session.streamId,
        callerId: session.callerId,
        did: session.did,
        event: 'hangup-call',
        timestamp: new Date().toISOString()
      }, session, {
        status: 'completed',
        ended_at: new Date().toISOString(),
        notes: 'AI conversation completed; auto hangup'
      });
      sendReverseMediaStop(ws, session);
      sendIcallMateJson(ws, {
        event: 'hangup-call',
        callerId: session.callerId,
        streamId: session.streamId,
        reason
      });
      console.log(`[ICALLMATE][VOICE] Executing final hangup sequence and disconnecting socket...`);
      bridgeClosed = true;
      setTimeout(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.close();
        }
      }, 250);
    }

    function handleDeepgramTranscript(event) {
      if (pendingHangup || outboundDemoState.conversationState === 'COMPLETED') {
        return;
      }

      const transcriptText = String(event?.channel?.alternatives?.[0]?.transcript || '').trim();
      const isFinal = Boolean(event?.is_final);
      const isSpeechFinal = Boolean(event?.speech_final);

      if (!transcriptText) {
        if (isSpeechFinal && finalTranscriptBuffer.length) {
          const merged = finalTranscriptBuffer.join(' ').replace(/\s+/g, ' ').trim();
          finalTranscriptBuffer = [];
          if (merged) {
            session.sttProducedAt = Date.now();
            console.log(`[STAGE 3: Transcript] STT produced text (Outbound): ${merged}`);
            pushTranscriptTurn(transcript, 'CUSTOMER', merged);
            const turnText = isOutboundSession()
              ? buildOutboundDemoTurnInstruction(merged, outboundDemoState, getSessionClientName(), getSessionCustomerName(), getSessionCallType())
              : `Caller said: ${merged}\nDo not greet again. Continue this inbound support call naturally in Hindi/Hinglish and help with the caller's request.`;
            if (useGeminiLive()) {
              if (!GEMINI_LIVE_DIRECT_AUDIO) {
                sendGeminiLiveText(turnText, { interrupt: true });
              }
            } else if (useGemini()) {
              sendGeminiClientTurn(turnText, { interrupt: true });
            } else {
              sendOpenAIClientTurn(turnText, { interrupt: true });
            }
          }
        }
        return;
      }

      if (isFinal) {
        finalTranscriptBuffer.push(transcriptText);
      }

      if (isSpeechFinal) {
        const merged = (finalTranscriptBuffer.length ? finalTranscriptBuffer.join(' ') : transcriptText)
          .replace(/\s+/g, ' ')
          .trim();
        finalTranscriptBuffer = [];
        if (merged) {
          session.sttProducedAt = Date.now();
          console.log(`[STAGE 3: Transcript] STT produced text (Inbound): ${merged}`);
          pushTranscriptTurn(transcript, 'CUSTOMER', merged);
          const turnText = `Caller said: ${merged}\nRespond naturally in Hindi/Hinglish based on the system prompt instructions.`;
          if (useGeminiLive()) {
            if (!GEMINI_LIVE_DIRECT_AUDIO) {
              sendGeminiLiveText(turnText, { interrupt: true });
            }
          } else if (useGemini()) {
            sendGeminiClientTurn(turnText, { interrupt: true });
          } else {
            sendOpenAIClientTurn(turnText, { interrupt: true });
          }
        }
      }
    }

    function connectDeepgram() {
      if (bridgeClosed) {
        return;
      }

      if (!process.env.DEEPGRAM_API_KEY) {
        console.warn('[ICALLMATE][DEEPGRAM] Missing DEEPGRAM_API_KEY; bot can speak opening but caller speech will not be transcribed.');
        return;
      }

      if (deepgramWs && deepgramWs.readyState !== WebSocket.CLOSED) {
        return;
      }

      deepgramWs = new WebSocket(createDeepgramListenUrl(), {
        headers: {
          Authorization: `Token ${process.env.DEEPGRAM_API_KEY}`
        }
      });

      deepgramWs.on('open', () => {
        if (bridgeClosed) {
          deepgramWs.close();
          return;
        }

        deepgramReady = true;
        console.log(`[ICALLMATE][DEEPGRAM] Live transcription connected streamId=${getSessionLabel()}`);
      });

      deepgramWs.on('message', (raw) => {
        let event;

        try {
          event = JSON.parse(raw.toString());
        } catch (error) {
          console.error('[ICALLMATE][DEEPGRAM] Parse error:', error.message);
          return;
        }

        if (event.type === 'Results') {
          handleDeepgramTranscript(event);
        }
      });

      deepgramWs.on('close', () => {
        deepgramReady = false;
        console.log(`[ICALLMATE][DEEPGRAM] Live transcription closed streamId=${getSessionLabel()}`);
      });

      deepgramWs.on('error', (error) => {
        deepgramReady = false;
        if (bridgeClosed) {
          return;
        }

        console.error('[ICALLMATE][DEEPGRAM ERROR]', error.message);
      });
    }

    function connectDeepgramTts() {
      if (bridgeClosed || !useGemini()) {
        return;
      }

      if (!process.env.DEEPGRAM_API_KEY) {
        console.warn('[ICALLMATE][DEEPGRAM TTS] Missing DEEPGRAM_API_KEY; Gemini replies cannot be spoken.');
        return;
      }

      if (ttsWs && ttsWs.readyState !== WebSocket.CLOSED) {
        return;
      }

      deepgramTtsReady = false;
      ttsWs = new WebSocket(createDeepgramSpeakUrl(), {
        headers: {
          Authorization: `Token ${process.env.DEEPGRAM_API_KEY}`
        }
      });

      ttsWs.on('open', () => {
        if (bridgeClosed) {
          ttsWs.close();
          return;
        }

        deepgramTtsReady = true;
        console.log(`[ICALLMATE][DEEPGRAM TTS] Connected streamId=${getSessionLabel()} model=${DEEPGRAM_TTS_MODEL}`);
        const queued = pendingTtsTexts;
        pendingTtsTexts = [];
        queued.forEach((text) => sendDeepgramTtsText(text));
      });

      ttsWs.on('message', (raw) => {
        if (bridgeClosed) {
          return;
        }

        if (Buffer.isBuffer(raw)) {
          sendIcallMateReverseMedia(ws, session, raw);
          return;
        }

        const text = raw.toString();
        if (!text.trim().startsWith('{')) {
          return;
        }

        try {
          const event = JSON.parse(text);
          if (event.type === 'Warning' || event.type === 'Error') {
            console.warn(`[ICALLMATE][DEEPGRAM TTS] ${JSON.stringify(event)}`);
          }
        } catch (error) {
          console.error('[ICALLMATE][DEEPGRAM TTS] Parse error:', error.message);
        }
      });

      ttsWs.on('close', () => {
        deepgramTtsReady = false;
        console.log(`[ICALLMATE][DEEPGRAM TTS] Closed streamId=${getSessionLabel()}`);
      });

      ttsWs.on('error', (error) => {
        deepgramTtsReady = false;
        if (bridgeClosed) {
          return;
        }

        console.error('[ICALLMATE][DEEPGRAM TTS ERROR]', error.message);
      });
    }

    return {
      start() {
        if (bridgeClosed) {
          return;
        }

        if (useGeminiLive()) {
          connectGeminiLive();
        } else if (useGemini()) {
          connectDeepgramTts();
          sendOpeningPrompt();
        } else {
          connectOpenAI();
        }
        connectDeepgram();

        // Call duration hard timeout and interval removed
      },
      sendCallerAudio(payload) {
        if (bridgeClosed || pendingHangup || outboundDemoState.conversationEnded || !payload) {
          return;
        }

        // In DIRECT_AUDIO mode, always forward caller audio to Gemini Live
        // so its built-in VAD / turn-taking works properly even while AI speaks.
        if (useGeminiLive() && GEMINI_LIVE_DIRECT_AUDIO) {
          if (geminiLiveSession && geminiLiveReady) {
            if (session.audioChunkCount % 100 === 0) {
              console.log(`[STAGE 2: Audio Stream] Sending chunk to Gemini Live Native Audio`);
            }
            geminiLiveSession.sendRealtimeInput({
              audio: {
                data: payload,
                mimeType: 'audio/pcm;rate=8000'
              }
            });
          }
        }

        // Gate Deepgram STT while AI is speaking to prevent echo / self-interruption
        if (session.aiSpeakingUntil && Date.now() < session.aiSpeakingUntil) {
          if (deepgramReady && deepgramWs?.readyState === WebSocket.OPEN) {
            const audioBuffer = Buffer.from(payload, 'base64');
            const silence = Buffer.alloc(audioBuffer.length);
            deepgramWs.send(silence);
          }
          return;
        }

        if (!deepgramReady || deepgramWs?.readyState !== WebSocket.OPEN) {
          return;
        }

        if (useGeminiFamily() || aiWs?.readyState === WebSocket.OPEN) {
          deepgramWs.send(Buffer.from(payload, 'base64'));
        }
      },
      close() {
        if (llmWatchdogInterval) clearInterval(llmWatchdogInterval);
        if (session.audioInterval) clearInterval(session.audioInterval);
        if (callDurationInterval) clearInterval(callDurationInterval);
        bridgeClosed = true;
        if (hangupFinalizeTimer) {
          clearTimeout(hangupFinalizeTimer);
          hangupFinalizeTimer = null;
        }
        if (ttsWs && ttsWs.readyState === WebSocket.OPEN) {
          ttsWs.send(JSON.stringify({ type: 'Close' }));
        }
        if (deepgramWs && deepgramWs.readyState < WebSocket.CLOSING) {
          deepgramWs.close();
        }
        if (ttsWs && ttsWs.readyState < WebSocket.CLOSING) {
          ttsWs.close();
        }
        if (aiWs && aiWs.readyState < WebSocket.CLOSING) {
          aiWs.close();
        }
        if (geminiLiveSession) {
          try {
            geminiLiveSession.close();
          } catch (error) {
            console.error('[ICALLMATE][GEMINI LIVE CLOSE ERROR]', error.message);
          }
        }
      },
      getTranscriptText() {
        return toPlainTranscript();
      },
      async persistCompletion(reason) {
        await persistConversationCompletion(reason || 'external_hangup');
      }
    };
  }

  icallMateWss.on('connection', (ws, req) => {
    console.log('[ICALLMATE] Media stream connected');
    console.log(`[ICALLMATE] Upgrade request from ${req.socket.remoteAddress || 'unknown'}`);
    console.log(`[ICALLMATE] Request headers host=${req.headers.host || ''} ua=${req.headers['user-agent'] || ''} x-forwarded-for=${req.headers['x-forwarded-for'] || ''}`);

    const session = {
      streamId: '',
      callerId: '',
      did: '',
      callDirection: 'incoming',
      callType: CALL_TYPES.REVIEW_CALL,
      customerName: '',
      clientName: CLIENT_NAME,
      answered: false,
      contextHydrated: false,
      contextHydrating: false,
      customerId: null,
      callId: null,
      providerCallId: '',
      mediaPacketsSeen: 0,
      connectedAt: new Date().toISOString()
    };
    const aiBridge = createIcallMateAiBridge(ws, session);

    ws.on('message', async (raw) => {
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch (error) {
        console.error('[ICALLMATE] Invalid JSON payload:', error.message);
        return;
      }

      const eventName = String(message.event || '').toLowerCase();
      if (eventName === 'media') {
        session.mediaPacketsSeen += 1;
        if (session.mediaPacketsSeen <= 5 || session.mediaPacketsSeen % 50 === 0) {
          console.log(
            `[ICALLMATE] event=media count=${session.mediaPacketsSeen} ` +
            `streamId=${message.streamId || session.streamId || ''} callerId=${message.callerId || session.callerId || ''} did=${message.did || session.did || ''}`
          );
        }
      } else {
        console.log(`[STAGE 1: Audio Stream] event=${eventName} count=${session.audioChunkCount || 0} streamId=${session.streamId || ''} callerId=${message.callerId || session.callerId || ''} did=${message.did || session.did || ''}`);
      }
      if (message.streamId) session.streamId = message.streamId;
      if (message.callerId) session.callerId = message.callerId;
      if (message.did) session.did = message.did;
      const extraParams = parseIcallMateExtraParams(message.extraParams || message.extraparam || message.extra_param);
      if (message.callDirection) session.callDirection = normalizeCallDirection(message.callDirection, session.callDirection);
      if (extraParams.callDirection) session.callDirection = normalizeCallDirection(extraParams.callDirection, session.callDirection);
      if (message.callType || message.call_type) session.callType = normalizeOutboundCallType(message.callType || message.call_type);
      if (extraParams.callType || extraParams.call_type) session.callType = normalizeOutboundCallType(extraParams.callType || extraParams.call_type);
      if (extraParams.customerName) session.customerName = extraParams.customerName;
      if (extraParams.clientName) session.clientName = extraParams.clientName;
      await hydrateIcallMateSessionContext(session, message, extraParams);

      if (eventName === 'connected') {
        await upsertIcallMateCallFromMedia(message, session, { status: 'active', notes: 'iCallMate connected' });
        sendIcallMateMark(ws, message, 'connected-received');
        return;
      }

      if (eventName === 'start') {
        const mediaFormat = message.mediaFormat || {};
        const isExpectedAudio = (
          Number(mediaFormat.sampleRate) === 8000
          && String(mediaFormat.encoding || '').toUpperCase() === 'LINEAR16'
          && Number(mediaFormat.channels) === 1
          && Number(mediaFormat.bitsPerSample) === 16
        );

        await upsertIcallMateCallFromMedia(message, session, {
          status: 'active',
          notes: isExpectedAudio ? 'iCallMate media stream started' : 'iCallMate media stream started with unexpected audio format'
        });
        sendIcallMateMark(ws, message, 'start-received');

        if (!session.answered) {
          session.answered = true;
          await upsertIcallMateCallFromMedia(message, session, {
            status: 'active',
            answered_at: normalizeIcallTimestamp(message.timestamp),
            notes: session.callDirection === 'outbound' ? 'Outbound call answered via start event' : 'Incoming call answered via start event'
          });
          aiBridge.start();
          sendIcallMateMark(ws, message, 'answer-received');
        }
        return;
      }

      if (eventName === 'answer') {
        session.answered = true;
        await upsertIcallMateCallFromMedia(message, session, {
          status: 'active',
          answered_at: normalizeIcallTimestamp(message.timestamp),
          notes: session.callDirection === 'outbound' ? 'Outbound call answered' : 'Incoming call answered'
        });
        aiBridge.start();
        sendIcallMateMark(ws, message, 'answer-received');
        return;
      }

      if (eventName === 'media') {
        await upsertIcallMateCallFromMedia(message, session, {
          status: 'active',
          media_packets: 1,
          notes: session.answered ? 'Audio streaming' : 'Media before answer'
        });
        aiBridge.sendCallerAudio(message.payload);
        return;
      }

      if (eventName === 'hangup-call') {
        await upsertIcallMateCallFromMedia(message, session, {
          status: session.answered ? 'completed' : 'missed',
          ended_at: normalizeIcallTimestamp(message.timestamp),
          notes: session.answered ? 'Call disconnected' : 'Call missed'
        });
        // Persist transcript + update customer status before closing
        if (session.answered) {
          try {
            await aiBridge.persistCompletion('hangup_call_event');
          } catch (e) { console.error('[HANGUP PERSIST ERROR]', e.message); }

          // Fallback: save transcript directly if persistCompletion didn't run (e.g. incoming calls)
          if (session.callId) {
            const transcriptText = aiBridge.getTranscriptText();
            if (transcriptText) {
              try {
                await dbRun(
                  `UPDATE calls SET outcome = 'completed', transcript_text = COALESCE(NULLIF(?, ''), transcript_text), transcript_status = COALESCE(NULLIF(transcript_status, 'pending'), 'completed'), ended_at = COALESCE(ended_at, ?) WHERE id = ?`,
                  [transcriptText, new Date().toISOString(), session.callId]
                );
                console.log(`[TRANSCRIPT] Saved from hangup-call (callId=${session.callId}, length=${transcriptText.length})`);
              } catch (e) { console.error('[TRANSCRIPT SAVE ERROR]', e.message); }
            }
          }

          // Update customer status
          if (session.customerId) {
            try {
              await dbRun('UPDATE customers SET status = ?, last_called_at = ? WHERE id = ?',
                ['completed', new Date().toISOString(), session.customerId]);
              console.log(`[CALL STATUS] Calling -> Completed (hangup-call, customerId=${session.customerId})`);
            } catch (e) { console.error('[CALL STATUS UPDATE ERROR]', e.message); }
          }

          // Trigger post-call pipeline
          if (session.providerCallId) {
            runInBackground('HANGUP POST CALL PIPELINE', async () => {
              try {
                const result = await processCompletedCallPipeline({ dbGet, dbRun, callSid: session.providerCallId });
                if (result.ok) {
                  console.log(`[POST CALL PIPELINE] Processed hangup call ${session.providerCallId} feedbackId=${result.feedbackId}`);
                  console.log(`[TRANSCRIPT] Generated successfully`);
                  console.log(`[SUMMARY] Generated successfully`);
                  console.log(`[ANALYSIS] Generated successfully`);
                } else {
                  console.log(`[POST CALL PIPELINE] Skipped hangup call ${session.providerCallId}: ${result.reason}`);
                }
              } catch (e) { console.error('[HANGUP POST CALL PIPELINE ERROR]', e.message); }
            });
          }
        }
        sendReverseMediaStop(ws, session);
        aiBridge.close();
        ws.close();
        return;
      }

      if (eventName === 'mark') {
        console.log(`[ICALLMATE] Mark received: ${message?.mark?.name || message.sequenceNumber || 'mark'}`);
        return;
      }

      console.log(`[ICALLMATE] Unhandled event: ${eventName || 'unknown'}`);
    });

    ws.on('close', () => {
      console.log('[ICALLMATE] Media stream closed');
      aiBridge.close();
      if (session.streamId) {
        const closeTimestamp = new Date().toISOString();
        upsertIcallMateCallFromMedia({
          streamId: session.streamId,
          callerId: session.callerId,
          did: session.did,
          event: 'hangup-call',
          timestamp: closeTimestamp
        }, session, {
          status: session.answered ? 'completed' : 'missed',
          ended_at: closeTimestamp,
          notes: session.answered ? 'Call disconnected' : 'Call closed'
        }).then(async () => {
          // Safety net: save transcript if not already saved
          if (session.callId && session.answered) {
            const transcriptText = aiBridge.getTranscriptText();
            if (transcriptText) {
              try {
                await dbRun(
                  `UPDATE calls SET outcome = 'completed', transcript_text = COALESCE(NULLIF(?, ''), transcript_text), transcript_status = COALESCE(NULLIF(transcript_status, 'pending'), 'completed'), ended_at = COALESCE(ended_at, ?) WHERE id = ?`,
                  [transcriptText, closeTimestamp, session.callId]
                );
                console.log(`[TRANSCRIPT] Saved from ws close (callId=${session.callId}, length=${transcriptText.length})`);
              } catch (e) { console.error('[TRANSCRIPT SAVE ERROR ws close]', e.message); }
            }
          }
          // Safety net: update customer status if still 'called'
          if (session.customerId && session.answered) {
            try {
              await dbRun(
                `UPDATE customers SET status = CASE WHEN status = 'called' THEN 'completed' ELSE status END, last_called_at = ? WHERE id = ?`,
                [closeTimestamp, session.customerId]
              );
              console.log(`[CALL STATUS] Calling -> Completed (ws close, customerId=${session.customerId})`);
            } catch (e) { console.error('[CALL STATUS UPDATE ERROR ws close]', e.message); }
          }
          // Safety net: trigger post-call pipeline if not already triggered
          if (session.providerCallId && session.answered) {
            runInBackground('WS CLOSE POST CALL PIPELINE', async () => {
              try {
                const result = await processCompletedCallPipeline({ dbGet, dbRun, callSid: session.providerCallId });
                if (result.ok) {
                  console.log(`[POST CALL PIPELINE] Processed ws-close call ${session.providerCallId} feedbackId=${result.feedbackId}`);
                  console.log(`[TRANSCRIPT] Generated successfully`);
                  console.log(`[SUMMARY] Generated successfully`);
                  console.log(`[ANALYSIS] Generated successfully`);
                  console.log(`[UI] Analysis enabled`);
                } else {
                  console.log(`[POST CALL PIPELINE] Skipped ws-close call ${session.providerCallId}: ${result.reason}`);
                }
              } catch (e) { console.error('[WS CLOSE POST CALL PIPELINE ERROR]', e.message); }
            });
          }
        }).catch((e) => console.error('[WS CLOSE UPSERT ERROR]', e.message));
      }
    });

    ws.on('error', (error) => {
      console.error('[ICALLMATE WS ERROR]', error.message);
    });
  });

  return icallMateWss;
};

