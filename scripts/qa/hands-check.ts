/**
 * Живая проверка рук Джарвиса через настоящий MCP-сервер.
 *
 * Не через внутренние функции, а через тот самый `mcp.cjs`, который запускает
 * Claude Code: инструменты, их разбор аргументов, драйвер, браузер, блендер —
 * всё, как у агента. Проверка «внутри процесса» этого не доказывает: живой
 * прогон 26.09.2026 показал, что можно иметь зелёные модульные тесты и
 * неработающий ввод в браузере.
 *
 * Отвечает тремя способами, как велит AGENTS.md: прошло, не прошло, нечем
 * мерить. Ничего из чужого не гасит и не закрывает: закрывает ровно то, что
 * запустила сама, и по записанному pid.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { listInstalledPrograms } from '../../jarvis/apps/installed';
import { aliasTarget, spokenCloseTarget, spokenTarget, windowAlias } from '../../jarvis/apps/launch';
import { chooseShortcut } from '../../jarvis/apps/startMenu';

type Итог =
  | { вид: 'прошло'; чем?: string }
  | { вид: 'не прошло'; почему: string }
  | { вид: 'нечем мерить'; почему: string };

interface Проверка {
  имя: string;
  запуск(): Promise<Итог>;
}

const ЗАПУЩЕНО = new Set<number>();

/* ------------------------------------------------------------------ MCP --- */

class Сервер {
  private child: ChildProcess | null = null;
  private buffer = '';
  private next = 10;
  private readonly ждут = new Map<number, { ok(v: unknown): void; bad(e: Error): void }>();

  async поднять(): Promise<void> {
    const child = spawn(process.execPath, ['dist/jarvis/desktop/mcp.cjs'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, JARVIS_LANGUAGE: 'ru' },
    });
    this.child = child;
    child.stdout?.on('data', (c: Buffer) => this.взять(c.toString('utf8')));
    // Ошибки сервера видеть надо: молчащий сервер и сервер, упавший с
    // объяснением, — разные новости.
    child.stderr?.on('data', (c: Buffer) => {
      const текст = c.toString('utf8').trim();
      if (текст) console.log(`    [сервер] ${текст.slice(0, 300)}`);
    });
    await this.спросить('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'hands-check', version: '1' },
    });
    child.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  }

  private взять(text: string): void {
    this.buffer += text;
    let end: number;
    while ((end = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, end).trim();
      this.buffer = this.buffer.slice(end + 1);
      if (!line.startsWith('{')) continue;
      let m: { id?: number; result?: unknown; error?: unknown };
      try {
        m = JSON.parse(line) as typeof m;
      } catch {
        continue;
      }
      if (m.id === undefined) continue;
      const место = this.ждут.get(m.id);
      if (!место) continue;
      this.ждут.delete(m.id);
      if (m.error) место.bad(new Error(JSON.stringify(m.error)));
      else место.ok(m.result);
    }
  }

  private спросить(method: string, params: unknown, ждатьМс = 120_000): Promise<unknown> {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.ждут.delete(id);
        reject(new Error(`сервер молчит дольше ${Math.round(ждатьМс / 1000)} с на ${method}`));
      }, ждатьМс);
      this.ждут.set(id, {
        ok: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        bad: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.child?.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  /** Позвать инструмент. Отказ инструмента приходит полем isError, не ошибкой. */
  async инструмент(name: string, args: Record<string, unknown>, ждатьМс = 120_000): Promise<string> {
    const r = (await this.спросить('tools/call', { name, arguments: args }, ждатьМс)) as {
      content?: { text?: string }[];
      isError?: boolean;
    };
    const текст = (r.content ?? []).map((c) => c.text ?? '').join('');
    if (r.isError === true) throw new Error(текст || 'инструмент отказал без объяснения');
    return текст;
  }

  async список(): Promise<string[]> {
    const r = (await this.спросить('tools/list', {})) as { tools?: { name: string }[] };
    return (r.tools ?? []).map((t) => t.name);
  }

  закрыть(): void {
    const child = this.child;
    this.child = null;
    child?.kill();
  }
}

/* --------------------------------------------------------------- помощь --- */

interface Окно {
  pid: number;
  windowId: number;
  title: string;
  app: string;
}

/**
 * Окна из ответа window_list.
 *
 * Вид снят с живого сервера, а не придуман: «заголовок — программа.exe, pid N,
 * окно M». Первая попытка разбирала сырой вид драйвера (`"заголовок"
 * [window_id: M]`) и не находила НИ ОДНОГО окна при пяти на экране — проверка
 * при этом честно сказала «список окон пуст», и по этому и нашлась ошибка
 * разбора, а не поломка в Джарвисе.
 *
 * Заголовок берём жадно: в нём сами живут тире и длинные тире («PDFgear … —
 * Личный: Microsoft Edge»), и обрывать по первому значит терять половину.
 */
function окнаИз(текст: string): Окно[] {
  const окна: Окно[] = [];
  const строка = /^(.+) — (\S+), pid (\d+), окно (\d+)\s*$/gmu;
  for (const м of текст.matchAll(строка)) {
    окна.push({ title: (м[1] ?? '').trim(), app: м[2] ?? '', pid: Number(м[3]), windowId: Number(м[4]) });
  }
  return окна;
}

/** Сколько вкладок в ответе browser_tabs. Активная помечена стрелкой. */
function вкладок(текст: string): number {
  return (текст.match(/^\s*(?:→\s*)?\d+[.)]/gmu) ?? []).length;
}

