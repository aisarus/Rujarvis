import { describe, expect, it } from 'vitest';

import { decodeWav, encodeWav16, resampleTo16k } from './wav';

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

describe('decodeWav', () => {
  it('reads back what encodeWav16 wrote', () => {
    const { samples, sampleRate } = decodeWav(encodeWav16(Float32Array.from([0, 0.5, -0.5]), 22_050));
    expect(sampleRate).toBe(22_050);
    expect(Array.from(samples, (x) => Math.round(x * 100) / 100)).toEqual([0, 0.5, -0.5]);
  });

  it('mixes stereo float down to one channel and skips foreign chunks', () => {
    // A phone or an editor writes float, two channels and a LIST chunk
    // before the sound — reading "data" at byte 44 would read the tags.
    const fmt = Buffer.alloc(24);
    fmt.write('fmt ', 0, 'ascii');
    fmt.writeUInt32LE(16, 4);
    fmt.writeUInt16LE(3, 8); // float
    fmt.writeUInt16LE(2, 10); // stereo
    fmt.writeUInt32LE(48_000, 12);
    fmt.writeUInt32LE(48_000 * 8, 16);
    fmt.writeUInt16LE(8, 20);
    fmt.writeUInt16LE(32, 22);
    const list = Buffer.concat([Buffer.from('LIST', 'ascii'), Buffer.from([3, 0, 0, 0]), Buffer.from('abc\0', 'ascii')]);
    const body = Buffer.alloc(16);
    [0.2, 0.4, -1, 0].forEach((x, i) => body.writeFloatLE(x, i * 4));
    const data = Buffer.concat([Buffer.from('data', 'ascii'), Buffer.from([16, 0, 0, 0]), body]);
    const head = Buffer.alloc(12);
    head.write('RIFF', 0, 'ascii');
    head.writeUInt32LE(4 + fmt.length + list.length + data.length, 4);
    head.write('WAVE', 8, 'ascii');

    const { samples, sampleRate } = decodeWav(Buffer.concat([head, fmt, list, data]));
    expect(sampleRate).toBe(48_000);
    expect(Array.from(samples, (x) => Math.round(x * 100) / 100)).toEqual([0.3, -0.5]);
  });

  it('says what it cannot read instead of returning noise', () => {
    expect(() => decodeWav(Buffer.from('not a wav at all, just text'))).toThrow(/not a WAV/u);
  });
});

describe('resampleTo16k', () => {
  it('keeps the duration', () => {
    expect(resampleTo16k(new Float32Array(48_000), 48_000)).toHaveLength(16_000);
    const same = new Float32Array(10);
    expect(resampleTo16k(same, 16_000)).toBe(same);
  });
});
