/**
 * Приёмка: прогон слоёв голосового управления без микрофона.
 *
 * Зачем она есть. Слои проверялись единственным способом — человек говорил в
 * микрофон, и он же находил поломки. «Переключись на Edge» отвечало «не
 * получилось» дважды подряд, и узнал об этом не прогон, а человек. Так
 * проверять нельзя.
 *
 * Что здесь проверяется по-настоящему: разбор фразы, исполнение прямой
 * команды настоящим драйвером рабочего стола, файловые действия на настоящих
 * файлах. Не проверяется только распознавание речи: это работа модели, и
 * звука здесь нет.
 *
 * Отвечает тремя словами, а не двумя: «прошло», «не прошло» и «нечем мерить».
 * Прибор, который молчит вместо «не знаю», хуже отсутствующего.
 *
 *   pnpm jarvis:qa
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { app, BrowserWindow, screen } from 'electron';

import { runDirectCommand, type ГоворящаяСессия } from '../../app/voiceBridge';
import { parseDirectCommand } from '../../jarvis/control/commands';
import { cannotMeasure, failed, passed, type Gate } from '../../jarvis/measure/gate';
import { командаПоказа, openPath, tidyRoot } from '../../jarvis/desktop/files';
import { createGridOverlay } from '../../app/gridOverlay';
import { createWindowTools } from '../../jarvis/desktop/windowTools';
import { createHelpOverlay } from '../../app/helpOverlay';
import { createLogWindow } from '../../app/logWindow';
import { createStatusOverlay } from '../../app/statusOverlay';
import { openSettingsWindow } from '../../app/settingsWindow';
import { jarvisPaths } from '../../jarvis/setup/paths';
import { SettingsStore } from '../../jarvis/setup/settings';

const ждать = (мс: number): Promise<void> => new Promise((r) => setTimeout(r, мс));

interface Случай {
  имя: string;
  проверка(): Promise<Gate>;
}

/** Сессия, которая только запоминает сказанное: голос на приёмке не нужен. */
function тихаяСессия(): ГоворящаяСессия & { сказанное: string[] } {
  const сказанное: string[] = [];
  return {
    сказанное,
    status: { indicator: 'idle', listening: false, awake: false, muted: false } as never,
    speak(text: string) {
      сказанное.push(text);
    },
  };
}

// --- разбор фраз -------------------------------------------------------------
// Чистая часть: ни окон, ни файлов. Ломается тихо и стоит дёшево.

const РАЗБОР: Array<[фраза: string, вид: string]> = [
  ['переключись на Edge', 'focus'],
  ['переключись на блокнот', 'focus'],
  ['прокрути вниз', 'scroll'],
  ['нажми enter', 'key'],
];

const разборФраз: Случай[] = РАЗБОР.map(([фраза, вид]) => ({
  имя: `разбор: «${фраза}» → ${вид}`,
  async проверка(): Promise<Gate> {
    const команда = parseDirectCommand(фраза);
    if (!команда) return failed('фраза не разобралась вовсе');
    return команда.kind === вид
      ? passed(`${команда.kind}`)
      : failed(`разобралось как ${команда.kind}, а не ${вид}`);
  },
}));

// --- окна --------------------------------------------------------------------
// Настоящее окно, настоящий драйвер. Блокнот, а не то, что случайно открыто:
// приёмка не должна зависеть от того, что сейчас на экране у человека.

/**
 * Своё окно для приёмки — своё же, электроновское.
 *
 * Сначала брали Блокнот: первый прогон сразу показал, почему нельзя. У
 * человека был открыт свой Блокнот, драйвер поднял его, а приёмка спрашивала
 * «свёрнут ли хоть один Блокнот» и получала «да». Гасить чужие Блокноты тоже
 * нельзя — там бывает несохранённое.
 *
 * Потом пробовали своё окно через PowerShell. Оно не появлялось: pwsh выходит
 * с кодом 0 сразу, цикл сообщений не запускается — замерено, вывод пуст,
 * процесса нет уже через полторы секунды.
 *
 * А приёмка и так работает под Электроном. Значит окно открывается прямо
 * здесь: заголовок свой, никто другой его не тронет, и видно всё — свёрнуто
 * оно или нет — без единого чужого процесса.
 */
const ИМЯ_ОКНА = 'Проба приёмки Rujarvis';

