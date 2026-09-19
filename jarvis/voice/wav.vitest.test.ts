import { describe, expect, it } from 'vitest';

import { encodeWav16 } from './wav';

describe('encodeWav16', () => {
  it('writes a header a recogniser will accept', () => {
    const wav = encodeWav16(new Float32Array(8), 16_000);

    expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
    expect(wav.toString('ascii', 8, 12)).toBe('WAVE');
    expect(wav.toString('ascii', 36, 40)).toBe('data');
    expect(wav.readUInt16LE(22)).toBe(1); // mono
    expect(wav.readUInt32LE(24)).toBe(16_000);
    expect(wav.readUInt16LE(34)).toBe(16); // bits per sample
  });

  it('declares sizes that match the bytes actually written', () => {
    // A wrong size here is the classic way to produce a file that plays as
    // silence or is rejected outright.
    const wav = encodeWav16(new Float32Array(100), 16_000);

    expect(wav.readUInt32LE(40)).toBe(200);
    expect(wav.readUInt32LE(4)).toBe(wav.length - 8);
    expect(wav.length).toBe(44 + 200);
  });

  it('keeps loud samples loud instead of wrapping them', () => {
    // Without clamping, 1.5 scales past the 16-bit maximum and wraps to a
    // large negative value — audible as a crack, and poison for recognition.
    const wav = encodeWav16(Float32Array.from([1, -1, 1.5, -1.5]), 16_000);

    expect(wav.readInt16LE(44)).toBe(32767);
    expect(wav.readInt16LE(46)).toBe(-32767);
    expect(wav.readInt16LE(48)).toBe(32767);
    expect(wav.readInt16LE(50)).toBe(-32767);
  });
});
