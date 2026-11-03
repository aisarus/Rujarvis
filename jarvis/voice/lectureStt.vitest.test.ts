import { mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { GPU_WHISPER_MODEL, GPU_WHISPER_RUNTIME, LECTURE_MODELS } from './gpuWhisper';
import { detectGpu, lectureSttStatus } from './lectureStt';

const папки: string[] = [];
afterEach(() => {
  for (const п of папки.splice(0)) rmSync(п, { recursive: true, force: true });
});

function временная(): string {
  const п = mkdtempSync(path.join(tmpdir(), 'jarvis-lecture-stt-'));
  папки.push(п);
  return п;
}

describe('распознавание лекций в настройках', () => {
  it('видеокарта NVIDIA — по nvidia-smi её драйвера; мак — Metal', () => {
    expect(detectGpu('win32', (f) => f.toLowerCase().endsWith('system32\\nvidia-smi.exe'))).toBe('nvidia');
    expect(detectGpu('win32', () => false)).toBe('none');
    expect(detectGpu('darwin', () => false)).toBe('metal');
    expect(detectGpu('linux', () => true)).toBe('unknown');
  });

  it('ничего не стоит — конспекта не будет, и названо, сколько качать', async () => {
    const dir = временная();
    expect(await lectureSttStatus(dir, 'he', 'win32')).toMatchObject({
      supported: true,
      runtime: false,
      model: false,
      modelFile: LECTURE_MODELS.byLanguage.he!.file,
      missingBytes: GPU_WHISPER_RUNTIME.bytes + GPU_WHISPER_MODEL.bytes + LECTURE_MODELS.byLanguage.he!.bytes,
    });
    expect(await lectureSttStatus(dir, 'ru', 'linux')).toMatchObject({ supported: false, runtime: false });
  });

  it('программа и общая модель стоят — лекция расшифровывается; модель для лекций — сверху', async () => {
    const dir = временная();
    mkdirSync(path.join(dir, 'runtime', 'Release'), { recursive: true });
    writeFileSync(path.join(dir, 'runtime', 'Release', 'whisper-server.exe'), '');
    const общая = path.join(dir, GPU_WHISPER_MODEL.file);
    writeFileSync(общая, '');
    truncateSync(общая, GPU_WHISPER_MODEL.bytes);
    expect(await lectureSttStatus(dir, 'ru', 'win32')).toMatchObject({ runtime: true, model: false, missingBytes: LECTURE_MODELS.general.bytes });
    writeFileSync(path.join(dir, LECTURE_MODELS.general.file), 'модель');
    expect(await lectureSttStatus(dir, 'ru', 'win32')).toMatchObject({ runtime: true, model: true, missingBytes: 0 });
    // Для иврита общая модель — не его: своя точнее, её и предлагаем.
    expect(await lectureSttStatus(dir, 'he', 'win32')).toMatchObject({ runtime: true, model: false, missingBytes: LECTURE_MODELS.byLanguage.he!.bytes });
  });
});
