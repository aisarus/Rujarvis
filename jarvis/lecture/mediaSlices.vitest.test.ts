import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { aacConfigFromEsds, adtsHeader, mediaSlices, nextFrameStart, readWavParts } from './mediaSlices';

const папки: string[] = [];
afterEach(async () => {
  for (const папка of папки.splice(0)) await rm(папка, { recursive: true, force: true });
});

describe('куски длинного файла', () => {
  it('заголовок ADTS: AAC-LC, 44,1 кГц, стерео, длина кадра с заголовком', () => {
    const h = adtsHeader({ objectType: 2, frequencyIndex: 4, channels: 2 }, 371);
    expect([...h]).toEqual([0xff, 0xf1, 0x50, 0x80, 0x2f, 0x5f, 0xfc]);
    // Длина — 13 бит в байтах 3–5: 371 + 7 = 378.
    const длина = (((h[3] ?? 0) & 0x03) << 11) | ((h[4] ?? 0) << 3) | ((h[5] ?? 0) >> 5);
    expect(длина).toBe(378);
  });

  it('AudioSpecificConfig — из дескрипторов esds', () => {
    // Версия+флаги, ES_Descriptor(03) → DecoderConfig(04, 13 байт) → DecoderSpecificInfo(05): 0x12 0x10 = AAC-LC, 44,1 кГц, стерео.
    const esds = Buffer.from([0, 0, 0, 0, 0x03, 0x19, 0x00, 0x01, 0x00, 0x04, 0x11, 0x40, 0x15, 0, 0, 0, 0, 0x01, 0xf4, 0, 0, 0x01, 0xf4, 0, 0x05, 0x02, 0x12, 0x10]);
    expect(aacConfigFromEsds(esds, 0, esds.length)).toEqual({ objectType: 2, frequencyIndex: 4, channels: 2 });
  });

  it('начало кадра MP3 и ADTS — по синхрослову, мимо случайных 0xFF', () => {
    const mp3 = new Uint8Array([0x00, 0xff, 0x00, 0x12, 0xff, 0xfb, 0x90, 0x64, 0x00]);
    expect(nextFrameStart(mp3, 0, 'mp3')).toBe(4);
    const adts = new Uint8Array([0x10, 0xff, 0xe0, 0x00, 0xff, 0xf1, 0x50, 0x80, 0x2f]);
    expect(nextFrameStart(adts, 0, 'adts')).toBe(4);
    expect(nextFrameStart(new Uint8Array([1, 2, 3, 4, 5, 6]), 0, 'mp3')).toBe(6);
  });

  it('WAV кусками: 24 бита, стерео — в один канал, без потерь по длине', async () => {
    const папка = await mkdtemp(path.join(tmpdir(), 'jarvis-slices-'));
    папки.push(папка);
    const частота = 8000;
    const кадров = частота * 25;
    const данные = Buffer.alloc(кадров * 6);
    for (let k = 0; k < кадров; k += 1) {
      данные.writeIntLE(Math.round(0.5 * 8388607), k * 6, 3);
      данные.writeIntLE(Math.round(-0.25 * 8388607), k * 6 + 3, 3);
    }
    const fmt = Buffer.alloc(16);
    fmt.writeUInt16LE(1, 0);
    fmt.writeUInt16LE(2, 2);
    fmt.writeUInt32LE(частота, 4);
    fmt.writeUInt32LE(частота * 6, 8);
    fmt.writeUInt16LE(6, 12);
    fmt.writeUInt16LE(24, 14);
    const head = Buffer.alloc(12);
    head.write('RIFF', 0, 'ascii');
    head.writeUInt32LE(4 + 8 + 16 + 8 + данные.length, 4);
    head.write('WAVE', 8, 'ascii');
    const файл = path.join(папка, 'x.wav');
    const chunk = (id: string, body: Buffer): Buffer => {
      const h = Buffer.alloc(8);
      h.write(id, 0, 'ascii');
      h.writeUInt32LE(body.length, 4);
      return Buffer.concat([h, body]);
    };
    await writeFile(файл, Buffer.concat([head, chunk('fmt ', fmt), chunk('data', данные)]));
    const части: number[] = [];
    let первый = 0;
    const секунд = await readWavParts(файл, (samples, rate) => {
      expect(rate).toBe(частота);
      if (части.length === 0) первый = samples[0] ?? 0;
      части.push(samples.length);
    }, 10);
    expect(секунд).toBe(25);
    expect(части).toEqual([80_000, 80_000, 40_000]);
    expect(первый).toBeCloseTo(0.125, 3);
  });

  it('формат, который не режется, раскрывается целиком (null); чужой контейнер без AAC — тоже', async () => {
    const папка = await mkdtemp(path.join(tmpdir(), 'jarvis-slices-'));
    папки.push(папка);
    const ogg = path.join(папка, 'a.ogg');
    await writeFile(ogg, Buffer.from('OggS'));
    expect(await mediaSlices(ogg)).toBeNull();
    const пустой = path.join(папка, 'a.mp4');
    await writeFile(пустой, Buffer.from([0, 0, 0, 8, 0x66, 0x72, 0x65, 0x65]));
    expect(await mediaSlices(пустой)).toBeNull();
  });
});
