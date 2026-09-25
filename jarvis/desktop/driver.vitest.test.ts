import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));

describe('драйвер рабочего стола', () => {
  it('находит свой PowerShell-скрипт', () => {
    // Путь вычисляется в самом модуле; если он перестанет находиться, клики и
    // нажатия молча перестанут работать.
    expect(existsSync(path.join(here, 'win32-driver.ps1'))).toBe(true);
  });

  it('не зависит от import.meta — он попадает в CJS-сборку приложения', () => {
    // Этот модуль живёт в двух мирах: в MCP-сервере как ESM и в сборке
    // Electron как CJS. Во втором `import.meta.url` пустой, и обращение к нему
    // роняет модуль при загрузке — вместе со всем голосовым слоем. Однажды это
    // уже случилось: Джарвис перестал запускаться целиком.
    const source = readFileSync(path.join(here, 'driver.ts'), 'utf8');
    // Комментарии не считаются: в них про эту ловушку как раз и написано.
    const code = source.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/\/\/.*$/gmu, '');
    expect(code).not.toContain('import.meta');
  });
});
