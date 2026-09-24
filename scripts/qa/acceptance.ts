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

import { execFile, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { app, BrowserWindow, screen } from 'electron';

import { runDirectCommand, type ГоворящаяСессия } from '../../app/voiceBridge';
import { parseDirectCommand } from '../../jarvis/control/commands';
import { cannotMeasure, failed, passed, type Gate } from '../../jarvis/measure/gate';
import { командаПоказа, openPath, tidyRoot } from '../../jarvis/desktop/files';
import { createGridOverlay } from '../../app/gridOverlay';

const run = promisify(execFile);
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

const ОКНА_СКРИПТ = `
Add-Type @'
using System;using System.Text;using System.Runtime.InteropServices;
public class QaW {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EP f, IntPtr l);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr h, out int p);
  public delegate bool EP(IntPtr h, IntPtr l);
}
'@
`;

/** Свернуть окна этого pid и сказать, сколько свернули. */
async function свернутьПоPid(pid: number): Promise<number> {
  const { stdout } = await run('pwsh', ['-NoProfile', '-Command', `${ОКНА_СКРИПТ}
$n = 0
[QaW]::EnumWindows({param($h,$l)
  if ([QaW]::IsWindowVisible($h)) {
    $id = 0; [QaW]::GetWindowThreadProcessId($h, [ref]$id) | Out-Null
    $p = (Get-Process -Id $id -ErrorAction SilentlyContinue).ProcessName
    if ($id -eq ${pid}) { [QaW]::ShowWindow($h, 6) | Out-Null; $script:n++ }
  }
  return $true
}, [IntPtr]::Zero) | Out-Null
$n
`]);
  return Number(stdout.trim()) || 0;
}

/**
 * Свёрнуты ли ещё окна процесса.
 *
 * Мерить надо это, а не «кто сейчас впереди»: фокус уводит любое окно, которое
 * вылезло за те полсекунды, что мы ждали, — в первом прогоне приёмку обманул
 * сам Claude, выскочивший вперёд. Развёрнутость окна никто у нас не отнимет.
 */
async function свёрнутоЛиПоPid(pid: number): Promise<boolean> {
  const { stdout } = await run('pwsh', ['-NoProfile', '-Command', `${ОКНА_СКРИПТ}
$any = $false
[QaW]::EnumWindows({param($h,$l)
  if ([QaW]::IsWindowVisible($h)) {
    $id = 0; [QaW]::GetWindowThreadProcessId($h, [ref]$id) | Out-Null
    $p = (Get-Process -Id $id -ErrorAction SilentlyContinue).ProcessName
    if ($id -eq ${pid} -and [QaW]::IsIconic($h)) { $script:any = $true }
  }
  return $true
}, [IntPtr]::Zero) | Out-Null
$any
`]);
  return stdout.trim().toLowerCase() === 'true';
}

/** Имя процесса окна, которое сейчас впереди. */
async function ктоВпереди(): Promise<string> {
  const { stdout } = await run('pwsh', ['-NoProfile', '-Command', `${ОКНА_СКРИПТ}
$h = [QaW]::GetForegroundWindow()
$id = 0; [QaW]::GetWindowThreadProcessId($h, [ref]$id) | Out-Null
(Get-Process -Id $id -ErrorAction SilentlyContinue).ProcessName
`]);
  return stdout.trim();
}

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

const окна: Случай[] = [
  {
    имя: 'окно: свёрнутое окно поднимается по фразе',
    async проверка(): Promise<Gate> {
      if (process.platform !== 'win32') return cannotMeasure('драйвер окон пока только для Windows');

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
      if (process.platform !== 'win32') return cannotMeasure('драйвер окон пока только для Windows');

      const команда = parseDirectCommand('переключись на окнокоторогонет');
      if (!команда) return cannotMeasure('фраза не разобралась — проверять нечего');

      const исход = await runDirectCommand(команда, тихаяСессия());
      if (исход.passed !== false) return failed('несуществующее окно «нашлось»');

      // «Не получилось» без единой подсказки — это и была беда.
      return исход.why.includes('Na ekrane') || исход.why.includes('на экране')
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

const интерфейс: Случай[] = [
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