/**
 * Где эта проверка вообще имеет смысл.
 *
 * Драйвер окон есть на двух платформах: PowerShell на Windows и `osascript`
 * на маке (`jarvis/desktop/platform.ts` выбирает). На Linux рабочего стола у
 * Джарвиса нет, и там честный ответ — «нечем мерить», а не «не прошло».
 *
 * Окно приёмка открывает своё, электроновское, и на маке по той же причине,
 * что и на Windows: чужое окно нельзя ни трогать, ни гасить.
 */
const ЕСТЬ_ДРАЙВЕР_ОКОН = process.platform === 'win32' || process.platform === 'darwin';

const окна: Случай[] = [
  {
    имя: 'окно: свёрнутое окно поднимается по фразе',
    async проверка(): Promise<Gate> {
      if (!ЕСТЬ_ДРАЙВЕР_ОКОН) return cannotMeasure(`драйвера окон для ${process.platform} нет`);

      const окно = new BrowserWindow({
        title: ИМЯ_ОКНА,
        width: 420,
        height: 220,
        show: false,
        skipTaskbar: false,
      });
      try {
        окно.setTitle(ИМЯ_ОКНА);
        окно.show();
        await ждать(700);

        окно.minimize();
        await ждать(700);
        if (!окно.isMinimized()) return cannotMeasure('окно не свернулось — проверять нечего');

        const команда = parseDirectCommand(`переключись на ${ИМЯ_ОКНА}`);
        if (!команда) return failed('фраза не разобралась');

        const исход = await runDirectCommand(команда, тихаяСессия());
        await ждать(700);

        if (исход.passed === false) return failed(`команда отказала: ${исход.why}`);
        return окно.isMinimized() ? failed('окно осталось свёрнутым') : passed('свёрнутое окно поднялось');
      } finally {
        if (!окно.isDestroyed()) окно.destroy();
      }
    },
  },
  {
    имя: 'окно: отказ называет то, что на экране',
    async проверка(): Promise<Gate> {
      if (!ЕСТЬ_ДРАЙВЕР_ОКОН) return cannotMeasure(`драйвера окон для ${process.platform} нет`);

      const команда = parseDirectCommand('переключись на окнокоторогонет');
      if (!команда) return cannotMeasure('фраза не разобралась — проверять нечего');

      const исход = await runDirectCommand(команда, тихаяСессия());
      if (исход.passed !== false) return failed('несуществующее окно «нашлось»');

      // «Не получилось» без единой подсказки — это и была беда.
      //
      // Два драйвера пишут по-разному: win32 — латиницей («Na ekrane»), мак —
      // по-русски и с большой буквы («На экране»). Поэтому сравнение идёт в
      // нижнем регистре: иначе маковский отказ выглядел бы как «ничего не
      // объясняет», хотя он объясняет.
      const почему = исход.why.toLowerCase();
      return почему.includes('na ekrane') || почему.includes('на экране')
        ? passed('отказ перечислил соседей')
        : failed(`отказ ничего не объясняет: ${исход.why}`);
    },
  },
];

// --- интерфейс ---------------------------------------------------------------
//
// Окна здесь показываются по-настоящему, на доли секунды. Приёмку запускают
// руками и знают, зачем: это не то же самое, что окно, вылезшее посреди чужой
// работы.

/** Окно, появившееся после действия: сравниваем то, что было, с тем, что стало. */
function новоеОкно(былиДо: Set<number>): BrowserWindow | undefined {
  return BrowserWindow.getAllWindows().find((w) => !былиДо.has(w.id));
}

const снимокОкон = (): Set<number> => new Set(BrowserWindow.getAllWindows().map((w) => w.id));

/** Временный дом: приёмка не должна писать в настройки человека. */
function временныйДом(): { paths: ReturnType<typeof jarvisPaths>; settings: SettingsStore } {
  const дом = mkdtempSync(path.join(os.tmpdir(), 'qa-home-'));
  const paths = jarvisPaths({ ...process.env, JARVIS_HOME: дом });
  mkdirSync(paths.data, { recursive: true });
  return { paths, settings: new SettingsStore(path.join(paths.data, 'settings.json')) };
}

