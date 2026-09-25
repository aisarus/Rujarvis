/**
 * Сквозная проверка запуска, переключения и закрытия — на живой машине.
 *
 * ## Зачем отдельно от «проверки команд»
 *
 * Та проверяет, что фраза разобрана. Эта — что разобранное выполнимо. Разница
 * ровно в том месте, где сломался запуск: фраза «открой блендер» разбиралась
 * прекрасно, таблица отдавала пусковое имя `blender`, и всё выглядело
 * работающим. Такой команды в Windows нет. Ни один из 1450 модульных тестов
 * этого не видел, потому что проверял таблицу против самой себя.
 *
 * Здесь каждое имя из обеих таблиц спрашивается у МАШИНЫ:
 *
 *   «открой X»        — Windows умеет запустить это имя? (PATH или реестр)
 *                       нет — а программа-то установлена? тогда это поломка
 *   «переключись на X» — таблица окон отдаёт оконное имя?
 *   «закрой X»        — фраза понята как закрытие?
 *
 * И отдельно — ложные совпадения в меню «Пуск». Открыть не ту программу хуже,
 * чем честно сказать «не нашёл»: отказ человек слышит и повторяет, а чужую
 * запущенную программу замечает не сразу.
 *
 * ## Чего здесь нет
 *
 * Закрытия по-настоящему. Проверка не имеет права убивать чужие процессы,
 * поэтому «закрой X» проверяется до выполнения — на понимании фразы. Зато
 * переключение проверяется целиком: окно обязано ВЫЙТИ ВПЕРЁД, и смотрим мы
 * не на ответ драйвера, а на то, какое окно активно.
 *
 *   npx tsx scripts/проверка-программ.ts
 */

import {
  LAUNCH_NAMES,
  WINDOW_NAMES,
  aliasTarget,
  matchAppLaunch,
  spokenCloseTarget,
  windowAlias,
} from '../jarvis/apps/launch';
import { listInstalledPrograms, startSource, type InstalledProgram } from '../jarvis/apps/installed';
import { chooseShortcut } from '../jarvis/apps/startMenu';
import { parseDirectCommand } from '../jarvis/control/commands';
import { DesktopDriver } from '../jarvis/desktop/driver';

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const NL = String.fromCharCode(10);

/**
 * Три исхода, а не два.
 *
 * «Программа не установлена» — не поломка, и записывать это провалом значит
 * приучить всех не смотреть на проверку.
 */
type Verdict = null | string | { нечем: string };

let bad = 0;
let skipped = 0;
let checked = 0;

function say(verdict: Verdict, name: string, detail: string): void {
  checked += 1;
  const label = name.padEnd(18);
  if (verdict === null) {
    console.log(`  ок    ${label} ${detail}`);
  } else if (typeof verdict === 'object') {
    skipped += 1;
    console.log(`  нечем ${label} ${verdict.нечем}`);
  } else {
    bad += 1;
    console.log(`  ПЛОХО ${label} ${verdict}`);
  }
}

/** Имя программы, сжатое до букв и цифр: для грубой независимой сверки. */
function compact(text: string): string {
  return text.toLowerCase().replace(/ё/gu, 'е').replace(/[^\p{L}\p{N}]/gu, '');
}

/**
 * Установлена ли программа — способом, не зависящим от нечёткого поиска.
 *
 * Нужна вторая пара глаз: если спрашивать «установлено ли» тем же поиском,
 * который и проверяется, то поиск всегда согласится сам с собой.
 */
function installedLike(target: string, installed: readonly InstalledProgram[]): string | null {
  const wanted = compact(target).replace(/[0-9]+$/u, '');
  if (wanted.length < 3) return null;
  // Короткое имя вернее длинного: «PowerShell» это программа, а «Cloud Tools
  // for PowerShell» — совсем другая, которая просто содержит это слово.
  const hits = installed
    .filter((item) => compact(item.name).includes(wanted))
    .sort((a, b) => a.name.length - b.name.length);
  return hits[0]?.name ?? null;
}

