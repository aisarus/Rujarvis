/**
 * Wrapping captured samples in a WAV container.
 *
 * Recognisers that take a file rather than an array all accept 16-bit PCM,
 * so this is the one format worth writing.
 */

/** Bytes of a mono 16-bit PCM WAV holding these samples. */
export function encodeWav16(samples: Float32Array, sampleRate: number): Buffer {
  const dataBytes = samples.length * 2;
  const header = Buffer.alloc(44);

  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16); // PCM chunk size
  header.writeUInt16LE(1, 20); // format: PCM
  header.writeUInt16LE(1, 22); // channels: mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); // byte rate
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(dataBytes, 40);

  const body = Buffer.alloc(dataBytes);
  for (let i = 0; i < samples.length; i += 1) {
    // Clamp before scaling: a sample just outside [-1, 1] would wrap around
    // into loud noise at the opposite polarity.
    const clamped = Math.max(-1, Math.min(1, samples[i] as number));
    body.writeInt16LE(Math.round(clamped * 32767), i * 2);
  }

  return Buffer.concat([header, body]);
}

/**
 * WAV → samples of one channel. 16-bit PCM or 32-bit float, any channel
 * count: a recording from a phone or another program is rarely laid out the
 * way Piper writes it, and chunks other than "fmt " and "data" are skipped.
 */
export function decodeWav(wav: Buffer): { samples: Float32Array; sampleRate: number } {
  if (wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') throw new Error('not a WAV file');
  let format = 0;
  let channels = 1;
  let sampleRate = 16_000;
  let bits = 16;
  let data: Buffer | null = null;
  for (let at = 12; at + 8 <= wav.length; ) {
    const id = wav.toString('ascii', at, at + 4);
    const size = wav.readUInt32LE(at + 4);
    const body = wav.subarray(at + 8, Math.min(wav.length, at + 8 + size));
    if (id === 'fmt ') {
      format = body.readUInt16LE(0);
      channels = body.readUInt16LE(2);
      sampleRate = body.readUInt32LE(4);
      bits = body.readUInt16LE(14);
      // WAVE_FORMAT_EXTENSIBLE keeps the real format in the sub-format GUID.
      if (format === 0xfffe && body.length >= 26) format = body.readUInt16LE(24);
    } else if (id === 'data') {
      data = body;
    }
    at += 8 + size + (size % 2);
  }
  if (!data) throw new Error('WAV has no data chunk');
  if (!((format === 1 && bits === 16) || (format === 3 && bits === 32))) {
    throw new Error(`WAV format ${format} with ${bits} bits: need 16-bit PCM or 32-bit float`);
  }
  const frame = (bits / 8) * channels;
  const count = Math.floor(data.length / frame);
  const samples = new Float32Array(count);
  for (let i = 0; i < count; i += 1) {
    let sum = 0;
    for (let c = 0; c < channels; c += 1) {
      const at = i * frame + (c * bits) / 8;
      sum += format === 1 ? data.readInt16LE(at) / 0x8000 : data.readFloatLE(at);
    }
    samples[i] = sum / channels;
  }
  return { samples, sampleRate };
}

/** Linear resampling to 16 kHz: what whisper expects and what the microphone page records. */
export function resampleTo16k(samples: Float32Array, sampleRate: number): Float32Array {
  if (sampleRate === 16_000) return samples;
  const out = new Float32Array(Math.floor((samples.length * 16_000) / sampleRate));
  for (let i = 0; i < out.length; i += 1) {
    const x = (i * sampleRate) / 16_000;
    const a = Math.floor(x);
    const t = x - a;
    out[i] = (samples[a] ?? 0) * (1 - t) + (samples[a + 1] ?? samples[a] ?? 0) * t;
  }
  return out;
}
