import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { KEY_COMBOS } from '../control/commands';
import { keyScript, mediaKeyArgs } from './darwinDriver';

/**
 * Каждая клавиша из таблицы команд есть в словаре обоих драйверов.
 *
 * «Громче», «тише», «без звука», «следующий трек» жили в таблице команд, а в
 * словарях драйверов их не было: до 27.09.2026 каждая из этих фраз кончалась
 * «Неизвестная клавиша» и «Не получилось» — на Windows тоже (воспроизведено
 * настоящим путём). Разбор фразы проверялся, драйвер — нет, и шов между ними
 * не видел никто.
 */

/** Имена клавиш драйвера Windows — из таблицы $VK в самом скрипте. */
function клавишиWindows(): Set<string> {
  const скрипт = readFileSync(path.join(__dirname, 'win32-driver.ps1'), 'utf8');
  const таблица = /\$VK = @\{([\s\S]*?)\n\}/u.exec(скрипт)?.[1] ?? '';
  return new Set([...таблица.matchAll(/'([a-z0-9]+)'\s*=\s*0x[0-9A-Fa-f]+/gu)].map((m) => m[1] ?? ''));
}

/** Как Resolve-Key в win32-driver.ps1: имя из таблицы или одна буква/цифра. */
function windowsЗнает(часть: string, имена: Set<string>): boolean {
  return имена.has(часть) || /^[a-z0-9]$/u.test(часть);
}

describe('словари клавиш драйверов', () => {
  it('таблица $VK прочитана — иначе сверять не с чем', () => {
    const имена = клавишиWindows();
    expect(имена.has('enter')).toBe(true);
    expect(имена.size).toBeGreaterThan(30);
  });

  it('драйвер Windows знает каждую клавишу таблицы команд', () => {
    const имена = клавишиWindows();
    const неизвестные = KEY_COMBOS.filter((сочетание) =>
      сочетание.split('+').some((часть) => !windowsЗнает(часть.trim(), имена)),
    );
    expect(неизвестные).toEqual([]);
  });

  it('драйвер мака знает каждую клавишу таблицы команд', () => {
    const неизвестные = KEY_COMBOS.filter((сочетание) => {
      if (mediaKeyArgs(сочетание)) return false;
      try {
        keyScript(сочетание);
        return false;
      } catch {
        return true;
      }
    });
    expect(неизвестные).toEqual([]);
  });

  it('громкость на маке — set volume, плеер — системное событие NX_KEYTYPE', () => {
    // Медиа-событие громкость на маке CI не сдвинуло (100 → 100 → 100);
    // set volume читается обратно и проверяется.
    expect((mediaKeyArgs('volumeup') ?? []).join(' ')).toContain('set volume output volume');
    expect((mediaKeyArgs('volumemute') ?? []).join(' ')).toContain('output muted');
    const плеер = (mediaKeyArgs('playpause') ?? []).join(' ');
    expect(плеер).toContain('JavaScript');
    expect(плеер).toContain('(16 << 16)');
    expect(mediaKeyArgs('ctrl+c')).toBeNull();
  });
});
