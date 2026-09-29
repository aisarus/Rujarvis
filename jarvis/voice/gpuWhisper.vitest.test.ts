import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { findGpuWhisper, serverArgs, sha256, startGpuWhisper } from './gpuWhisper';

const папки: string[] = [];
afterEach(async () => {
  for (const папка of папки.splice(0)) await rm(папка, { recursive: true, force: true });
});

async function временная(): Promise<string> {
  const папка = await mkdtemp(path.join(tmpdir(), 'jarvis-gpu-'));
  папки.push(папка);
  return папка;
}

async function свободныйПорт(): Promise<number> {
  return new Promise((resolve, reject) => {
    const сервер = createServer();
    сервер.once('error', reject);
    сервер.listen(0, '127.0.0.1', () => {
      const адрес = сервер.address();
      сервер.close(() => resolve(typeof адрес === 'object' && адрес ? адрес.port : 0));
    });
  });
}

const отвечает = async (endpoint: string): Promise<boolean> => {
  try {
    return (await fetch(`${endpoint}/`)).ok;
  } catch {
    return false;
  }
};

describe('установленное распознавание на видеокарте', () => {
  // Раскладка Windows: на маке сервер ставит Homebrew, и папка runtime не смотрится
  // вовсе. Платформа — явно, иначе на маке CI тест искал бы Homebrew.
  it('находит сервер во вложенной папке архива и модель нужного размера', async () => {
    const dir = await временная();
    await mkdir(path.join(dir, 'runtime', 'Release'), { recursive: true });
    await writeFile(path.join(dir, 'runtime', 'Release', 'whisper-server.exe'), '');
    const модель = { file: 'ggml-small-q8_0.bin', bytes: 5 };
    expect(await findGpuWhisper(dir, модель, 'win32')).toBeNull();

    await writeFile(path.join(dir, модель.file), '1234');
    expect(await findGpuWhisper(dir, модель, 'win32')).toBeNull();

    await writeFile(path.join(dir, модель.file), '12345');
    expect(await findGpuWhisper(dir, модель, 'win32')).toEqual({
      server: path.join(dir, 'runtime', 'Release', 'whisper-server.exe'),
      model: path.join(dir, модель.file),
    });
  });

  it('сервер слушает только этот компьютер', () => {
    const args = serverArgs({ server: 'whisper-server.exe', model: 'm.bin' }, 8178);
    expect(args).toEqual(expect.arrayContaining(['--host', '127.0.0.1', '--port', '8178', '-m', 'm.bin']));
  });

  it('контрольная сумма — sha256 содержимого', async () => {
    const dir = await временная();
    const файл = path.join(dir, 'x.bin');
    await writeFile(файл, 'abc');
    expect(await sha256(файл)).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

describe('запуск своего сервера', () => {
  it('дожидается ответа, знает свой pid и гасит ровно его', async () => {
    const port = await свободныйПорт();
    const код = `require('http').createServer((q, r) => r.end('ok')).listen(${port}, '127.0.0.1')`;
    const сервер = await startGpuWhisper(
      { server: process.execPath, model: 'не нужна' },
      { port, isReady: отвечает, readyMs: 15_000, command: { file: process.execPath, args: ['-e', код] } },
    );
    try {
      expect(сервер.endpoint).toBe(`http://127.0.0.1:${port}`);
      expect(сервер.pid).toBeGreaterThan(0);
      expect(await отвечает(сервер.endpoint)).toBe(true);
    } finally {
      сервер.stop();
    }
    // Погашен свой процесс — порт больше не отвечает.
    let ещёЖив = true;
    for (let i = 0; i < 30 && ещёЖив; i += 1) {
      ещёЖив = await отвечает(сервер.endpoint);
      if (ещёЖив) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(ещёЖив).toBe(false);
  });

  it('что с видеокартой — в журнал при запуске, а не на каждый запрос (журнал 29.09.2026)', async () => {
    const port = await свободныйПорт();
    const код = [
      "console.error('ggml_cuda_init: found 1 CUDA devices');",
      `require('http').createServer((q, r) => { console.error('system_info: CUDA : ARCHS = 860'); r.end('ok'); }).listen(${port}, '127.0.0.1');`,
    ].join(' ');
    const журнал: string[] = [];
    const сервер = await startGpuWhisper(
      { server: process.execPath, model: 'не нужна' },
      { port, isReady: отвечает, readyMs: 15_000, log: (строка) => журнал.push(строка), command: { file: process.execPath, args: ['-e', код] } },
    );
    try {
      const при_запуске = журнал.length;
      expect(журнал.some((с) => с.includes('found 1 CUDA devices'))).toBe(true);
      for (let i = 0; i < 3; i += 1) await fetch(`${сервер.endpoint}/`);
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(журнал.length).toBe(при_запуске);
    } finally {
      сервер.stop();
    }
  });

  it('упавший до готовности сервер — ошибка с кодом выхода, а не вечное ожидание', async () => {
    const port = await свободныйПорт();
    await expect(
      startGpuWhisper(
        { server: process.execPath, model: 'не нужна' },
        {
          port,
          isReady: отвечает,
          readyMs: 15_000,
          command: { file: process.execPath, args: ['-e', "console.error('ggml_cuda_init: no CUDA devices'); process.exit(3)"] },
        },
      ),
    ).rejects.toThrow(/вышел с кодом 3.*no CUDA devices/u);
  });
});