async function checkLaunchTable(installed: readonly InstalledProgram[]): Promise<void> {
  console.log(`ЗАПУСК — пусковая таблица, ${LAUNCH_NAMES.length} имён`);

  // Пусковых имён меньше, чем сказанных: «хром», «хрома» и «chrome» — одно и
  // то же `chrome`. Спрашиваем систему один раз на имя.
  const sources = new Map<string, string | null>();
  for (const [, target] of LAUNCH_NAMES) {
    if (!sources.has(target)) sources.set(target, await startSource(target));
  }

  for (const [spoken, expected] of LAUNCH_NAMES) {
    const launch = matchAppLaunch(`открой ${spoken}`);
    if (!launch) {
      say(`«открой ${spoken}» не даёт пускового имени`, spoken, '');
      continue;
    }
    if (launch.target !== expected) {
      say(`даёт «${launch.target}», в таблице «${expected}»`, spoken, '');
      continue;
    }

    const source = sources.get(expected) ?? null;
    if (source === 'неизвестно') {
      // Не «не установлено»: спросить не вышло. На это чинят проверку, а не
      // машину, и сворачивать одно в другое правило запрещает прямо.
      say({ нечем: `${expected}: спросить Windows не вышло` }, spoken, '');
      continue;
    }
    if (source) {
      say(null, spoken, `${expected} (${source})`);
      continue;
    }

    // Пускового имени система не знает. Это либо «не установлено», либо та
    // самая поломка: имя в таблице выдумано, а программа на месте.
    const also = installedLike(expected, installed);
    if (also) {
      say(
        `«${expected}» Windows запустить не умеет, а программа стоит: «${also}» — надо ярлыком`,
        spoken,
        '',
      );
    } else {
      say({ нечем: `${expected}: не установлено` }, spoken, '');
    }
  }
}

/**
 * «Открой X» для имён, которых в пусковой таблице нет.
 *
 * Про них мост знает только оконное имя, а открывать обязан всё равно: фраза
 * идёт дальше, к поиску среди установленного. Если и там пусто — человек
 * услышит «не нашёл» на программу, которая у него стоит.
 */
function checkOpeningWindowNames(installed: readonly InstalledProgram[]): void {
  const only = WINDOW_NAMES.filter(([spoken]) => aliasTarget(spoken) === null);
  console.log(`${NL}ЗАПУСК ЧЕРЕЗ МЕНЮ «ПУСК» — ${only.length} имён вне пусковой таблицы`);

  for (const [spoken, windowTarget] of only) {
    const found = chooseShortcut(spoken, installed, (item) => item.name);
    if (found) {
      // Найти что-нибудь мало. Оконное имя известно — значит известно и то, как
      // программа должна называться, и «нашёл» проверяется этим, а не самим
      // фактом находки.
      const wanted = compact(windowTarget).replace(/[0-9]+$/u, '');
      const fits = compact(found.item.name).includes(wanted);
      say(
        fits ? null : `«открой ${spoken}» открывает «${found.item.name}» — это не ${windowTarget}`,
        spoken,
        `${found.item.name} (${found.item.kind})`,
      );
      continue;
    }
    const also = installedLike(windowTarget, installed);
    say(
      also
        ? `«открой ${spoken}» не находит ничего, а программа стоит: «${also}»`
        : { нечем: `${windowTarget}: не установлено` },
      spoken,
      '',
    );
  }
}

function checkWindowTable(): void {
  console.log(`${NL}ОКНА — «переключись на X», ${WINDOW_NAMES.length} имён`);

  for (const [spoken, expected] of WINDOW_NAMES) {
    const command = parseDirectCommand(`переключись на ${spoken}`);
    if (!command || command.kind !== 'focus') {
      say(`разобрано как «${command?.kind ?? 'ничто'}», ожидали переключение`, spoken, '');
      continue;
    }
    const alias = windowAlias(command.title);
    if (alias !== expected) {
      say(`оконное имя «${alias ?? 'нет'}», в таблице «${expected}»`, spoken, '');
      continue;
    }
    say(null, spoken, `окно «${expected}»`);
  }
}

function checkClosing(): void {
  const all = [...LAUNCH_NAMES, ...WINDOW_NAMES].map(([spoken]) => spoken);
  const names = [...new Set(all)];
  console.log(`${NL}ЗАКРЫТИЕ — «закрой X», ${names.length} имён`);

  for (const spoken of names) {
    const target = spokenCloseTarget(`закрой ${spoken}`);
    if (target !== spoken) {
      say(`понято как «${target ?? 'ничто'}»`, spoken, '');
      continue;
    }
    // Мосту нужно ещё и имя процесса, иначе «хром» ищется как «hrom».
    const resolved = windowAlias(spoken) ?? aliasTarget(spoken) ?? spoken;
    say(null, spoken, `ищет процесс «${resolved}»`);
  }
}

/**
 * Имена, про которые известно, чем они обязаны кончиться.
 *
 * Половина — верные совпадения, которые поиск обязан находить, половина —
 * ложные, найденные на живой машине. Разделять их автоматически нельзя:
 * «эпик» это одно слово из трёх в "Epic Games Launcher" и обязано находиться,
 * а «дота» — одно слово из пяти в «Источники данных ODBC» и обязано НЕ
 * находиться. Разницу знает только человек, поэтому она записана руками.
 */