const интерфейс: Случай[] = [
  {
    имя: 'плашка: текст не срезается',
    async проверка(): Promise<Gate> {
      const былиДо = снимокОкон();
      const плашка = createStatusOverlay();
      try {
        плашка.note(
          { indicator: 'thinking', listening: true, awake: true, muted: false } as never,
          'Слушаю: длинная фраза, которая обязана перенестись на вторую строку',
        );
        await ждать(900);

        const окно = новоеОкно(былиДо);
        if (!окно) return cannotMeasure('окно плашки не нашлось');

        // Меряем саму плашку, а не scrollHeight: тот тянется за окном и
        // сходится всегда, даже когда содержимое срезано.
        const [нужно, дали] = (await окно.webContents.executeJavaScript(
          "[Math.ceil(document.getElementById('pill').getBoundingClientRect().height), window.innerHeight]",
        )) as [number, number];

        return дали >= нужно
          ? passed(`плашке нужно ${нужно}, окно ${дали}`)
          : failed(`срезано на ${нужно - дали}: нужно ${нужно}, окно ${дали}`);
      } finally {
        плашка.dispose();
      }
    },
  },
  {
    имя: 'плашка: не ужимается от обновлений',
    async проверка(): Promise<Gate> {
      // Ужималась ШИРИНА, а не высота.
      //
      // При дробном масштабе `setBounds` из `getBounds` терял проценты за
      // вызов, и плашка усыхала с 320 точек до тридцати с небольшим:
      // оставалась узкая полоска с точкой состояния, текст не помещался
      // вовсе, и со стороны это выглядело как «Джарвис не запустился».
      //
      // Первая версия этой проверки мерила высоту — и осталась зелёной, когда
      // я вернул поломку нарочно. Зелёное, которое не может покраснеть, —
      // украшение.
      //
      // На масштабе 1.0 поломка не воспроизводится вовсе, и тогда честнее
      // сказать «нечем мерить».
      const масштаб = screen.getPrimaryDisplay().scaleFactor;
      if (масштаб === 1) {
        return cannotMeasure(`масштаб экрана ${масштаб} — на нём ужимание не воспроизводится`);
      }

      const былиДо = снимокОкон();
      const плашка = createStatusOverlay();
      const состояние = { indicator: 'thinking', listening: true, awake: true, muted: false } as never;
      try {
        плашка.note(состояние, 'Слушаю: длинная фраза для переноса на вторую строку');
        await ждать(900);

        const окно = новоеОкно(былиДо);
        if (!окно) return cannotMeasure('окно плашки не нашлось');

        const ширина = async (): Promise<number> =>
          (await окно.webContents.executeJavaScript('window.innerWidth')) as number;

        const сначала = await ширина();
        for (let i = 0; i < 10; i += 1) {
          плашка.note(состояние, `Слушаю: обновление номер ${i + 1}, строка подлиннее для переноса`);
          await ждать(120);
        }
        await ждать(400);
        const потом = await ширина();

        return потом >= сначала
          ? passed(`масштаб ${масштаб}: ширина за 10 обновлений ${сначала} → ${потом}`)
          : failed(`плашка усохла по ширине: ${сначала} → ${потом} за 10 обновлений`);
      } finally {
        плашка.dispose();
      }
    },
  },
  {
    имя: 'справка: влезает в экран или честно говорит, что длиннее',
    async проверка(): Promise<Gate> {
      const былиДо = снимокОкон();
      const справка = createHelpOverlay();
      try {
        справка.show();
        await ждать(900);

        const окно = новоеОкно(былиДо);
        if (!окно) return cannotMeasure('окно справки не нашлось');

        const рабочая = screen.getPrimaryDisplay().workAreaSize;
        const рамка = окно.getBounds();
        if (рамка.height > рабочая.height) {
          return failed(`окно ${рамка.height} точек выше рабочей области ${рабочая.height}`);
        }

        const [нужно, дали, есть_подсказка] = (await окно.webContents.executeJavaScript(
          "[document.documentElement.scrollHeight, window.innerHeight, /длиннее окна|longer than/iu.test(document.body.innerText)]",
        )) as [number, number, boolean];

        if (дали >= нужно) return passed(`список влез целиком: ${нужно} ≤ ${дали}`);
        return есть_подсказка
          ? passed(`длиннее окна (${нужно} > ${дали}), и об этом сказано`)
          : failed(`длиннее окна (${нужно} > ${дали}) и молчит об этом`);
      } finally {
        справка.dispose();
      }
    },
  },
  {
    имя: 'окно событий: открывается и показывает строки',
    async проверка(): Promise<Gate> {
      const былиДо = снимокОкон();
      const журнал = createLogWindow();
      try {
        журнал.append({ kind: 'command', text: 'проба приёмки: строка первая' } as never);
        журнал.open();
        await ждать(900);

        const окно = новоеОкно(былиДо);
        if (!окно) return cannotMeasure('окно событий не нашлось');

        const текст = (await окно.webContents.executeJavaScript('document.body.innerText')) as string;
        return текст.includes('проба приёмки')
          ? passed('строка дошла до окна')
          : failed(`в окне нет добавленной строки: «${текст.replace(/\s+/gu, ' ').slice(0, 80)}»`);
      } finally {
        журнал.dispose();
      }
    },
  },
  {
    имя: 'онбординг: мастер до настройки, вкладки после',
    async проверка(): Promise<Gate> {
      const { paths, settings } = временныйДом();
      const былиДо = снимокОкон();
      try {
        settings.update({ onboarded: false });
        openSettingsWindow({ settings, paths, onFinished: () => {}, onSettingsChanged: () => {} });
        await ждать(1600);

        const окно = новоеОкно(былиДо);
        if (!окно) return cannotMeasure('окно настройки не нашлось');

        const мастер = (await окно.webContents.executeJavaScript(
          "Boolean(document.querySelector('.steps'))",
        )) as boolean;
        if (!мастер) return failed('до настройки показаны вкладки, а не мастер');

        // Настройка пройдена — то же окно обязано стать вкладками.
        settings.update({ onboarded: true });
        openSettingsWindow({ settings, paths, onFinished: () => {}, onSettingsChanged: () => {} });
        await ждать(900);

        const всёЕщёМастер = (await окно.webContents.executeJavaScript(
          "Boolean(document.querySelector('.steps'))",
        )) as boolean;
        return всёЕщёМастер
          ? failed('после настройки всё ещё мастер')
          : passed('мастер до, вкладки после');
      } finally {
        for (const окно of BrowserWindow.getAllWindows()) {
          if (!былиДо.has(окно.id) && !окно.isDestroyed()) окно.destroy();
        }
      }
    },
  },
  {
    имя: 'окна: список не врёт про пустой экран',
    async проверка(): Promise<Gate> {
      // Драйвер окон сам заканчивает свою сессию и дальше отвечает на всё
      // фразой про `start_session`. Эта фраза не разбиралась как список, и
      // человек слышал «Открытых окон нет» при живых Блендере и браузере.
      // Своё окно приёмки здесь же и служит доказательством: хотя бы оно
      // на экране есть всегда.
      //
      // Берём не cua-driver напрямую, а слой компьютер-юза: на маке
      // cua-driver'а нет и не будет, а проверять надо то, чем работает
      // Джарвис. Раньше этот случай на маке отвечал «Драйвер компьютер-юза
      // не найден» — и это был не сбой проверки, а правда: оконных глаз на
      // маке не было вовсе.
      const окно = new BrowserWindow({ title: ИМЯ_ОКНА, width: 300, height: 160, show: false });
      const драйвер = createWindowTools();
      try {
        окно.show();
        await ждать(600);

        const окна = await драйвер.windows();
        if (окна.length === 0) return failed('список пуст, хотя на экране есть хотя бы своё окно');

        // И второй раз, уже после того как драйвер мог закончить сессию.
        const снова = await драйвер.windows();
        return снова.length > 0
          ? passed(`${окна.length} окон, со второго раза ${снова.length}`)
          : failed('со второго раза список опустел — сессия не поднялась');
      } catch (error) {
        return failed(error instanceof Error ? error.message : String(error));
      } finally {
        драйвер.dispose();
        if (!окно.isDestroyed()) окно.destroy();
      }
    },
  },
  {
    имя: 'сетка: странице достаётся весь экран, а не меньше',
    async проверка(): Promise<Gate> {
      // Меряем САМУ СТРАНИЦУ, а не вычисленную раскладку.
      //
      // Первая попытка сравнивала раскладку с экраном и проходила даже на
      // сломанном окне: раскладка — чистая арифметика, она верна всегда.
      // Ломалось другое: `resizable: false` заставлял Windows ужать окно, и
      // странице доставалось 1858×1050 вместо 1920×1080 — клик по 12-му
      // столбцу уезжал от нарисованного на 59 точек.
      const былиДо = new Set(BrowserWindow.getAllWindows().map((w) => w.id));
      const сетка = createGridOverlay();
      try {
        const раскладка = сетка.show();
        await ждать(600);

        const окно = BrowserWindow.getAllWindows().find((w) => !былиДо.has(w.id));
        if (!окно) return cannotMeasure('окно сетки не нашлось среди открытых');

        const [ширинаСтраницы, высотаСтраницы, плотность] = (await окно.webContents.executeJavaScript(
          '[window.innerWidth, window.innerHeight, window.devicePixelRatio]',
        )) as [number, number, number];

        const экран = screen.getPrimaryDisplay();
        const нужноШирина = Math.round(экран.bounds.width * экран.scaleFactor);
        const нужноВысота = Math.round(экран.bounds.height * экран.scaleFactor);
        const далоШирина = Math.round(ширинаСтраницы * плотность);
        const далоВысота = Math.round(высотаСтраницы * плотность);

        if (далоШирина !== нужноШирина || далоВысота !== нужноВысота) {
          return failed(
            `странице досталось ${далоШирина}×${далоВысота}, а экран ${нужноШирина}×${нужноВысота}`,
          );
        }
        return passed(
          `${раскладка.columns}×${раскладка.rows} клеток на ${далоШирина}×${далоВысота}`,
        );
      } finally {
        сетка.hide();
        сетка.dispose();
      }
    },
  },
];

