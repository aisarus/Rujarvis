/**
 * Живая проверка быстрых команд браузера — в том самом положении, в котором
 * они ломались.
 *
 * Живой прогон 26.09.2026: «закрой вкладку» нажимало Ctrl+W в окно, что
 * впереди, а впереди был Claude — вкладка в Edge осталась открытой. Поэтому
 * здесь впереди нарочно НЕ браузер: свой блокнот. Если команда уйдёт в
 * переднее окно, это сразу видно: Ctrl+W в блокноте Windows 11 закрывает его
 * вкладку, а с ней и само окно.
 *
 * Путь тот же, что у голоса: фраза → `parseDirectCommand` → `нажать` /
 * `открытьСсылку` → настоящий драйвер рабочего стола. Мост зовёт ровно эти
 * функции, копий здесь нет. Браузер — отдельный профиль Джарвиса через его
 * MCP-сервер, окна человека проверка не трогает. Блокнот гасится по
 * записанному pid.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { нажать, окноБраузера, открытьСсылку, этоОкноБраузера } from '../../jarvis/control/browserCommands';
import { parseDirectCommand } from '../../jarvis/control/commands';
import { createDesktopDriver } from '../../jarvis/desktop/platform';

type Итог =
  | { вид: 'прошло'; чем: string }
  | { вид: 'не прошло'; почему: string }
  | { вид: 'нечем мерить'; почему: string };

const NL = String.fromCharCode(10);

/* ----------------------------------------------------------- MCP --- */

class Сервер {
  private child: ChildProcess | null = null;
  private buf = '';
  private next = 10;
  private readonly ждут = new Map<number, (v: unknown) => void>();

  async поднять(): Promise<void> {
    this.child = spawn(process.execPath, ['dist/jarvis/desktop/mcp.cjs'], {
      stdio: ['pipe', 'pipe', 'ignore'],
      env: { ...process.env, JARVIS_LANGUAGE: 'ru' },
    });
    this.child.stdout?.on('data', (c: Buffer) => {
      this.buf += c.toString('utf8');
      let e: number;
      while ((e = this.buf.indexOf('\n')) >= 0) {
        const l = this.buf.slice(0, e).trim();
        this.buf = this.buf.slice(e + 1);
        if (!l.startsWith('{')) continue;
        try {
          const m = JSON.parse(l) as { id?: number; result?: unknown };
          if (m.id !== undefined && this.ждут.has(m.id)) {
            this.ждут.get(m.id)?.(m.result);
            this.ждут.delete(m.id);
          }
        } catch {
          // не наша строка
        }
      }
    });
    await this.спросить('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'browser-keys-check', version: '1' },
    });
    this.child.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  }

  private спросить(method: string, params: unknown): Promise<unknown> {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`сервер молчит на ${method}`)), 90_000);
      this.ждут.set(id, (v) => {
        clearTimeout(t);
        resolve(v);
      });
      this.child?.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  async инструмент(name: string, args: Record<string, unknown>): Promise<string> {
    const r = (await this.спросить('tools/call', { name, arguments: args })) as {
      content?: { text?: string }[];
      isError?: boolean;
    };
    const текст = (r.content ?? []).map((c) => c.text ?? '').join('');
    if (r.isError) throw new Error(текст || 'инструмент отказал');
    return текст;
  }

  закрыть(): void {
    this.child?.kill();
  }
}

/* -------------------------------------------------------- помощь --- */

interface Окно {
  title: string;
  app: string;
  pid: number;
}

/** «заголовок — программа.exe, pid N, окно M» — вид снят с живого сервера. */
function окнаИз(текст: string): Окно[] {
  const окна: Окно[] = [];
  for (const м of текст.matchAll(/^(.+) — (\S+), pid (\d+), окно (\d+)\s*$/gmu)) {
    окна.push({ title: (м[1] ?? '').trim(), app: м[2] ?? '', pid: Number(м[3]) });
  }
  return окна;
}

/** Вкладки браузера Джарвиса: «→ 1. заголовок — адрес». */
function вкладки(текст: string): string[] {
  return текст.split(NL).filter((л) => /^\s*(?:→\s*)?\d+[.)]/u.test(л));
}

function активная(текст: string): string {
  return вкладки(текст).find((л) => л.trim().startsWith('→')) ?? '';
}

const пауза = (мс: number) => new Promise((r) => setTimeout(r, мс));

