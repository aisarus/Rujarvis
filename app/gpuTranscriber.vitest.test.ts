import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { createGpuTranscriber } from './gpuTranscriber';

let сервер: Server | null = null;
afterEach(async () => {
  await new Promise<void>((resolve) => (сервер ? сервер.close(() => resolve()) : resolve()));
  сервер = null;
});

/** Отвечает так, как отвечает whisper-server: текст сегментов, каждый — с переводом строки после. */
async function whisperServer(text: string): Promise<string> {
  сервер = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ text }));
    });
  });
  await new Promise<void>((resolve) => сервер?.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(сервер?.address() as AddressInfo).port}`;
}

describe('распознавание через сервер whisper.cpp', () => {
  it('сегмент, кончившийся посреди слова, не рвёт слово (лекция на иврите, 29.09.2026)', async () => {
    const endpoint = await whisperServer(' בעצם שקולה לתנועה הרמ\nונית.\n');
    const { text } = await createGpuTranscriber({ endpoint, language: 'he' }).transcribe(new Float32Array(1600), 16_000);
    expect(text).toBe('בעצם שקולה לתנועה הרמונית.');
  });

  it('между сегментами-словами остаётся пробел: он стоит в начале сегмента', async () => {
    const endpoint = await whisperServer(' Поставь громкость\n на семьдесят\n.\n');
    const { text } = await createGpuTranscriber({ endpoint }).transcribe(new Float32Array(1600), 16_000);
    expect(text).toBe('Поставь громкость на семьдесят.');
  });
});
