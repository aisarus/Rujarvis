import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

import { APPX_APPS_COMMAND, nameFromPackage, произносимо } from './installed';

const run = promisify(execFile);
const onWindows = process.platform === 'win32';

/**
 * Имя программы, которое человек может произнести.
 *
 * Windows отдаёт имена приложений магазина на языке их интерфейса, и на машине
 * владельца это иврит: калькулятор в `Get-StartApps` звался «מחשבון», блокнот —
 * «פנקס רשימות». Русским словом такое имя не поймать никогда, а список при
 * этом считал себя полным. Это касается программ, которые ищутся по названию,
 * — то есть всего, чего нет в пусковой таблице псевдонимов.
 *
 * Поправка, 26.09.2026. Здесь же стояли проверки, что «калькулятор» и «эдж»
 * находят свои программы по названию. Посылка была ложной: для имён из пусковой
 * таблицы поиск по названию не выполняется вовсе — `matchAppLaunch` замыкает
 * путь раньше, — и мой «замер» мерил ветку, которой они не проходят. По этой
 * ложной посылке я сломал живой запуск Edge у владельца. Те проверки удалены;
 * что имена таблицы правда запускаются, проверяет `aliasTargets.vitest.test.ts`
 * вопросом к самой Windows.
 */
describe('nameFromPackage', () => {
  it.each([
    ['Microsoft.WindowsNotepad', 'Windows Notepad'],
    ['Microsoft.WindowsCalculator', 'Windows Calculator'],
    ['Microsoft.Paint', 'Paint'],
    ['Microsoft.ScreenSketch', 'Screen Sketch'],
    ['SpotifyAB.SpotifyMusic', 'Spotify Music'],
  ])('«%s» → «%s»', (пакет, ждём) => {
    // Разбор по горбам обязателен: «windowsnotepad» одним словом со словом
    // «notepad» не совпадает, и программа не находится.
    expect(nameFromPackage(пакет)).toBe(ждём);
  });

  it.each([
    '1527c705-839a-4832-9118-54d4Bd6a0c89',
    'Microsoft.549981C3F5F10',
    'c5e2524a-ea46-4f67-841f-6a9465d9d515',
  ])('«%s» — не имя, а идентификатор', (пакет) => {
    // Служебных пакетов больше двухсот. Пусти их в список под своими
    // идентификаторами — и любое сказанное слово рискует совпасть с мусором.
    expect(nameFromPackage(пакет)).toBeNull();
  });
});

describe('произносимо', () => {
  it.each(['Windows Notepad', 'Проводник', 'Blender 5.2', 'OBS Studio (64bit)'])(
    '«%s» сказать можно',
    (имя) => {
      expect(произносимо(имя)).toBe(true);
    },
  );

  it.each(['מחשבון', 'פנקס רשימות', '電卓', '计算器'])('«%s» сказать нельзя', (имя) => {
    // Джарвис слушает по-русски и по-английски. Имя без букв этих алфавитов не
    // будет услышано никогда — ни на слух, ни через псевдоним.
    expect(произносимо(имя)).toBe(false);
  });
});

describe('список установленного', () => {
  it.skipIf(!onWindows)(
    'запрос про приложения магазина отвечает и даёт идентификаторы запуска',
    async () => {
      // Строка берётся из кода, а не переписывается сюда: со своей копией
      // проверка зеленела бы, даже если в коде её испортить.
      const { stdout } = await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', APPX_APPS_COMMAND], {
        windowsHide: true,
        maxBuffer: 16 * 1024 * 1024,
      });
      const разобрано = JSON.parse(stdout) as { Package?: string; AppID?: string }[];
      const список = Array.isArray(разобрано) ? разобрано : [разобрано];

      expect(список.length).toBeGreaterThan(0);
      // Идентификатор — «семья пакета!приложение», а не догадка «!App»: у части
      // приложений идентификатор другой, например Microsoft.Windows.FilePicker.
      expect(список.every((з) => typeof з.AppID === 'string' && з.AppID.includes('!'))).toBe(true);
    },
    120_000,
  );
});
