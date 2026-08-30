'use strict';

/**
 * Buffered, fire-and-forget writer for system_logs.
 *
 * logger.info() is called during live calls and must never await a network
 * round-trip, so push() only appends to an in-memory buffer. Rows leave in
 * batches on a timer or when the batch size is reached. A failing write drops
 * its batch: losing log lines is strictly better than breaking a call or
 * growing memory without bound during an outage.
 */
function createLogSink({ write, maxBatch = 50, maxBuffer = 1000, intervalMs = 2000 } = {}) {
  let buffer = [];
  let droppedCount = 0;
  let timer = null;
  let flushing = false;

  async function flush() {
    if (flushing || buffer.length === 0) return;
    flushing = true;
    const batch = buffer;
    buffer = [];
    try {
      await write(batch);
    } catch (error) {
      // Deliberately swallowed. The console already has these lines, and a
      // logging failure must never surface as an application failure.
      console.error('[LOG SINK] dropped', batch.length, 'rows:', error.message);
    } finally {
      flushing = false;
    }
  }

  function push(row) {
    // Stamped here, not by the database: `default now()` is transaction time,
    // so every row in a flushed batch would share the flush timestamp and
    // within-batch ordering would be lost.
    buffer.push({ ts: new Date(), ...row });

    if (buffer.length > maxBuffer) {
      droppedCount += buffer.length - maxBuffer;
      buffer = buffer.slice(-maxBuffer);
    }

    if (buffer.length >= maxBatch) {
      setImmediate(() => { flush(); });
      return;
    }

    if (!timer) {
      timer = setTimeout(() => { timer = null; flush(); }, intervalMs);
      timer.unref?.();
    }
  }

  return {
    push,
    flush,
    pending: () => buffer.length,
    dropped: () => droppedCount,
    stop: () => { if (timer) { clearTimeout(timer); timer = null; } }
  };
}

module.exports = { createLogSink };
