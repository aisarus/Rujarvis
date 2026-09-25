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