/** Страница с полем — чтобы ввод было куда вводить и чем прочитать. */
function страницаСПолем(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'jarvis-hands-'));
  const файл = path.join(dir, 'поле.html');
  const nl = String.fromCharCode(10);
  writeFileSync(
    файл,
    [
      '<!doctype html><html lang="ru"><head><meta charset="utf-8">',
      '<title>Проба рук Джарвиса</title></head><body>',
      '<h1>Проба рук Джарвиса</h1>',
      '<label for="p">Поле пробы</label>',
      '<input id="p" name="Поле пробы" placeholder="Поле пробы">',
      '<div id="эхо">пусто</div>',
      '<script>',
      "document.getElementById('p').addEventListener('input', function (e) {",
      "  document.getElementById('эхо').textContent = 'введено: ' + e.target.value;",
      '});',
      '</script>',
      '</body></html>',
    ].join(nl),
    'utf8',
  );
  return файл;
}

/* -------------------------------------------------------------- проверки --- */

function проверки(s: Сервер): Проверка[] {
  // Что нашли в одной проверке, нужно следующей: окно браузера, pid блендера.
  const общее: { браузер?: Окно; блендерPid?: number; запущенное?: Окно } = {};

  return [
    {
      имя: 'сервер: инструменты рук на месте',
      async запуск() {
        const все = await s.список();
        const нужны = [
          'window_list', 'window_look', 'window_find', 'window_press', 'window_write',
          'window_key', 'focus_window', 'browser_open', 'browser_fill', 'browser_read',
          'browser_tabs', 'blender_live_start', 'blender_live',
        ];
        const нет = нужны.filter((и) => !все.includes(и));
        if (нет.length > 0) return { вид: 'не прошло', почему: `нет инструментов: ${нет.join(', ')}` };
        return { вид: 'прошло', чем: `${все.length} инструментов, все нужные есть` };
      },
    },

    {
      имя: 'окна: список видит живой экран',
      async запуск() {
        const окна = окнаИз(await s.инструмент('window_list', {}));
        if (окна.length === 0) return { вид: 'не прошло', почему: 'список окон пуст при живом экране' };
        return { вид: 'прошло', чем: `${окна.length} окон: ${окна.slice(0, 3).map((о) => о.app).join(', ')}` };
      },
    },

    {
      имя: 'браузер: открытие страницы и её заголовок',
      async запуск() {
        const файл = страницаСПолем();
        const ответ = await s.инструмент('browser_open', { url: `file:///${файл.replace(/\\/gu, '/')}` });
        if (!/Проба рук Джарвиса/u.test(ответ)) {
          return { вид: 'не прошло', почему: `заголовок не дошёл: ${ответ.slice(0, 200)}` };
        }
        return { вид: 'прошло', чем: 'страница открылась и назвала себя' };
      },
    },

    {
      имя: 'браузер: ввод доходит до страницы, а не только отчитывается',
      async запуск() {
        await s.инструмент('browser_fill', { label: 'Поле пробы', value: 'живая проба 42' });
        // Читаем страницу ЗАНОВО: отчёт инструмента — это его слово, а эхо на
        // странице пишет сам обработчик ввода, то есть браузер.
        const текст = await s.инструмент('browser_read', {});
        if (!/введено: живая проба 42/u.test(текст)) {
          return {
            вид: 'не прошло',
            почему: `эхо страницы не подтверждает ввод: ${текст.replace(/\s+/gu, ' ').slice(0, 220)}`,
          };
        }
        return { вид: 'прошло', чем: 'страница подтвердила введённое своим обработчиком' };
      },
    },

    {
      имя: 'браузер: вкладки открываются, переключаются и закрываются',
      async запуск() {
        await s.инструмент('browser_tabs', { action: 'open', url: 'about:blank' });
        const дваСписка = await s.инструмент('browser_tabs', { action: 'list' });
        const сколько = вкладок(дваСписка);
        if (сколько < 2) {
          return { вид: 'не прошло', почему: `вторая вкладка не появилась: ${дваСписка.slice(0, 200)}` };
        }
        await s.инструмент('browser_tabs', { action: 'switch', target: 'Проба рук' });
        const послеПереключения = await s.инструмент('browser_read', {});
        if (!/Проба рук Джарвиса/u.test(послеПереключения)) {
          return { вид: 'не прошло', почему: 'переключение на вкладку не сменило активную страницу' };
        }
        await s.инструмент('browser_tabs', { action: 'close', target: 'about:blank' });
        const послеЗакрытия = await s.инструмент('browser_tabs', { action: 'list' });
        if ((послеЗакрытия.match(/about:blank/gu) ?? []).length > 0) {
          return { вид: 'не прошло', почему: 'закрытая вкладка осталась в списке' };
        }
        return { вид: 'прошло', чем: `открыл, переключил и закрыл; было ${сколько} вкладки` };
      },
    },

    {
      имя: 'окна: окно браузера видно среди окон',
      async запуск() {
        const окна = окнаИз(await s.инструмент('window_list', {}));
        const наш = окна.find((о) => /Проба рук Джарвиса/u.test(о.title));
        if (!наш) {
          return {
            вид: 'не прошло',
            почему: `окна браузера нет в списке; есть: ${окна.map((о) => о.title.slice(0, 28)).join(' | ')}`,
          };
        }
        общее.браузер = наш;
        return { вид: 'прошло', чем: `${наш.app} pid=${наш.pid} «${наш.title.slice(0, 40)}»` };
      },
    },

    {
      имя: 'окна: переключение на окно по названию',
      async запуск() {
        if (!общее.браузер) return { вид: 'нечем мерить', почему: 'окно браузера не найдено выше' };
        const ответ = await s.инструмент('focus_window', { title: 'Проба рук Джарвиса' });
        if (/не нашёл|не вышло/iu.test(ответ)) {
          return { вид: 'не прошло', почему: ответ.slice(0, 200) };
        }
        // Драйвер сам отчитывается тем, что впереди НА САМОМ ДЕЛЕ.
        return { вид: 'прошло', чем: ответ.replace(/\s+/gu, ' ').slice(0, 120) };
      },
    },

    {
      имя: 'окна: отказ по несуществующему окну называет соседей',
      async запуск() {
        try {
          const ответ = await s.инструмент('focus_window', { title: 'окнокоторогонетнигде12345' });
          if (!/На экране|не нашёл/iu.test(ответ)) {
            return { вид: 'не прошло', почему: `отказ ничего не объяснил: ${ответ.slice(0, 200)}` };
          }
          return { вид: 'прошло', чем: ответ.replace(/\s+/gu, ' ').slice(0, 140) };
        } catch (беда) {
          const текст = беда instanceof Error ? беда.message : String(беда);
          if (!/На экране/u.test(текст)) {
            return { вид: 'не прошло', почему: `отказ без списка соседей: ${текст.slice(0, 200)}` };
          }
          if (/Na ekrane|Okno ne naydeno/u.test(текст)) {
            return { вид: 'не прошло', почему: 'отказ пришёл транслитом, человек это читает' };
          }
          return { вид: 'прошло', чем: текст.replace(/\s+/gu, ' ').slice(0, 140) };
        }
      },
    },

    {
      имя: 'окна: элемент находится и ввод в него доходит',
      async запуск() {
        if (!общее.браузер) return { вид: 'нечем мерить', почему: 'окно браузера не найдено выше' };
        const { pid, windowId } = общее.браузер;
        // Адресная строка есть у любого окна браузера и достижима через UIA —
        // ровно тот путь, который отказывал голым element_index.
        const найдено = await s.инструмент('window_find', { pid, window_id: windowId, name: 'Адресная строка' });
        const номер = /\[(\d+)\]|№\s*(\d+)|элемент (\d+)/u.exec(найдено);
        const индекс = Number(номер?.[1] ?? номер?.[2] ?? номер?.[3] ?? NaN);
        if (!Number.isFinite(индекс)) {
          return { вид: 'нечем мерить', почему: `номер элемента не разобран из: ${найдено.slice(0, 200)}` };
        }
        try {
          await s.инструмент('window_write', { pid, window_id: windowId, element: индекс, text: 'проба' });
        } catch (беда) {
          const текст = беда instanceof Error ? беда.message : String(беда);
          if (/bare element_index/u.test(текст)) {
            return { вид: 'не прошло', почему: 'драйвер снова получил голый номер вместо знака элемента' };
          }
          return { вид: 'не прошло', почему: текст.slice(0, 220) };
        }
        return { вид: 'прошло', чем: `элемент ${индекс} найден и принял текст` };
      },
    },

    {
      имя: 'окна: клавиша уходит в окно',
      async запуск() {
        if (!общее.браузер) return { вид: 'нечем мерить', почему: 'окно браузера не найдено выше' };
        const { pid, windowId } = общее.браузер;
        await s.инструмент('window_key', { pid, window_id: windowId, key: 'Escape' });
        return { вид: 'прошло', чем: 'Escape принят без отказа' };
      },
    },

    {
      имя: 'запуск: программа, которую ещё не открывали',
      async запуск() {
        // Блокнот выбран нарочно: он есть на любой Windows, ничего не ломает и
        // его закрытие безопасно. И это первое, что скажет вслух человек.
        const сказано = spokenTarget('открой блокнот');
        if (сказано !== 'блокнот') {
          return { вид: 'не прошло', почему: `фраза разобралась как ${JSON.stringify(сказано)}` };
        }
        const до = окнаИз(await s.инструмент('window_list', {}));
        if (до.some((о) => /notepad/iu.test(о.app))) {
          return { вид: 'нечем мерить', почему: 'блокнот уже открыт — «ещё не открывали» не проверить' };
        }

        const итог = await listInstalledPrograms();
        const searchable = [aliasTarget(сказано), сказано].filter(Boolean).join(' ');
        const найдено = chooseShortcut(searchable, итог.programs, (п) => п.name);
        if (!найдено) {
          return {
            вид: 'не прошло',
            почему: `«${сказано}» не нашлось среди ${итог.programs.length} установленных (искали «${searchable}», список полный: ${итог.полный})`,
          };
        }

        // Ровно тем же способом, каким запускает мост: приложение магазина —
        // через папку приложений оболочки, всё прочее — через `start`.
        const цель = найдено.item;
        const [команда, доводы] =
          цель.kind === 'aumid'
            ? ['explorer.exe', [`shell:AppsFolder${String.fromCharCode(92)}${цель.target}`]]
            : ['cmd.exe', ['/c', 'start', '', цель.target]];
        const дитя = spawn(команда, доводы, { detached: true, stdio: 'ignore' });
        дитя.unref();

        // Ждём ОКНО, а не код возврата: `start` и `explorer` возвращаются
        // сразу, и «запустил» по их коду — отчёт о том, чего ещё нет.
        const срок = Date.now() + 25_000;
        let окно: Окно | undefined;
        while (Date.now() < срок && !окно) {
          const сейчас = окнаИз(await s.инструмент('window_list', {}));
          окно = сейчас.find((о) => /notepad/iu.test(о.app));
        }
        if (!окно) {
          return {
            вид: 'не прошло',
            почему: `«${цель.name}» запущен как ${цель.kind}, но окно за 25 с не появилось`,
          };
        }
        общее.запущенное = окно;
        ЗАПУЩЕНО.add(окно.pid);
        return { вид: 'прошло', чем: `«${цель.name}» (${цель.kind}) → окно «${окно.title}» pid ${окно.pid}` };
      },
    },

    {
      имя: 'закрытие: сказанное имя находит именно эту программу',
      async запуск() {
        const окно = общее.запущенное;
        if (!окно) return { вид: 'нечем мерить', почему: 'блокнот не запускали выше' };

        const цель = spokenCloseTarget('закрой блокнот');
        if (цель !== 'блокнот') {
          return { вид: 'не прошло', почему: `фраза разобралась как ${JSON.stringify(цель)}` };
        }
        // Тем же правилом, каким его ищет мост: псевдоним окна, псевдоним
        // запуска и само сказанное — против имён запущенных программ.
        const searchable = [windowAlias(цель), aliasTarget(цель), цель].filter(Boolean).join(' ');
        const живые = окнаИз(await s.инструмент('window_list', {})).map((о) => ({
          name: о.app.replace(/\.exe$/iu, ''),
          pid: о.pid,
        }));
        const найдено = chooseShortcut(searchable, живые, (п) => п.name);
        if (!найдено) {
          return {
            вид: 'не прошло',
            почему: `«${цель}» не нашлось среди запущенных: ${живые.map((ж) => ж.name).join(', ')}`,
          };
        }
        if (найдено.item.pid !== окно.pid) {
          return {
            вид: 'не прошло',
            почему: `нашлось не то: ${найдено.item.name} pid ${найдено.item.pid}, а открывали pid ${окно.pid}`,
          };
        }
        return { вид: 'прошло', чем: `«${цель}» → ${найдено.item.name} pid ${найдено.item.pid}` };
      },
    },

    {
      имя: 'закрытие: окно правда исчезает с экрана',
      async запуск() {
        const окно = общее.запущенное;
        if (!окно) return { вид: 'нечем мерить', почему: 'блокнот не запускали выше' };
        // Гасим по ЗАПИСАННОМУ pid, а не по маске имени: уборка по маске
        // однажды снесла проводник и меню «Пуск».
        try {
          process.kill(окно.pid);
        } catch (беда) {
          return { вид: 'не прошло', почему: `pid ${окно.pid} не гасится: ${беда instanceof Error ? беда.message : String(беда)}` };
        }
        const срок = Date.now() + 15_000;
        while (Date.now() < срок) {
          const сейчас = окнаИз(await s.инструмент('window_list', {}));
          if (!сейчас.some((о) => о.pid === окно.pid)) {
            ЗАПУЩЕНО.delete(окно.pid);
            return { вид: 'прошло', чем: `окно pid ${окно.pid} ушло из списка` };
          }
        }
        return { вид: 'не прошло', почему: `окно pid ${окно.pid} осталось в списке через 15 с после закрытия` };
      },
    },

    {
      имя: 'блендер: живая сцена поднимается',
      async запуск() {
        const ответ = await s.инструмент('blender_live_start', {}, 180_000);
        if (/не наш|нет блендера|не установлен/iu.test(ответ)) {
          return { вид: 'нечем мерить', почему: ответ.slice(0, 200) };
        }
        const окна = окнаИз(await s.инструмент('window_list', {}));
        const блендер = окна.find((о) => /blender/iu.test(о.app));
        if (блендер) {
          общее.блендерPid = блендер.pid;
          ЗАПУЩЕНО.add(блендер.pid);
        }
        return { вид: 'прошло', чем: `${ответ.replace(/\s+/gu, ' ').slice(0, 110)}${блендер ? `, pid ${блендер.pid}` : ''}` };
      },
    },

    {
      имя: 'блендер: команда правит сцену, а не только отвечает',
      async запуск() {
        if (общее.блендерPid === undefined) {
          return { вид: 'нечем мерить', почему: 'блендер не поднялся' };
        }
        const nl = String.fromCharCode(10);
        // Создаём куб и СПРАШИВАЕМ сцену обратно: ответ инструмента — его
        // слово, а имя объекта из bpy — слово блендера.
        const код = [
          'import bpy',
          'bpy.ops.mesh.primitive_cube_add(location=(0, 0, 0))',
          'о = bpy.context.active_object',
          'о.name = "ПробаРук"',
          'print("СОЗДАН:", о.name, len(bpy.data.objects))',
        ].join(nl);
        const ответ = await s.инструмент('blender_live', { code: код }, 120_000);
        if (!/СОЗДАН: ПробаРук/u.test(ответ)) {
          return { вид: 'не прошло', почему: `сцена не подтвердила объект: ${ответ.replace(/\s+/gu, ' ').slice(0, 220)}` };
        }
        const проверка = await s.инструмент('blender_live', {
          code: ['import bpy', 'print("ЕСТЬ:", "ПробаРук" in bpy.data.objects)'].join(nl),
        }, 120_000);
        if (!/ЕСТЬ: True/u.test(проверка)) {
          return { вид: 'не прошло', почему: `объект не дожил до второго вопроса: ${проверка.slice(0, 200)}` };
        }
        return { вид: 'прошло', чем: 'куб создан, назван и найден вторым запросом' };
      },
    },

    {
      имя: 'блендер: промах по имени объекта назван честно',
      async запуск() {
        if (общее.блендерPid === undefined) {
          return { вид: 'нечем мерить', почему: 'блендер не поднялся' };
        }
        const nl = String.fromCharCode(10);
        const код = [
          'import bpy',
          'о = bpy.data.objects.get("ТакогоНетСовсем")',
          'if о is None:',
          '    raise RuntimeError("не нашёл, что править")',
        ].join(nl);
        try {
          const ответ = await s.инструмент('blender_live', { code: код }, 120_000);
          if (!/не нашёл, что править/u.test(ответ)) {
            return { вид: 'не прошло', почему: `ошибка сцены не доехала: ${ответ.slice(0, 200)}` };
          }
          return { вид: 'прошло', чем: 'причина названа дословно, а не «не удалось»' };
        } catch (беда) {
          const текст = беда instanceof Error ? беда.message : String(беда);
          if (!/не нашёл, что править/u.test(текст)) {
            return { вид: 'не прошло', почему: `причина потеряна: ${текст.slice(0, 200)}` };
          }
          return { вид: 'прошло', чем: 'причина названа дословно в отказе инструмента' };
        }
      },
    },
  ];
}

