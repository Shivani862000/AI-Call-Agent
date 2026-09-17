/**
 * src/agent-speech.js
 * What the agent actually said, and what to do when the caller talks over it.
 *
 * The model generates a line faster than it plays, so everything it generated
 * is not everything the caller heard. The tracker lines the generated words up
 * against the audio sent down the line, so an interrupted turn can be recorded
 * as far as it got.
 */

'use strict';

// Reverse media is 8 kHz, 16-bit mono.
const BYTES_PER_MS = 16;

// Speech that starts this close to the end of the agent's line is taken as a
// reply to it rather than talk over it.
const LINE_END_TAIL_MS = 700;

const FILLER_WORDS = new Set([
  'hello', 'helo', 'hallo', 'hellow', 'hi', 'hey',
  'hmm', 'hm', 'hmmm', 'umm', 'um', 'uh', 'aa',
  'हेलो', 'हैलो', 'हलो', 'हेल्लो', 'हम्म', 'हम'
]);

const ACKNOWLEDGEMENT_WORDS = new Set([
  'haan', 'han', 'haa', 'ha', 'haanji', 'hanji', 'ji', 'jee',
  'achha', 'acha', 'accha', 'achcha', 'ok', 'okay', 'theek', 'thik', 'hai', 'sahi',
  'हां', 'हाँ', 'हा', 'जी', 'अच्छा', 'ओके', 'ठीक', 'है', 'सही'
]);

function words(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[.,!?।"'`…-]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

function isFillerOnly(text) {
  const said = words(text);
  return said.length > 0 && said.every((word) => FILLER_WORDS.has(word));
}

/** "Haan ji", "achha", "theek hai" -- listening noises, possibly with a hello. */
function isAcknowledgementOnly(text) {
  const said = words(text);
  return said.length > 0
    && !isFillerOnly(text)
    && said.every((word) => ACKNOWLEDGEMENT_WORDS.has(word) || FILLER_WORDS.has(word));
}

/**
 * Whether the caller's speech should cut the agent off.
 *
 * Callers on a mobile line say "hello hello" while the agent is talking to
 * check it is still there. Stopping for that means they never hear the line
 * that would have answered them.
 */
function decideBargeIn({ callerText, agentRemainingMs = 0, protectedTurn = false } = {}) {
  if (!(agentRemainingMs > 0)) return { stopAgent: false, reason: 'agent_silent' };
  if (protectedTurn) return { stopAgent: false, reason: 'protected_turn' };
  if (isFillerOnly(callerText)) return { stopAgent: false, reason: 'filler' };
  if (isAcknowledgementOnly(callerText)) return { stopAgent: false, reason: 'acknowledgement' };
  return { stopAgent: true, reason: 'barge_in' };
}

/**
 * What to do with a finished caller utterance.
 *
 *   drop     -- a hello said over the agent; the rest of the line answers it
 *   defer    -- the agent is still talking; hand it over once the line ends
 *   dispatch -- take it now
 */
function decideCallerTurn({ callerText, remainingMsAtSpeechStart = 0, agentRemainingMs = 0 } = {}) {
  const saidOverAgent = remainingMsAtSpeechStart > LINE_END_TAIL_MS;
  if (saidOverAgent && isFillerOnly(callerText)) return 'drop';
  if (agentRemainingMs > 0) return 'defer';
  return 'dispatch';
}

function joinText(parts) {
  return parts.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}

/**
 * One agent turn at a time: the text fragments, where in the audio each one
 * arrived, how much audio was generated and how much was sent.
 *
 * Alignment is by arrival order, so it is word-level approximate: a fragment
 * is taken to cover the audio from where it arrived up to the next fragment.
 */
function createAgentSpeechTracker() {
  let turn = null;
  let turns = 0;
  let interrupted = 0;

  function ensureTurn() {
    if (!turn) {
      turn = { segments: [], generatedBytes: 0, sentBytes: 0, generationComplete: false };
      turns += 1;
    }
    return turn;
  }

  function split() {
    const spoken = [];
    const unspoken = [];
    turn.segments.forEach((segment, index) => {
      const start = segment.atBytes;
      const next = turn.segments[index + 1];
      const end = next ? next.atBytes : turn.generatedBytes;
      const segmentWords = segment.text.split(/\s+/).filter(Boolean);

      let fraction;
      if (turn.sentBytes <= start) fraction = 0;
      else if (turn.sentBytes >= end) fraction = 1;
      else fraction = (turn.sentBytes - start) / (end - start);

      const count = Math.floor(segmentWords.length * fraction);
      spoken.push(segmentWords.slice(0, count).join(' '));
      unspoken.push(segmentWords.slice(count).join(' '));
    });
    return { spokenText: joinText(spoken), unspokenText: joinText(unspoken) };
  }

  return {
    addText(text) {
      const clean = String(text || '').replace(/\s+/g, ' ').trim();
      if (!clean) return;
      const current = ensureTurn();
      current.segments.push({ text: clean, atBytes: current.generatedBytes });
    },
    addAudio(byteCount) {
      if (!(byteCount > 0)) return;
      ensureTurn().generatedBytes += byteCount;
    },
    markSent(byteCount) {
      if (!turn || !(byteCount > 0)) return;
      turn.sentBytes = Math.min(turn.generatedBytes, turn.sentBytes + byteCount);
    },
    markGenerationComplete() {
      if (turn) turn.generationComplete = true;
    },
    isActive() {
      return Boolean(turn);
    },
    isGenerating() {
      return Boolean(turn && !turn.generationComplete);
    },
    remainingMs() {
      return turn ? Math.round((turn.generatedBytes - turn.sentBytes) / BYTES_PER_MS) : 0;
    },
    /** The line played out. Returns what was said, or null if no turn was open. */
    finish() {
      if (!turn) return null;
      const done = {
        text: joinText(turn.segments.map((segment) => segment.text)),
        playedMs: Math.round(turn.sentBytes / BYTES_PER_MS)
      };
      turn = null;
      return done;
    },
    /**
     * The caller cut the line off. Returns how far it got, or null when
     * there was nothing still to play.
     */
    interrupt() {
      if (!turn) return null;
      if (turn.generationComplete && turn.sentBytes >= turn.generatedBytes) {
        this.finish();
        return null;
      }
      const cut = {
        ...split(),
        playedMs: Math.round(turn.sentBytes / BYTES_PER_MS),
        totalMs: Math.round(turn.generatedBytes / BYTES_PER_MS),
        generationComplete: turn.generationComplete
      };
      interrupted += 1;
      turn = null;
      return cut;
    },
    stats() {
      return { turns, interrupted };
    }
  };
}

module.exports = {
  BYTES_PER_MS,
  LINE_END_TAIL_MS,
  createAgentSpeechTracker,
  isFillerOnly,
  isAcknowledgementOnly,
  decideBargeIn,
  decideCallerTurn
};
