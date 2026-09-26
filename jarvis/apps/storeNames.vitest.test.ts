import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

import { chooseShortcut } from './startMenu';
import { APPX_APPS_COMMAND, listInstalledPrograms, nameFromPackage, произносимо } from './installed';
import { aliasTarget } from './launch';

const run = promisify(execFile);
const onWindows = process.platform === 'win32';

/**
 * Имя программы, которое человек может произнести.
 *
 * Найдено живым прогоном 26.09.2026, и найдено дважды подряд с разными
 * причинами — поэтому проверки здесь на обе.
 *
 * Первая: «открой калькулятор» открывало «LibreOffice Calc». Псевдоним вёл на
 * 'calc', а это ТОЧНОЕ совпадение со словом «Calc» в чужом названии, тогда как
 * у настоящего калькулятора совпадение лишь частичное.
 *
 * Вторая, глубже: «открой блокнот» не находило ничего. Windows отдаёт имена
 * приложений магазина на языке их интерфейса, и на этой машине это иврит —
 * калькулятор звался «מחשבון», блокнот «פנקס רשימות». Русским словом такое имя
 * не поймать никогда, а список считал себя полным.
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

describe('псевдонимы ведут на слово из названия, а не на имя процесса', () => {
  it.each([
    ['калькулятор', 'calculator', 'Windows Calculator'],
    ['эдж', 'edge', 'Microsoft Edge'],
    ['блокнот', 'notepad', 'Windows Notepad'],
  ])('«%s» → «%s» и находит «%s»', (сказано, ждёмПсевдоним, имяПрограммы) => {
    expect(aliasTarget(сказано)).toBe(ждёмПсевдоним);

    // И проверяем сам отбор рядом с тем, кто уже обыгрывал: «LibreOffice Calc»
    // забирал «калькулятор» себе, потому что 'calc' совпадало с его словом
    // ТОЧНО. «msedge» же не совпадало ни с чем, и «эдж» не находило ничего.
    const где = [{ name: имяПрограммы }, { name: 'LibreOffice Calc' }, { name: 'Microsoft Edge WebView2 Runtime' }];
    const searchable = [aliasTarget(сказано), сказано].filter(Boolean).join(' ');
    expect(chooseShortcut(searchable, где, (п) => п.name)?.item.name).toBe(имяПрограммы);
  });

  it('при установленном Notepad++ «блокнот» достаётся ему — так решает правило', () => {
    // Замер, а не пожелание. «Notepad++» — это одно слово «notepad», и правило
    // «при равном счёте побеждает короткое имя» отдаёт его вперёд «Windows
    // Notepad». Ответ спорный, но не бессмысленный: это тоже блокнот.
    //
    // Записано нарочно: обнаружено при написании проверки выше, и следующий,
    // кто увидит это на живой машине, должен знать, что оно замерено и
    // оставлено, а не просмотрено. На машине владельца Notepad++ не стоит.
    const где = [{ name: 'Windows Notepad' }, { name: 'Notepad++' }];
    const searchable = [aliasTarget('блокнот'), 'блокнот'].filter(Boolean).join(' ');
    expect(chooseShortcut(searchable, где, (п) => п.name)?.item.name).toBe('Notepad++');
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

  it.skipIf(!onWindows)(
    'блокнот и калькулятор находятся тем, что человек говорит',
    async () => {
      const итог = await listInstalledPrograms();
      if (!итог.полный) {
        // Неполный список — это «не знаю», а не «нет». Валить проверку на нём
        // значит объявить поломкой то, что мы просто не смогли спросить.
        expect(итог.programs.length).toBeGreaterThan(0);
        return;
      }
      for (const сказано of ['блокнот', 'калькулятор']) {
        const searchable = [aliasTarget(сказано), сказано].filter(Boolean).join(' ');
        const найдено = chooseShortcut(searchable, итог.programs, (п) => п.name);
        expect(найдено, `«${сказано}» не нашлось среди ${итог.programs.length} установленных`).toBeTruthy();
        expect(произносимо(найдено?.item.name ?? '')).toBe(true);
      }
    },
    120_000,
  );
});