const EXPECTED: ReadonlyArray<readonly [string, readonly string[] | null]> = [
  ['эпик', ['Epic Games Launcher']],
  ['блендер', ['Blender 5.2']],
  ['стим', ['Steam']],
  ['обс', ['OBS Studio (64bit)']],
  ['риот', ['Riot Client', 'Клиент Riot']],
  // Их на машине две, и обе — PowerShell: седьмая из магазина и системная
  // пятая. Спрашивать «которая» не надо, обе верны.
  ['повершелл', ['PowerShell', 'Windows PowerShell']],
  ['дискорд', ['Discord']],
  // Ложные совпадения, найденные вживую. Ожидается что угодно, кроме них.
  ['дота', null],
  ['клод', null],
  ['эдж', null],
];

const WRONG: Readonly<Record<string, readonly string[]>> = {
  дота: ['ODBC', 'Источники данных'],
  клод: ['Cloud Tools for PowerShell', 'Google Cloud SDK Shell'],
  эдж: ['AutoHotkey Dash'],
};

function checkStartMenu(installed: readonly InstalledProgram[]): void {
  // Проверяется дважды. Список из магазина приходит отдельным вызовом и
  // приходит не всегда: без него Dota 2 и Claude исчезают из списка — и именно
  // в этом состоянии «дота» находила «Источники данных ODBC», а «клод» —
  // Cloud Tools for PowerShell. Проверять только полный список значит не
  // проверять тот случай, в котором всё и ломалось.
  const lists: ReadonlyArray<readonly [string, readonly InstalledProgram[]]> = [
    ['весь список', installed],
    ['только ярлыки', installed.filter((item) => item.kind === 'path')],
  ];

  for (const [label, list] of lists) {
    console.log(`${NL}МЕНЮ «ПУСК» — ${label}, ${list.length} программ`);
    for (const [spoken, want] of EXPECTED) {
      // Мост ищет под английским именем тоже, когда оно известно.
      const searchable = [aliasTarget(spoken), spoken].filter(Boolean).join(' ');
      const found = chooseShortcut(searchable, list, (item) => item.name);
      const name = found?.item.name ?? null;

      const forbidden = WRONG[spoken] ?? [];
      if (name && forbidden.some((piece) => name.includes(piece))) {
        say(`нашёл не то: «${name}» — ложное совпадение`, spoken, '');
        continue;
      }
      if (want === null) {
        say(null, spoken, name ? `${name} (ложное отсеяно)` : 'ничего — и правильно');
        continue;
      }
      if (name !== null && want.includes(name)) {
        say(null, spoken, name);
        continue;
      }
      if (name === null) {
        // Программы может не быть в этом списке: часть живёт только в магазине.
        const present = want.some((option) => list.some((item) => item.name === option));
        const shown = want.join('» или «');
        say(present ? `не нашёл «${shown}»` : { нечем: `«${shown}» нет в этом списке` }, spoken, '');
        continue;
      }
      say(`нашёл «${name}», ожидали «${want.join('» или «')}»`, spoken, '');
    }
  }
}

/** Имя процесса по номеру — тем же списком, каким пользуется мост. */
async function processNames(): Promise<Map<number, string>> {
  const names = new Map<number, string>();
  try {
    const { stdout } = await run('tasklist', ['/fo', 'csv', '/nh'], {
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
    });
    for (const line of stdout.split(/\r?\n/u)) {
      const fields = [...line.matchAll(/"([^"]*)"/gu)].map((match) => match[1] ?? '');
      const pid = Number.parseInt(fields[1] ?? '', 10);
      if (fields[0] && Number.isFinite(pid)) names.set(pid, fields[0].replace(/\.exe$/iu, ''));
    }
  } catch {
    // Без списка процессов сверка пойдёт по одним заголовкам.
  }
  return names;
}

/** Окно, которое сейчас впереди на самом деле. */
async function front(driver: DesktopDriver): Promise<{ title: string; pid: number }> {
  const windows = await driver.windows();
  return windows.find((w) => w.focused) ?? { title: '(нет)', pid: -1 };
}

/**
 * Переключение вживую.
 *
 * Мерило одно: какое окно активно ПОСЛЕ. Ответ `focus` мерилом не является —
 * он им был, и он врал: Windows запрещает красть фокус, SetForegroundWindow
 * молча возвращает false, а драйвер отчитывался успехом.
 *
 * Идём по разным программам подряд, чтобы каждый шаг был настоящим переходом,
 * а не «оно и так было впереди».
 */