async function ждать(условие: () => Promise<boolean>, срокМс: number): Promise<boolean> {
  const конец = Date.now() + срокМс;
  while (Date.now() < конец) {
    if (await условие()) return true;
    await пауза(300);
  }
  return false;
}

function страница(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'jarvis-browser-keys-'));
  const файл = path.join(dir, 'links.html');
  writeFileSync(
    файл,
    [
      '<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Проба ссылок Джарвиса</title></head><body>',
      '<h1>Проба ссылок</h1><p>Абзац перед ссылками.</p><ol>',
      '<li><a href="#one">Первая ссылка</a></li>',
      '<li><a href="#two">Вторая ссылка</a></li>',
      '<li><a href="#three">Третья ссылка</a></li>',
      '<li><a href="#four">Четвёртая ссылка</a></li>',
      '<li><a href="#five">Пятая ссылка</a></li>',
      '</ol></body></html>',
    ].join(NL),
    'utf8',
  );
  return `file:///${файл.replace(/\\/gu, '/')}`;
}


/**
 * Сверху ли окно ПРОВЕРКИ, а не браузер человека.
 *
 * Выбор окна в продукте верный: вкладочная команда идёт в верхнее окно
 * браузера, какое бы оно ни было, — человек так и хочет. Но проверке нельзя
 * нажать Ctrl+W в окне человека и закрыть ему вкладку. Поэтому перед каждым
 * нажатием: выбрано ли наше окно. Нет — «нечем мерить», и ничего не жмём.
 *
 * Своё окно узнаётся по pid, а не по названию профиля. Первая версия искала
 * «Профиль 1» — и на английском раннере не нашла «Profile 1», объявив своё
 * окно чужим. А узнавай она «Profile 1», у человека с английским Edge, чей
 * основной профиль так и называется, она приняла бы ЕГО окно за своё и
 * нажала бы в нём Ctrl+W. Браузер Джарвиса — отдельный процесс со своим
 * профилем, и его pid другим не бывает.
 */
async function выбраноНаше(
  desktop: ReturnType<typeof createDesktopDriver>,
  нашPid: number,
): Promise<string | null> {
  const выбор = окноБраузера(await desktop.windows());
  if (!выбор) return 'окна браузера нет вовсе';
  return выбор.pid === нашPid
    ? null
    : `сверху чужой браузер «${выбор.title.slice(0, 50)}», pid ${выбор.pid} — жать туда нельзя`;
}

async function впереди(desktop: ReturnType<typeof createDesktopDriver>): Promise<string> {
  return ((await desktop.windows()).find((о) => о.focused)?.title ?? 'ничего').slice(0, 45);
}


/**
 * Сколько вкладок в окне браузера проверки — по его ЗАГОЛОВКУ.
 *
 * Не по списку Playwright: замер 26.09.2026 показал, что вкладку, открытую с
 * клавиатуры, он не видит. Ctrl+T сработал — заголовок окна стал «Новая
 * вкладка и еще 1 страница», — а список Playwright продолжал говорить «1», и
 * проверка объявила провалом то, что сделано. Заголовок — то, что видит
 * человек, и Edge пишет в него счёт: «… и еще N страниц» — это N+1 вкладок.
 */
async function вкладокВОкне(
  desktop: ReturnType<typeof createDesktopDriver>,
  нашPid: number,
): Promise<number | null> {
  const наше = (await desktop.windows()).find((о) => о.pid === нашPid && этоОкноБраузера(о));
  if (!наше) return null;
  const м = /(?:и ещ[её]|and) (\d+) (?:страниц|more page)/iu.exec(наше.title);
  return м ? Number(м[1]) + 1 : 1;
}