/* ----------------------------------------------------------------- бег --- */

async function main(): Promise<void> {
  if (process.platform !== 'win32') {
    console.log(`Замер рассчитан на Windows, а здесь ${process.platform}.`);
    process.exit(2);
  }

  console.log('');
  console.log('Руки Джарвиса через настоящий MCP-сервер');
  console.log('');

  const s = new Сервер();
  let прошло = 0;
  let неПрошло = 0;
  let нечем = 0;

  try {
    await s.поднять();
    for (const п of проверки(s)) {
      let итог: Итог;
      try {
        итог = await п.запуск();
      } catch (беда) {
        итог = {
          вид: 'не прошло',
          почему: (беда instanceof Error ? беда.message : String(беда)).replace(/\s+/gu, ' ').slice(0, 260),
        };
      }
      const метка = итог.вид.padEnd(13);
      if (итог.вид === 'прошло') {
        прошло++;
        console.log(`  ${метка}${п.имя}${итог.чем ? ` — ${итог.чем}` : ''}`);
      } else if (итог.вид === 'не прошло') {
        неПрошло++;
        console.log(`  ${метка}${п.имя} — ${итог.почему}`);
      } else {
        нечем++;
        console.log(`  ${метка}${п.имя} — ${итог.почему}`);
      }
    }
  } finally {
    s.закрыть();
    // Гасим только то, что запустили сами, и по записанному pid: уборка по
    // маске однажды снесла проводник и меню «Пуск».
    for (const pid of ЗАПУЩЕНО) {
      try {
        process.kill(pid);
        console.log(`    убрал за собой pid ${pid}`);
      } catch {
        // Уже закрылся — и хорошо.
      }
    }
  }

  console.log('');
  console.log(`Всего ${прошло + неПрошло + нечем}: прошло ${прошло}, не прошло ${неПрошло}, нечем мерить ${нечем}`);
  process.exit(неПрошло > 0 ? 1 : нечем > 0 ? 2 : 0);
}

void main();