async function checkLiveFocus(driver: DesktopDriver): Promise<void> {
  console.log(`${NL}ЖИВОЕ ПЕРЕКЛЮЧЕНИЕ — окно обязано выйти вперёд`);

  const targets = [...new Set(WINDOW_NAMES.map(([, target]) => target))];
  const windows = await driver.windows();
  // Так же, как ищет драйвер: сперва заголовок, потом имя процесса. Окно Edge
  // называется «… Microsoft Edge», а процесс — msedge; искать только по
  // заголовку значит объявить открытое окно закрытым.
  const names = await processNames();
  const belongs = (window: { title: string; pid: number }, target: string): boolean => {
    const needle = target.toLowerCase();
    if (window.title.toLowerCase().includes(needle)) return true;
    return (names.get(window.pid) ?? '').toLowerCase().includes(needle);
  };

  const came = targets.filter((target) => windows.some((w) => belongs(w, target)));
  if (came.length < 2) {
    console.log(`  нечем ${'переключение'.padEnd(18)} открыто меньше двух знакомых окон`);
    skipped += 1;
    checked += 1;
    return;
  }

  const started = await front(driver);
  // Туда и обратно: обратный ход доказывает, что окно поднимается и тогда,
  // когда впереди чужое, а не только с первого раза по случайности. Соседних
  // повторов нет — каждый шаг обязан быть настоящим переходом.
  const walk = [...came, ...[...came].reverse().slice(1)];

  for (const target of walk) {
    const before = await front(driver);
    let reported: string;
    try {
      reported = (await driver.focus(target)).title;
    } catch (error) {
      // Окно этой цели ТОЧНО на экране: она прошла отбор выше. Значит отказ
      // переключения — это «не прошло», а не «нечем мерить», и ровно та
      // поломка, ради которой всё заведено: «Переключись на Edge» отвечало
      // «не получилось». Сворачивать её в «нечем» — прятать, и прогон выходил
      // с нулём, сообщая «Всё прошло».
      say(`драйвер отказался переключать: ${error instanceof Error ? error.message : String(error)}`, target, '');
      continue;
    }
    // Сразу, без своей задержки: драйвер внутри уже выждал четверть секунды и
    // сам себя проверил. Здесь проверяется ровно то, соврал он или нет.
    const now = await front(driver);
    if (!belongs(now, target)) {
      say(`драйвер сказал «${reported}», а впереди «${short(now.title)}»`, target, '');
      continue;
    }

    // Окно поднялось. Но рабочий стол живой: пока мы смотрим, вперёд может
    // выйти кто угодно — это не поломка переключения, и записывать это
    // провалом значит ругать драйвер за чужую работу.
    await new Promise((resolve) => setTimeout(resolve, 400));
    const later = await front(driver);
    const moved = before.pid === now.pid ? 'уже было впереди' : `с «${short(before.title)}»`;
    if (!belongs(later, target)) {
      say(null, target, `${short(now.title)} (${moved}); затем перебили: «${short(later.title)}»`);
      continue;
    }
    say(null, target, `${short(now.title)} (${moved})`);
  }

  // Возвращаем то, что было: проверка не имеет права оставлять чужой стол
  // переложенным.
  if (started.pid !== -1) {
    try {
      await driver.focus(started.title);
    } catch {
      // Окно могло закрыться, пока мы ходили. Не беда.
    }
  }
}

/** Заголовки бывают в полстроки. Для отчёта хватает начала. */
function short(title: string): string {
  return title.length > 44 ? `${title.slice(0, 43)}…` : title;
}

async function main(): Promise<void> {
  const driver = new DesktopDriver();
  const список = await listInstalledPrograms();
  const installed = список.programs;
  console.log(`Установлено программ: ${installed.length}${NL}`);
  if (!список.полный) {
    // Проверка по неполному списку проверяет не то: без записей магазина
    // «дота» не находит Dota 2 и уходит искать среди остального.
    console.log(`  ВНИМАНИЕ: список неполный — Windows не ответил про магазин.${NL}`);
  }

  await checkLaunchTable(installed);
  checkOpeningWindowNames(installed);
  checkWindowTable();
  checkClosing();
  checkStartMenu(installed);
  await checkLiveFocus(driver);

  console.log('');
  const tail = skipped > 0 ? `, нечем проверить: ${skipped}` : '';
  console.log(bad === 0 ? `Всё прошло: ${checked}${tail}.` : `Не прошло: ${bad} из ${checked}${tail}.`);
  driver.dispose?.();
  process.exit(bad === 0 ? 0 : 1);
}

void main();
