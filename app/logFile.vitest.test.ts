import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { startLogFile, пустаяЗапись } from './logFile';

describe('лог не пишет пустых строк', () => {
  it.each(['[jarvis] ', '[jarvis]', '', '   ', '[jarvis] [разговор] '])('«%s» — пусто', (текст) => {
    expect(пустаяЗапись(текст)).toBe(true);
  });

  it.each(['[jarvis] услышал: открой хром', 'просто текст', '[jarvis] [разговор] поднял сессию'])(
    '«%s» — запись',
    (текст) => {
      expect(пустаяЗапись(текст)).toBe(false);
    },
  );

  it('настоящий перехватчик: строка из одной метки в файл не попадает', () => {
    // 26.09.2026 за вечер в лог встало 73 строки `[jarvis] ` без текста —
    // подпись состояния «покой» пустая.
    const файл = path.join(mkdtempSync(path.join(os.tmpdir(), 'jarvis-log-')), 'jarvis.log');
    expect(startLogFile(файл)).toBe(файл);
    console.log('[jarvis] ');
    console.log('[jarvis] перебили — замолкаю');
    console.log('[jarvis] ');
    const строки = readFileSync(файл, 'utf8').split('\n').filter((с) => /INFO/u.test(с));
    expect(строки).toHaveLength(1);
    expect(строки[0]).toMatch(/перебили — замолкаю$/u);
  });
});
