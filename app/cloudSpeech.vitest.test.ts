import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { DEFAULT_SETTINGS, normaliseSettings } from '../jarvis/setup/settings';
import { cloudSpeechKey } from './cloudTranscriber';

/**
 * Облачное распознавание — только по явному переключателю.
 *
 * 26–27.09.2026 у владельца в переменных среды оказался ELEVENLABS_API_KEY,
 * и Джарвис сам поставил облако впереди Whisper: полтора дня около 800
 * отрезков звука с микрофона, 145 из них вовсе не Джарвису, ушли в
 * ElevenLabs, а настройки и шапка журнала показывали «whisper-small».
 */
describe('облако речи', () => {
  const сКлючом = { ELEVENLABS_API_KEY: 'sk-проба' } as NodeJS.ProcessEnv;

  it('ключ в системе без переключателя ничего не включает', () => {
    expect(cloudSpeechKey(false, сКлючом)).toBeNull();
  });

  it('переключатель без ключа — тоже нет, пустой ключ — тоже нет', () => {
    expect(cloudSpeechKey(true, {} as NodeJS.ProcessEnv)).toBeNull();
    expect(cloudSpeechKey(true, { ELEVENLABS_API_KEY: '   ' } as NodeJS.ProcessEnv)).toBeNull();
  });

  it('переключатель и ключ — облако', () => {
    expect(cloudSpeechKey(true, сКлючом)).toBe('sk-проба');
  });

  it('по умолчанию выключено, включается только явным true', () => {
    expect(DEFAULT_SETTINGS.cloudSpeech).toBe(false);
    expect(normaliseSettings({}).cloudSpeech).toBe(false);
    expect(normaliseSettings({ cloudSpeech: 'true' }).cloudSpeech).toBe(false);
    expect(normaliseSettings({ cloudSpeech: 1 }).cloudSpeech).toBe(false);
    expect(normaliseSettings({ cloudSpeech: true }).cloudSpeech).toBe(true);
  });

  it('ключ облака читает только cloudTranscriber.ts', () => {
    // Так облако и включалось мимо настроек: мост читал переменную сам.
    // Любое новое место, которое прочтёт её напрямую, снова откроет эту дверь.
    const корень = path.join(__dirname, '..');
    const нарушители: string[] = [];
    const обойти = (папка: string): void => {
      for (const имя of readdirSync(папка)) {
        const полный = path.join(папка, имя);
        if (statSync(полный).isDirectory()) {
          обойти(полный);
          continue;
        }
        if (!/\.(ts|js)$/u.test(имя) || /\.vitest\.test\.ts$/u.test(имя)) continue;
        if (полный === path.join(корень, 'app', 'cloudTranscriber.ts')) continue;
        // Чтение переменной, а не упоминание: имя ключа есть и в подсказке
        // окна настроек, и в журнале — это не дверь.
        if (/env(?:\.|\[\s*['"`])ELEVENLABS_API_KEY/u.test(readFileSync(полный, 'utf8'))) {
          нарушители.push(path.relative(корень, полный));
        }
      }
    };
    обойти(path.join(корень, 'app'));
    обойти(path.join(корень, 'jarvis'));
    expect(нарушители).toEqual([]);
  });
});
