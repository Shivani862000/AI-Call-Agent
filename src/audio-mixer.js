const fs = require('fs');

class AudioRecorder {
  constructor(callSid) {
    this.callSid = callSid;
    // 8000Hz * 2 bytes = 16000 bytes/sec
    // 15 minutes max = 15 * 60 * 16000 = 14,400,000 bytes
    this.mixedBuffer = Buffer.alloc(15 * 1024 * 1024);
    this.userOffset = 0;
    this.aiOffset = 0;
    this.maxOffset = 0;
  }

  addUserAudio(pcmBuffer8k) {
    if (this.userOffset + pcmBuffer8k.length > this.mixedBuffer.length) return; // Prevent overflow
    
    for (let i = 0; i < pcmBuffer8k.length; i += 2) {
       if (i + 1 >= pcmBuffer8k.length) break;
       let existing = this.mixedBuffer.readInt16LE(this.userOffset + i);
       let val = pcmBuffer8k.readInt16LE(i);
       let mixed = existing + val;
       if (mixed > 32767) mixed = 32767;
       if (mixed < -32768) mixed = -32768;
       this.mixedBuffer.writeInt16LE(mixed, this.userOffset + i);
    }
    this.userOffset += pcmBuffer8k.length;
    if (this.userOffset > this.maxOffset) this.maxOffset = this.userOffset;
  }

  addAiAudio(pcmBuffer8k) {
    // Sync AI offset to User offset if it has fallen behind (e.g. AI was silent)
    // This uses the continuous User audio as a master clock.
    if (this.aiOffset < this.userOffset) {
        this.aiOffset = this.userOffset; 
    }
    if (this.aiOffset + pcmBuffer8k.length > this.mixedBuffer.length) return;
    
    for (let i = 0; i < pcmBuffer8k.length; i += 2) {
       if (i + 1 >= pcmBuffer8k.length) break;
       let existing = this.mixedBuffer.readInt16LE(this.aiOffset + i);
       let val = pcmBuffer8k.readInt16LE(i);
       let mixed = existing + val;
       if (mixed > 32767) mixed = 32767;
       if (mixed < -32768) mixed = -32768;
       this.mixedBuffer.writeInt16LE(mixed, this.aiOffset + i);
    }
    this.aiOffset += pcmBuffer8k.length;
    if (this.aiOffset > this.maxOffset) this.maxOffset = this.aiOffset;
  }

  async saveToFile(filepath) {
    const finalData = this.mixedBuffer.subarray(0, this.maxOffset);
    const wavHeader = this.createWavHeader(finalData.length, 8000, 1, 16);
    const finalBuffer = Buffer.concat([wavHeader, finalData]);

    fs.writeFileSync(filepath, finalBuffer);
    console.log(`[AUDIO RECORDER] Saved mixed call audio to ${filepath} (Length: ${this.maxOffset} bytes)`);
  }

  createWavHeader(dataLength, sampleRate, numChannels, bitsPerSample) {
    const buffer = Buffer.alloc(44);
    buffer.write('RIFF', 0);
    buffer.writeUInt32LE(36 + dataLength, 4);
    buffer.write('WAVE', 8);
    buffer.write('fmt ', 12);
    buffer.writeUInt32LE(16, 16); // Subchunk1Size
    buffer.writeUInt16LE(1, 20); // AudioFormat (PCM)
    buffer.writeUInt16LE(numChannels, 22);
    buffer.writeUInt32LE(sampleRate, 24);
    buffer.writeUInt32LE(sampleRate * numChannels * (bitsPerSample / 8), 28); // ByteRate
    buffer.writeUInt16LE(numChannels * (bitsPerSample / 8), 32); // BlockAlign
    buffer.writeUInt16LE(bitsPerSample, 34);
    buffer.write('data', 36);
    buffer.writeUInt32LE(dataLength, 40);
    return buffer;
  }
}

module.exports = { AudioRecorder };
