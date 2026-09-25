import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { jarvisHome } from './paths';

/**
 * Домашнюю папку Джарвиса собирают в одном месте, а не где придётся.
 *
 * Семь модулей складывали её руками из `LOCALAPPDATA`, и на маке все семь
 * получали `~/AppData/Local/Rujarvis` — папку виндового вида, которой там не
 * бывает. Последствие было тихим и злым: окно читало настоящую
 * `~/Library/Application Support/Rujarvis`, а MCP-сервер писал в призрачную,
 * и план с заметками до человека не доезжали. Ни один тест этого не видел,
 * потому что проверяли каждый модуль по отдельности и всегда на Windows.
 *
 * Поэтому проверка смотрит НА ВЕСЬ исходник сразу: появится восьмое такое
 * место — она покраснеет, не дожидаясь мака.
 */
const КОРНИ = ['jarvis', 'app', 'scripts'];
const ЭТОТ_МОДУЛЬ = path.join('jarvis', 'setup', 'paths.ts');

function исходники(корень: string): string[] {
  const найдено: string[] = [];
  const обойти = (папка: string): void => {
    for (const имя of readdirSync(папка)) {
      const полный = path.join(папка, имя);
      if (имя === 'node_modules' || имя.startsWith('.')) continue;
      if (statSync(полный).isDirectory()) {
        обойти(полный);
        continue;
      }
      if (имя.endsWith('.ts') || имя.endsWith('.mjs') || имя.endsWith('.cjs')) найдено.push(полный);
    }
  };
  обойти(корень);
  return найдено;
}

describe('домашняя папка собирается только в paths.ts', () => {
  it('никто не складывает её из LOCALAPPDATA руками', () => {
    const виноватые: string[] = [];
    for (const корень of КОРНИ) {
      for (const файл of исходники(корень)) {
        if (файл.endsWith(ЭТОТ_МОДУЛЬ)) continue;
        if (файл.endsWith('.vitest.test.ts')) continue;
        // health.mjs зовут обычным node, без сборки TS, и импортировать ему
        // оттуда нечего: правило там повторено законно. Но повтор обязан
        // совпадать с оригиналом — это проверка ниже.
        if (файл.endsWith(path.join('scripts', 'health.mjs'))) continue;
        const текст = readFileSync(файл, 'utf8');
        // Признак — не само имя переменной (оно законно в путях к чужим
        // программам, как у Blender), а сборка домашней папки: запасной
        // 'AppData', 'Local' рядом с ней.
        if (/LOCALAPPDATA[\s\S]{0,80}'AppData',\s*'Local'/u.test(текст)) {
          виноватые.push(файл);
        }
      }
    }
    expect(виноватые, `собирают дом руками: ${виноватые.join(', ')}`).toEqual([]);
  });

  it('повтор правила в health.mjs не разошёлся с оригиналом', () => {
    // Скрипт здоровья живёт без сборки TS и потому носит копию правила.
    // Копия тихо стареет: paths.ts узнал про мак, а копия осталась виндовой —
    // и `jarvis:health` пошёл искать Джарвиса не там, где он стоит.
    // Сверяем по опорным точкам: каждая ветка оригинала должна быть и в копии.
    const оригинал = readFileSync(path.join('jarvis', 'setup', 'paths.ts'), 'utf8');
    const копия = readFileSync(path.join('scripts', 'health.mjs'), 'utf8');
    for (const веха of ['JARVIS_HOME', 'LOCALAPPDATA', 'Application Support', 'XDG_DATA_HOME', 'rujarvis']) {
      expect(оригинал, `опорной точки нет в оригинале: ${веха}`).toContain(веха);
      expect(копия, `правило в health.mjs отстало: нет ${веха}`).toContain(веха);
    }
  });

  it('на каждой платформе дом свой, а не виндовый везде', () => {
    // Числа не выдуманы: это то, куда кладут файлы сами системы.
    expect(jarvisHome({ LOCALAPPDATA: String.raw`C:\Users\u\AppData\Local` }, 'win32')).toBe(
      path.join(String.raw`C:\Users\u\AppData\Local`, 'Rujarvis'),
    );
    expect(jarvisHome({}, 'darwin')).toContain(path.join('Library', 'Application Support', 'Rujarvis'));
    expect(jarvisHome({}, 'darwin')).not.toContain('AppData');
    expect(jarvisHome({ XDG_DATA_HOME: '/x' }, 'linux')).toBe(path.join('/x', 'rujarvis'));
  });

  it('JARVIS_HOME переносит всё целиком на любой платформе', () => {
    for (const платформа of ['win32', 'darwin', 'linux'] as const) {
      expect(jarvisHome({ JARVIS_HOME: '/ушли/сюда' }, платформа)).toBe(path.resolve('/ушли/сюда'));
    }
  });
});