// --- файлы -------------------------------------------------------------------

const файлы: Случай[] = [
  {
    имя: 'файлы: показ файла с пробелом в пути берёт в кавычки путь, а не весь аргумент',
    async проверка(): Promise<Gate> {
      const команда = командаПоказа('C:\\п\\папка с пробелами\\файл.txt', false, 'win32');
      return команда.verbatim && команда.args[0] === '/select,"C:\\п\\папка с пробелами\\файл.txt"'
        ? passed('строка собрана дословно')
        : failed(`собралось иначе: ${JSON.stringify(команда)}`);
    },
  },
  {
    имя: 'файлы: открыть нечем — говорим об этом, а не молчим',
    async проверка(): Promise<Gate> {
      if (process.platform !== 'win32') return cannotMeasure('проверка про реестр Windows');
      const дом = mkdtempSync(path.join(os.tmpdir(), 'qa-open-'));
      const файл = path.join(дом, 'проба.rujarvisqa');
      writeFileSync(файл, 'x');
      try {
        await openPath(файл);
        return failed('отчитались успехом, хотя открывать нечем');
      } catch (error) {
        const текст = error instanceof Error ? error.message : String(error);
        return текст.includes('не знает, чем открыть') ? passed(текст) : failed(текст);
      }
    },
  },
  {
    имя: 'файлы: разбор корня раскладывает файлы и не трогает папки',
    async проверка(): Promise<Gate> {
      const дом = mkdtempSync(path.join(os.tmpdir(), 'qa-tidy-'));
      writeFileSync(path.join(дом, 'снимок.png'), 'x');
      writeFileSync(path.join(дом, 'о папке.txt'), 'x');
      mkdirSync(path.join(дом, 'Логотип кафе'));

      const переезды = await tidyRoot(дом);
      const корень = await readdir(дом);

      if (переезды.size !== 1) return failed(`переехало ${переезды.size}, а должен был один`);
      if (!корень.includes('Логотип кафе')) return failed('папка задачи пропала');
      if (!корень.includes('о папке.txt')) return failed('пояснение к папке унесло');
      return passed('файл разложен, папка и пояснение на месте');
    },
  },
];

