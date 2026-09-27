import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));

import { DesktopDriver, driverScriptPath } from './driver';

describe('драйвер рабочего стола', () => {
  it('находит свой PowerShell-скрипт', () => {
    // Спрашиваем САМ МОДУЛЬ, а не файловую систему.
    //
    // Раньше проверялось только то, что файл лежит рядом с проверкой: сломай
    // список кандидатов в `findDriverScript`, и она осталась бы зелёной, а
    // клики и нажатия молча перестали бы работать.
    const найденный = driverScriptPath();
    expect(existsSync(найденный), `модуль указал на ${найденный}`).toBe(true);
    expect(path.basename(найденный)).toBe('win32-driver.ps1');
    // И это правда наш файл, а не одноимённый чужой.
    expect(path.resolve(найденный)).toBe(path.resolve(path.join(here, 'win32-driver.ps1')));
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

/**
 * Живой журнал владельца 27.09.2026: первая прямая команда после запуска
 * выполнялась 2052 мс, следующие — 511 и 671. Разница — запуск PowerShell и
 * сборка C# в драйвере: 817 мс холодным против 10–14 тёплым (замер здесь же).
 * Настоящий драйвер, только чтение списка окон — фокус не трогается.
 */
describe('прогрев драйвера', () => {
  it.skipIf(process.platform !== 'win32')('после warm() первая команда не платит за запуск', async () => {
    const первая = async (греть: boolean): Promise<number> => {
      const драйвер = new DesktopDriver();
      try {
        if (греть) await драйвер.warm();
        const начало = performance.now();
        await драйвер.windows();
        return performance.now() - начало;
      } finally {
        драйвер.dispose();
      }
    };
    // Сравнение, а не порог в миллисекундах: под нагрузкой всего набора
    // тёплый вызов доходил до 314 мс, а холодный растёт вместе с ним.
    const холодная = await первая(false);
    const тёплая = await первая(true);
    expect(тёплая, `тёплая ${Math.round(тёплая)} мс, холодная ${Math.round(холодная)} мс`).toBeLessThan(холодная / 2);
  }, 60_000);
});
