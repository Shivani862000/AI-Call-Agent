const WebSocket = require('ws');
const fs = require('fs');

const OUT_RAW = 'sim_icallmate_recv.raw';
const OUT_WAV = 'sim_icallmate_recv.wav';
const CHUNK_TIMEOUT_MS = 15000; // collect for 15s then finish

let chunks = [];

function writeWavFromPcm16(pcmBuffer, sampleRate = 8000, outPath = OUT_WAV) {
  const pcm = Buffer.isBuffer(pcmBuffer) ? pcmBuffer : Buffer.from(pcmBuffer || []);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  fs.writeFileSync(outPath, Buffer.concat([header, pcm]));
}

const wsUrl = process.env.SIM_WSURL || 'ws://localhost:3000/icallmate/media';
console.log('Connecting to', wsUrl);
const ws = new WebSocket(wsUrl);

ws.on('open', () => {
  console.log('WS OPEN');
  const connected = {
    event: 'connected',
    streamId: 'sim-1',
    callerId: 'sim-caller',
    did: '8037259753',
    extraParams: { callDirection: 'outbound', customerName: 'Local Test', clientName: 'LocalHost' }
  };
  ws.send(JSON.stringify(connected));
  setTimeout(() => {
    const answer = { event: 'answer', streamId: 'sim-1', callerId: 'sim-caller', did: '8037259753', timestamp: new Date().toISOString() };
    ws.send(JSON.stringify(answer));
    console.log('Sent answer, waiting for reverse-media...');
  }, 1000);

  // finish after timeout
  setTimeout(async () => {
    console.log('Timeout reached, assembling audio...');
    try {
      if (chunks.length) {
        const raw = Buffer.concat(chunks);
        fs.writeFileSync(OUT_RAW, raw);
        writeWavFromPcm16(raw, 8000, OUT_WAV);
        console.log('WAV written to', OUT_WAV);
      } else {
        console.log('No audio chunks received');
      }
    } catch (e) {
      console.error('Failed to write audio', e.message);
    }
    ws.close();
    process.exit(0);
  }, CHUNK_TIMEOUT_MS + 3000);
});

ws.on('message', (data) => {
  try {
    const msg = JSON.parse(data.toString());
    if (msg.event === 'reverse-media' && msg.payload) {
      const b = Buffer.from(msg.payload, 'base64');
      chunks.push(b);
      console.log('Received reverse-media chunk bytes=', b.length);
    } else if (msg.event === 'mark') {
      console.log('Received mark', msg.mark?.name || '');
    } else {
      console.log('WS MSG', Object.keys(msg));
    }
  } catch (e) {
    console.log('Non-JSON message', typeof data);
  }
});

ws.on('close', () => {
  console.log('WS closed');
});

ws.on('error', (err) => {
  console.error('WS error', err.message);
});