// --- прогон ------------------------------------------------------------------

async function main(): Promise<void> {
  const все = [...разборФраз, ...окна, ...интерфейс, ...файлы];
  let провалов = 0;
  let немеряно = 0;

  console.log('\nПриёмка Rujarvis\n');
  for (const случай of все) {
    let итог: Gate;
    try {
      итог = await случай.проверка();
    } catch (error) {
      итог = failed(`проверка упала: ${error instanceof Error ? error.message : String(error)}`);
    }

    if (итог.passed === true) {
      console.log(`  прошло        ${случай.имя}${итог.why ? ` — ${итог.why}` : ''}`);
    } else if (итог.passed === false) {
      провалов += 1;
      console.log(`  НЕ ПРОШЛО     ${случай.имя} — ${итог.why}`);
    } else {
      немеряно += 1;
      console.log(`  нечем мерить  ${случай.имя} — ${итог.why}`);
    }
  }

  console.log(
    `\nВсего ${все.length}: прошло ${все.length - провалов - немеряно}, ` +
      `не прошло ${провалов}, нечем мерить ${немеряно}\n`,
  );
  app.exit(провалов > 0 ? 1 : 0);
}

// Своё окно приёмки закрывается посреди прогона, и Электрон на этом гасит
// приложение: проверки после окна просто не выполнялись, а прогон выходил с
// нулём. Молчаливая потеря половины приёмки — хуже её отсутствия.
app.on('window-all-closed', () => {});

void app.whenReady().then(main);