/** Вывести свой блокнот вперёд. Не отдали фокус — `false`, без исключения. */
async function блокнотВперёд(desktop: ReturnType<typeof createDesktopDriver>, заголовок: string): Promise<boolean> {
  try {
    await desktop.focus(заголовок);
    await пауза(400);
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------ проверки --- */

async function main(): Promise<void> {
  console.log('');
  console.log('Быстрые команды браузера, когда впереди не браузер');
  console.log('');

  const итоги: Array<{ имя: string; итог: Итог }> = [];
  const запиши = (имя: string, итог: Итог) => итоги.push({ имя, итог });

  // 1. Разбор фраз — не требует ни окна, ни платформы.
  const фразы: Array<[string, number]> = [
    ['открой третью ссылку', 3],
    ['перейди по второй ссылке', 2],
    ['открой ссылку номер пять', 5],
    ['нажми на первую ссылку', 1],
    ['открой последнюю ссылку', -1],
    ['open the third link', 3],
    ['click link 2', 2],
  ];
  const мимо = фразы.filter(([ф, н]) => {
    const к = parseDirectCommand(ф);
    return !(к?.kind === 'openLink' && к.index === н);
  });
  запиши(
    'фразы про ссылки разбираются на обоих языках',
    мимо.length === 0
      ? { вид: 'прошло', чем: `${фразы.length} фраз, номера верные` }
      : { вид: 'не прошло', почему: `мимо: ${мимо.map(([ф]) => `«${ф}» → ${JSON.stringify(parseDirectCommand(ф))}`).join('; ')}` },
  );

  if (process.platform !== 'win32') {
    запиши('живые команды в браузере', {
      вид: 'нечем мерить',
      почему: `живой прогон собран под Windows, здесь ${process.platform}`,
    });
    печатать(итоги);
    return;
  }

  const s = new Сервер();
  const desktop = createDesktopDriver();
  let блокнотPid: number | null = null;

  try {
    await s.поднять();
    await s.инструмент('browser_open', { url: страница() });

    // Чистый старт. Профиль браузера Джарвиса переживает прогон: второй запуск
    // этой же проверки начался с лишней вкладки about:blank, активной была она,
    // и «открой третью ссылку» честно не нашло ни одной ссылки. Закрываем всё,
    // кроме своей страницы.
    for (let раз = 0; раз < 8; раз++) {
      const лишняя = вкладки(await s.инструмент('browser_tabs', { action: 'list' })).find(
        (л) => !/Проба ссылок/u.test(л),
      );
      if (!лишняя) break;
      const номер = /(\d+)[.)]/u.exec(лишняя)?.[1];
      if (!номер) break;
      await s.инструмент('browser_tabs', { action: 'close', target: номер });
    }
    await s.инструмент('browser_tabs', { action: 'switch', target: 'Проба ссылок' });

    // Pid своего браузера — по окну со своей страницей: заголовок у неё
    // единственный, и это ещё до всяких нажатий.
    let нашPid = 0;
    await ждать(async () => {
      нашPid = (await desktop.windows()).find((о) => /Проба ссылок/u.test(о.title))?.pid ?? 0;
      return нашPid > 0;
    }, 10_000);
    if (!нашPid) {
      запиши('окно браузера проверки', { вид: 'нечем мерить', почему: 'окно со своей страницей не появилось за 10 с' });
      return;
    }

    // Блокнот — впереди. Запускаем сами и берём ТОЛЬКО новый процесс.
    //
    // Блокнот Windows 11 — один процесс на все окна: второй запуск добавляет
    // вкладку в уже открытый. Первая версия проверки брала любое окно блокнота
    // — то есть и окно человека, если оно было, — и в конце гасила его по pid.
    // Правило «гасить только своё» так соблюдалось лишь на словах. Теперь pid
    // запоминаются до запуска, и блокнот, открытый человеком, — это «нечем
    // мерить», а не повод его закрыть.
    const былиPid = new Set(
      окнаИз(await s.инструмент('window_list', {}))
        .filter((о) => /notepad/iu.test(о.app))
        .map((о) => о.pid),
    );
    if (былиPid.size > 0) {
      запиши('впереди блокнот, а не браузер', {
        вид: 'нечем мерить',
        почему: 'у человека уже открыт блокнот: новый процесс не появится, а его окно проверка не трогает',
      });
      return;
    }
    spawn('notepad.exe', [], {
      detached: true,
      stdio: 'ignore',
    }).unref();
    let блокнот: Окно | undefined;
    await ждать(async () => {
      блокнот = окнаИз(await s.инструмент('window_list', {})).find(
        (о) => /notepad/iu.test(о.app) && !былиPid.has(о.pid),
      );
      return Boolean(блокнот);
    }, 20_000);
    if (!блокнот) {
      запиши('впереди блокнот, а не браузер', { вид: 'нечем мерить', почему: 'свой блокнот не открылся за 20 с' });
      return;
    }
    блокнотPid = блокнот.pid;
    // Фокус могут не отдать: живой прогон 26.09.2026 упал на «впереди
    // „Переключение задач“» — человек работал за машиной и нажал Alt+Tab.
    // Это про машину, а не про Джарвиса: «нечем мерить», а не исключение.
    try {
      await desktop.focus(блокнот.title);
    } catch (беда) {
      запиши('впереди блокнот, а не браузер', {
        вид: 'нечем мерить',
        почему: `фокус не отдали: ${беда instanceof Error ? беда.message : String(беда)}`,
      });
      return;
    }
    await пауза(500);
    const переднее = (await desktop.windows()).find((о) => о.focused);
    const впередиНеБраузер = Boolean(переднее) && !этоОкноБраузера(переднее as { title: string });
    запиши(
      'впереди блокнот, а не браузер',
      впередиНеБраузер
        ? { вид: 'прошло', чем: `впереди «${переднее?.title.slice(0, 40)}»` }
        : { вид: 'нечем мерить', почему: `вперёд вышло «${переднее?.title ?? 'ничего'}»` },
    );

    // 2. «Открой третью ссылку» при блокноте впереди.
    {
      const к = parseDirectCommand('открой третью ссылку');
      try {
        if (к?.kind !== 'openLink') throw new Error('фраза не разобралась');
        const нажата = await открытьСсылку(desktop, к.index);
        const дошло = await ждать(async () => /#three/u.test(активная(await s.инструмент('browser_tabs', { action: 'list' }))), 5_000);
        запиши(
          '«открой третью ссылку» при блокноте впереди',
          дошло
            ? { вид: 'прошло', чем: `нажата «${нажата.name}», адрес стал …#three` }
            : { вид: 'не прошло', почему: `нажата «${нажата.name}», но адрес не …#three: ${активная(await s.инструмент('browser_tabs', { action: 'list' })).trim().slice(0, 120)}` },
        );
      } catch (беда) {
        запиши('«открой третью ссылку» при блокноте впереди', {
          вид: 'не прошло',
          почему: беда instanceof Error ? беда.message : String(беда),
        });
      }
    }

    // 2б. «Открой первую ссылку» — граница. Панель браузера тоже держит ссылку
    // («Управление избранным»), и она стоит в дереве РАНЬШЕ ссылок страницы.
    // Не отсеки её — и первой окажется она, а не первая ссылка страницы.
    if (!(await блокнотВперёд(desktop, блокнот.title))) {
      запиши('«открой первую ссылку» — первая страницы, а не кнопка браузера', { вид: 'нечем мерить', почему: 'фокус не отдали' });
    } else {
      const к = parseDirectCommand('открой первую ссылку');
      try {
        if (к?.kind !== 'openLink') throw new Error('фраза не разобралась');
        const нажата = await открытьСсылку(desktop, к.index);
        const дошло = await ждать(async () => /#one/u.test(активная(await s.инструмент('browser_tabs', { action: 'list' }))), 5_000);
        запиши(
          '«открой первую ссылку» — первая страницы, а не кнопка браузера',
          дошло
            ? { вид: 'прошло', чем: `нажата «${нажата.name}», адрес …#one` }
            : { вид: 'не прошло', почему: `нажата «${нажата.name}», адрес не …#one` },
        );
      } catch (беда) {
        запиши('«открой первую ссылку» — первая страницы, а не кнопка браузера', {
          вид: 'не прошло',
          почему: беда instanceof Error ? беда.message : String(беда),
        });
      }
    }

    // 3. «Открой последнюю ссылку».
    if (!(await блокнотВперёд(desktop, блокнот.title))) {
      запиши('«открой последнюю ссылку» берёт последнюю страницы, а не браузера', { вид: 'нечем мерить', почему: 'фокус не отдали' });
    } else {
      const к = parseDirectCommand('открой последнюю ссылку');
      try {
        if (к?.kind !== 'openLink') throw new Error('фраза не разобралась');
        const нажата = await открытьСсылку(desktop, к.index);
        const дошло = await ждать(async () => /#five/u.test(активная(await s.инструмент('browser_tabs', { action: 'list' }))), 5_000);
        запиши(
          '«открой последнюю ссылку» берёт последнюю страницы, а не браузера',
          дошло
            ? { вид: 'прошло', чем: `нажата «${нажата.name}», адрес …#five` }
            : { вид: 'не прошло', почему: `нажата «${нажата.name}», адрес не …#five` },
        );
      } catch (беда) {
        запиши('«открой последнюю ссылку» берёт последнюю страницы, а не браузера', {
          вид: 'не прошло',
          почему: беда instanceof Error ? беда.message : String(беда),
        });
      }
    }

    // 4. «Новая вкладка» при блокноте впереди.
    if (!(await блокнотВперёд(desktop, блокнот.title))) {
      запиши('«новая вкладка» открывается в браузере, а не в блокноте', { вид: 'нечем мерить', почему: 'фокус не отдали' });
    } else {
      const нельзя = await выбраноНаше(desktop, нашPid);
      if (нельзя) {
        запиши('«новая вкладка» открывается в браузере, а не в блокноте', { вид: 'нечем мерить', почему: нельзя });
      } else {
        const было = await вкладокВОкне(desktop, нашPid);
        const до = await впереди(desktop);
        const к = parseDirectCommand('новая вкладка');
        if (к?.kind === 'key') await нажать(desktop, к.keys);
        const после = await впереди(desktop);
        const стало = было !== null && (await ждать(async () => (await вкладокВОкне(desktop, нашPid)) === было + 1, 6_000));
        запиши(
          '«новая вкладка» открывается в браузере, а не в блокноте',
          было === null
            ? { вид: 'нечем мерить', почему: 'окно браузера проверки не найдено' }
            : стало
              ? { вид: 'прошло', чем: `вкладок было ${было}, стало ${было + 1}; впереди до «${до}», после «${после}»` }
              : {
                  вид: 'не прошло',
                  почему: `вкладок было ${было}, стало ${String(await вкладокВОкне(desktop, нашPid))}; впереди до «${до}», после «${после}»`,
                },
        );
      }
    }

    // 5. «Закрой вкладку» при блокноте впереди — тот самый случай.
    if (!(await блокнотВперёд(desktop, блокнот.title))) {
      запиши('«закрой вкладку» закрывает вкладку браузера, а блокнот не трогает', { вид: 'нечем мерить', почему: 'фокус не отдали' });
    } else {
      const нельзя = await выбраноНаше(desktop, нашPid);
      if (нельзя) {
        запиши('«закрой вкладку» закрывает вкладку браузера, а блокнот не трогает', { вид: 'нечем мерить', почему: нельзя });
        return;
      }
      const было = await вкладокВОкне(desktop, нашPid);
      const до = await впереди(desktop);
      const к = parseDirectCommand('закрой вкладку');
      if (к?.kind === 'key') await нажать(desktop, к.keys);
      const закрылась = было !== null && (await ждать(async () => (await вкладокВОкне(desktop, нашPid)) === было - 1, 6_000));
      console.log(`    закрой вкладку: впереди до «${до}», после «${await впереди(desktop)}», вкладок ${String(было)} → ${String(await вкладокВОкне(desktop, нашPid))}`);
      const блокнотЖив = окнаИз(await s.инструмент('window_list', {})).some((о) => о.pid === блокнотPid);
      запиши(
        '«закрой вкладку» закрывает вкладку браузера, а блокнот не трогает',
        закрылась && блокнотЖив
          ? { вид: 'прошло', чем: `вкладок было ${было}, стало ${было - 1}; блокнот на месте` }
          : {
              вид: 'не прошло',
              почему: `вкладка закрылась: ${закрылась}; блокнот жив: ${блокнотЖив} — если нет, Ctrl+W ушёл в него`,
            },
      );
    }
  } finally {
    desktop.dispose();
    s.закрыть();
    if (блокнотPid !== null) {
      try {
        process.kill(блокнотPid);
        console.log(`    убрал за собой блокнот, pid ${блокнотPid}`);
      } catch {
        // уже закрыт
      }
    }
    печатать(итоги);
  }
}

function печатать(итоги: Array<{ имя: string; итог: Итог }>): void {
  let прошло = 0;
  let неПрошло = 0;
  let нечем = 0;
  for (const { имя, итог } of итоги) {
    if (итог.вид === 'прошло') {
      прошло++;
      console.log(`  прошло       ${имя} — ${итог.чем}`);
    } else if (итог.вид === 'не прошло') {
      неПрошло++;
      console.log(`  НЕ ПРОШЛО    ${имя} — ${итог.почему}`);
    } else {
      нечем++;
      console.log(`  нечем мерить ${имя} — ${итог.почему}`);
    }
  }
  console.log('');
  console.log(`Всего ${прошло + неПрошло + нечем}: прошло ${прошло}, не прошло ${неПрошло}, нечем мерить ${нечем}`);
  process.exitCode = неПрошло > 0 ? 1 : нечем > 0 ? 2 : 0;
}

void main().then(() => process.exit(process.exitCode ?? 0));
