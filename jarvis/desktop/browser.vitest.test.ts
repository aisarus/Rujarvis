import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { PROFILE_DIR, браузераНет, порядокКаналов } from './browser';
import { jarvisHome } from '../setup/paths';

/**
 * Вкладки на чужой машине.
 *
 * Два обстоятельства встретились и закрыли вкладки на маке наглухо: браузер
 * просился по каналу `msedge`, которого на маке обычно нет, а профиль
 * складывался в путь виндового вида. Playwright на отсутствующий канал не
 * падает понятно — он выдаёт стену логов, из которой человеку ничего не
 * ясно.
 */
describe('порядокКаналов', () => {
  it('названный идёт первым: его выбрал человек', () => {
    expect(порядокКаналов('chrome')[0]).toBe('chrome');
    expect(порядокКаналов('msedge')[0]).toBe('msedge');
  });

  it('не повторяет названный в запасных', () => {
    const порядок = порядокКаналов('chrome');
    expect(порядок.filter((имя) => имя === 'chrome')).toHaveLength(1);
  });

  it('последним оставляет chromium: его Playwright носит с собой', () => {
    // Если на машине нет ни Edge, ни Chrome, остаётся то, что можно скачать
    // самим. Без этой ступеньки вкладок на чистом маке не будет вовсе.
    expect(порядокКаналов('msedge').at(-1)).toBe('chromium');
    expect(порядокКаналов('chromium')).toContain('chrome');
  });

  it('чужой канал из настроек не теряет запасных', () => {
    // Человек мог указать что-то своё; перебор обязан продолжиться.
    const порядок = порядокКаналов('msedge-beta');
    expect(порядок[0]).toBe('msedge-beta');
    expect(порядок).toEqual(['msedge-beta', 'msedge', 'chrome', 'chromium']);
  });
});

describe('браузераНет', () => {
  it('узнаёт отсутствующий браузер по тому, как о нём говорит Playwright', () => {
    // Дословно из ответов Playwright — выдумывать эти строки нельзя.
    for (const текст of [
      "Chromium distribution 'msedge' is not found at /Applications/Microsoft Edge.app",
      'Failed to launch chromium because executable doesn’t exist at /path/chrome',
      'spawn /usr/bin/chrome ENOENT: No such file or directory',
    ]) {
      expect(браузераНет(new Error(текст)), текст).toBe(true);
    }
  });

  it('не принимает за отсутствие всё подряд', () => {
    // На эти беды пробовать следующий браузер нельзя: человек молча уехал бы
    // в другой движок с другим входом, а причина осталась бы скрытой.
    for (const текст of [
      'Target page, context or browser has been closed',
      'browserContext.newPage: Timeout 30000ms exceeded',
      'net::ERR_CONNECTION_REFUSED',
    ]) {
      expect(браузераНет(new Error(текст)), текст).toBe(false);
    }
  });
});

describe('PROFILE_DIR', () => {
  it('лежит внутри папки Джарвиса, а не рядом с ней', () => {
    // Раньше путь собирался из LOCALAPPDATA руками и на маке давал
    // ~/AppData/Local/Rujarvis — снаружи дома, где его не видит ни
    // установщик, ни уборка, ни сам человек.
    expect(PROFILE_DIR.startsWith(jarvisHome())).toBe(true);
    expect(path.basename(PROFILE_DIR).startsWith('browser-profile-')).toBe(true);
  });
});
