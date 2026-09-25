/**
 * Что распознаватель делает с потоком, который умер или завис.
 *
 * Замечание CodeRabbit (кусок 4, PR №43): после сбоя запись о потоке
 * оставалась в кэше, и каждая следующая фраза уходила в мёртвый поток, чтобы
 * через тридцать секунд получить «не уложилось». Джарвис становился глухим до
 * перезапуска, а человеку это выглядело как «просто перестал слышать».
 */

import { describe, expect, it } from 'vitest';

import {
  RecognitionTimeout,
  WhisperRecognizer,
  type RecognitionWorker,
  type RecognitionWorkerFactory,
} from './whisperRecognizer';

const звук = (): Float32Array => new Float32Array(16_000);

/** Считает, сколько раз пришлось заводить поток заново. */
function стенд(поток: () => RecognitionWorker): { фабрика: RecognitionWorkerFactory; заводов: () => number } {
  let заводов = 0;
  const фабрика: RecognitionWorkerFactory = async () => {
    заводов += 1;
    return поток();
  };
  return { фабрика, заводов: () => заводов };
}

function распознаватель(фабрика: RecognitionWorkerFactory, timeoutMs = 20): WhisperRecognizer {
  return new WhisperRecognizer({ installRoot: 'C:/nowhere', timeoutMs }, фабрика);
}

describe('распознавание после сбоя потока', () => {
  it('зависший поток выбрасывается, и следующая фраза заводит новый', async () => {
    let погашено = 0;
    const { фабрика, заводов } = стенд(() => ({
      transcribe: () => new Promise<string>(() => undefined), // никогда
      dispose: async () => {
        погашено += 1;
      },
    }));
    const ухо = распознаватель(фабрика);

    await expect(ухо.transcribe(звук(), 16_000)).rejects.toBeInstanceOf(RecognitionTimeout);
    expect(погашено).toBe(1);

    await expect(ухо.transcribe(звук(), 16_000)).rejects.toBeInstanceOf(RecognitionTimeout);
    // Второй завод — главное: без него все следующие фразы уходили в тот же
    // занятый навсегда поток.
    expect(заводов()).toBe(2);
  });

  it('умерший поток выбрасывается, даже если ответил быстро', async () => {
    let жив = true;
    const { фабрика, заводов } = стенд(() => ({
      transcribe: async () => {
        жив = false;
        throw new Error('поток упал');
      },
      isAlive: () => жив,
      dispose: async () => undefined,
    }));
    const ухо = распознаватель(фабрика);

    await expect(ухо.transcribe(звук(), 16_000)).rejects.toThrow('поток упал');
    await expect(ухо.transcribe(звук(), 16_000)).rejects.toThrow('поток упал');
    expect(заводов()).toBe(2);
  });

  it('неразобранная фраза прогретый поток не теряет', async () => {
    const { фабрика, заводов } = стенд(() => ({
      transcribe: async () => {
        throw new Error('не смог разобрать');
      },
      isAlive: () => true,
      dispose: async () => undefined,
    }));
    const ухо = распознаватель(фабрика);

    await expect(ухо.transcribe(звук(), 16_000)).rejects.toThrow('не смог разобрать');
    await expect(ухо.transcribe(звук(), 16_000)).rejects.toThrow('не смог разобрать');
    // Один завод: терять прогретую модель (это секунды) из-за одной фразы
    // незачем.
    expect(заводов()).toBe(1);
  });
});
