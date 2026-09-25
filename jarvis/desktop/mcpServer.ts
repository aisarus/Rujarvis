/**
 * The desktop, offered to Claude Code as tools.
 *
 * This is what makes agentic computer use possible on a subscription rather
 * than an API key: Claude Code speaks MCP, MCP tools may return images, and so
 * the model can look at the screen, decide, act, and look again. No key, no
 * per-token billing — the same subscription the user already pays for.
 *
 * It deliberately does not reuse the runtime's own desktop driver. That one
 * reaches its tools through two nested shells, the JSON argument is destroyed
 * by quoting, and it reports success anyway — a model cannot work against a
 * tool that lies about what it did.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';

import { forget, recall, remember } from './agentMemory';
import * as blender from './blender';
import * as browser from './browser';
import * as files from './files';
import { JournalStore } from '../memory/journalStore';
import { NoteStore } from '../dialogue/noteStore';
import { renderNotes } from '../dialogue/notes';
import { PlanStore } from '../agent/planStore';
import { inkOfPage, probePage, ridePage } from './pageTravel';
import * as live from './blenderLive';
import * as krita from './kritaLive';
import * as comfy from './comfy';
import * as mid from './inbetween';
import { makePlan, markStep, renderPlan, type StepState } from '../agent/plan';
import { buildSkillFile, isSelfAuthored, skillPath } from '../skills/author';
import { createDesktopDriver } from './platform';
import { createWindowTools } from './windowTools';
import { jarvisDataRoot } from '../setup/paths';

const driver = createDesktopDriver();
// Глаза и руки по чужим окнам. На Windows это cua-driver: он поднимается при
// первом обращении и живёт дальше — прогрев стоит около двух секунд, каждое
// следующее действие десятки мс. На маке то же самое делают System Events и
// CoreGraphics, и поднимать там нечего.
const cua = createWindowTools();
const shotDir = mkdtempSync(path.join(os.tmpdir(), 'jarvis-shots-'));
let shotCounter = 0;

/** Text answer, the shape every tool here returns on success. */
function say(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function failed(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  // isError matters: without it a failure reads to the model as a result, and
  // it proceeds as though the click had landed.
  return { content: [{ type: 'text' as const, text: `Не удалось: ${message}` }], isError: true };
}

/**
 * Где живут навыки.
 *
 * Та же папка, что читает Claude Code при запуске: записанное сюда становится
 * доступно в следующем же запуске, без перезапуска чего-либо.
 */
function skillsRoot(): string {
  return (
    process.env.JARVIS_SKILLS_DIR?.trim() ||
    path.join(os.homedir(), '.claude', 'skills')
  );
}

/**
 * Тот же журнал, что ведёт сам Джарвис.
 *
 * Путь приходит из окружения: сервер — отдельный процесс и рабочего стола не
 * знает. Своя отдельная память здесь была бы хуже отсутствия — агент помнил бы
 * не то, что произошло.
 */
/**
 * Ящик правок, которые человек сказал уже во время работы.
 *
 * Тот же файл, в который их кладёт голосовой мост. Путь приходит из окружения
 * по той же причине, что и путь журнала: сервер — отдельный процесс.
 */
function openNotes(): NoteStore {
  // Домашняя папка — из paths.ts: собранная здесь руками, она была виндовой
  // на любой машине, и на маке заметки уезжали в ~/AppData/Local/Rujarvis.
  const file =
    process.env.JARVIS_NOTES?.trim() ||
    path.join(
      jarvisDataRoot(),
      'notes.json',
    );
  return new NoteStore(file);
}

/**
 * План работы. Тот же файл, что показывает окно.
 */
function openPlan(): PlanStore {
  const file =
    process.env.JARVIS_PLAN?.trim() ||
    path.join(
      jarvisDataRoot(),
      'plan.json',
    );
  return new PlanStore(file);
}

function openJournal(): JournalStore {
  const file =
    process.env.JARVIS_JOURNAL?.trim() ||
    path.join(
      jarvisDataRoot(),
      'journal.json',
    );
  return new JournalStore(file);
}

/**
 * Дождаться окна Blender, а не поверить в него.
 *
 * Программа поднимается несколько секунд, поэтому смотрим несколько раз.
 * Отсутствие окна — обычный ответ, а не ошибка: бывает, что Blender не успел
 * или не смог открыть файл.
 */
async function blenderWindowAppeared(attempts = 6, everyMs = 1_500, файл?: string): Promise<boolean> {
  for (let index = 0; index < attempts; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, everyMs));
    try {
      const windows = await driver.windows();
      // Ищем ИМЕННО ЭТОТ файл, а не «хоть какой-нибудь Blender».
      //
      // Blender пишет имя файла в заголовок. Без этой проверки уже открытое
      // окно — живой Blender или другая сцена — засчитывалось сразу, и
      // инструмент отвечал «Открыл в окне Blender: …», хотя новый процесс не
      // поднялся. Ровно ту ложь проверка и заведена ловить.
      const имя = файл ? path.basename(файл).toLowerCase() : '';
      if (
        windows.some(
          (item) =>
            /blender/iu.test(item.title) && (!имя || item.title.toLowerCase().includes(имя)),
        )
      ) {
        return true;
      }
    } catch {
      // Драйвер мог быть занят — просто пробуем ещё раз.
    }
  }
  return false;
}

/**
 * Стена, о которую ударился инструмент, попадает в журнал.
 *
 * ## Зачем
 *
 * Уроки для промпта («на чём ты уже спотыкался») собираются из журнала. Замер
 * 20.09.2026: из 34 записей об ошибках 21 была отменой человека, 10 — нашей
 * собственной поломкой окружения, и только две настоящими. То есть источника
 * у механизма фактически не было.
 *
 * А настоящие стены были — и остались в чужих записях: прокрутка вниз падала
 * на беззнаковом числе, сочетания с Ctrl терялись, открытие файла молча не
 * открывало. Каждая стоила отдельного прогона, и ни одна не дошла до
 * следующей задачи, потому что неудача инструмента нигде не сохранялась.
 *
 * Теперь сохраняется. Одно место на все инструменты — то же, через которое
 * доставляются правки.
 */
function rememberWall(name: string, result: { isError?: boolean; content?: unknown[] }): void {
  if (!result?.isError) return;
  try {
    const текст = (result.content ?? [])
      .map((часть) => (часть as { type?: string; text?: string }))
      .filter((часть) => часть.type === 'text')
      .map((часть) => часть.text ?? '')
      .join(' ')
      .trim();
    // Имя инструмента обязательно: «не удалось» без него не урок, а жалоба.
    openJournal().record({
      kind: 'error',
      text: `инструмент ${name}: ${текст || 'не удалось'}`.slice(0, 300),
    });
  } catch {
    // Журнал недоступен — это не повод ронять действие, которое и так не
    // удалось. Урок дороже задачи, но задача дороже урока о задаче.
  }
}

/**
 * Правка догоняет агента на первом же действии.
 *
 * ## Зачем
 *
 * Ящик правок работал по доброй воле: агент заглядывал в него инструментом
 * check_notes, когда вспоминал. Замер 20.09.2026 по журналу и логам прогонов:
 * человек сказал 63 поправки на ходу, за 22 из них последовало заглядывание в
 * ящик в ближайшие пять минут. Сорок одна правка не дошла ни до кого.
 *
 * И дело не в дисциплине: крупный шаг длится минуты, а между шагами агент
 * заглядывает не всегда. Человек это видит как «нет механизмов для внесения
 * коррективов» — он говорит, ему отвечают «учту», и ничего не меняется.
 *
 * ## Как теперь
 *
 * Ящик не опрашивают — его доставляют. К ответу ЛЮБОГО инструмента
 * приклеивается то, что человек успел сказать. Агент вызывает инструменты
 * постоянно (в тех же прогонах: 46 отметок шага, 33 снимка экрана), поэтому
 * правка доезжает за одно действие, а не за один приступ сознательности.
 *
 * ## Что здесь важно не сломать
 *
 * Забирается разом и с очисткой — той же `take()`, что и у check_notes. Иначе
 * правка приклеится к каждому следующему ответу, и «сделай на два тона темнее»
 * превратится в чёрный цвет. Сам check_notes пропускается: он и так отдаёт
 * ящик, и приклеивать ему нечего.
 */
function deliverNotesWithEveryTool(server: McpServer): void {
  const original = server.registerTool.bind(server) as (...args: unknown[]) => unknown;

  const wrapped = (name: string, config: unknown, handler: unknown): unknown => {
    const call = handler as (...args: unknown[]) => Promise<{ content?: unknown[] }>;
    const withNotes = async (...args: unknown[]): Promise<{ content?: unknown[] }> => {
      const result = await call(...args);

      rememberWall(name, result);

      // check_notes сам отдаёт ящик — второй раз показывать нечего.
      if (name === 'check_notes') return result;

      let notes;
      try {
        notes = openNotes().take();
      } catch {
        // Ящик недоступен — это не повод ронять действие, которое удалось.
        return result;
      }
      if (notes.length === 0) return result;

      return {
        ...result,
        content: [...(result.content ?? []), { type: 'text' as const, text: renderNotes(notes) }],
      };
    };
    return original(name, config, withNotes);
  };

  (server as unknown as { registerTool: unknown }).registerTool = wrapped;
}

export function createDesktopMcpServer(): McpServer {
  const server = new McpServer({ name: 'jarvis-desktop', version: '1.0.0' });
  deliverNotesWithEveryTool(server);

  server.registerTool(
    'screenshot',
    {
      title: 'Снимок экрана',
      description:
        'Снимает экран и возвращает изображение. Координаты на снимке совпадают с экранными, ' +
        'поэтому по нему можно сразу кликать. Делай снимок после каждого действия, которое ' +
        'меняет экран, — иначе решения принимаются по устаревшей картинке.',
      inputSchema: {
        region: z
          .object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() })
          .optional()
          .describe('Часть экрана. Без неё снимается весь экран.'),
      },
    },
    async ({ region }) => {
      try {
        const file = path.join(shotDir, `shot-${shotCounter++}.png`);
        const shot = await driver.screenshot(file, region);
        const data = readFileSync(shot.path).toString('base64');
        return {
          content: [
            { type: 'text' as const, text: `Экран ${shot.width}×${shot.height}, начало в (${shot.x}, ${shot.y}).` },
            { type: 'image' as const, data, mimeType: 'image/png' },
          ],
        };
      } catch (error) {
        return failed(error);
      }
    },
  );

  server.registerTool(
    'click',
    {
      title: 'Клик мышью',
      description: 'Кликает по экранным координатам. Перед кликом убедись по снимку, что цель там, где ты думаешь.',
      inputSchema: {
        x: z.number().describe('Координата X на экране'),
        y: z.number().describe('Координата Y на экране'),
        button: z.enum(['left', 'right', 'middle']).optional(),
        double: z.boolean().optional().describe('Двойной клик'),
      },
    },
    async ({ x, y, button, double }) => {
      try {
        await driver.click({ x, y, button, double });
        return say(`Кликнул в (${x}, ${y})${double ? ' дважды' : ''}.`);
      } catch (error) {
        return failed(error);
      }
    },
  );

  server.registerTool(
    'type_text',
    {
      title: 'Ввести текст',
      description:
        'Печатает текст в активное окно. Работает с любой раскладкой и с кириллицей. ' +
        'Сначала кликни в поле ввода — текст идёт туда, где курсор.',
      inputSchema: { text: z.string() },
    },
    async ({ text }) => {
      try {
        await driver.type(text);
        return say(`Напечатал ${text.length} символов.`);
      } catch (error) {
        return failed(error);
      }
    },
  );

  server.registerTool(
    'press_key',
    {
      title: 'Нажать клавиши',
      description:
        'Нажимает клавишу или сочетание: «enter», «ctrl+c», «alt+tab», «win», «f5». ' +
        'Модификаторы через плюс.',
      inputSchema: { keys: z.string() },
    },
    async ({ keys }) => {
      try {
        await driver.key(keys);
        return say(`Нажал ${keys}.`);
      } catch (error) {
        return failed(error);
      }
    },
  );

  server.registerTool(
    'scroll',
    {
      title: 'Прокрутить',
      description: 'Крутит колесо мыши. Положительное число — вверх, отрицательное — вниз.',
      inputSchema: {
        amount: z.number().describe('Щелчки колеса, обычно от -5 до 5'),
        x: z.number().optional(),
        y: z.number().optional(),
      },
    },
    async ({ amount, x, y }) => {
      try {
        await driver.scroll(amount, x !== undefined && y !== undefined ? { x, y } : undefined);
        return say(`Прокрутил на ${amount}.`);
      } catch (error) {
        return failed(error);
      }
    },
  );

  server.registerTool(
    'list_windows',
    {
      title: 'Список окон',
      description:
        'Перечисляет видимые окна с заголовками и координатами. Дешевле снимка экрана, ' +
        'когда нужно лишь понять, что открыто и где.',
      inputSchema: {},
    },
    async () => {
      try {
        const windows = await driver.windows();
        const lines = windows.map(
          (w) =>
            `${w.focused ? '→ ' : '  '}${w.title} — (${w.x}, ${w.y}) ${w.width}×${w.height}`,
        );
        return say(lines.length ? lines.join('\n') : 'Видимых окон нет.');
      } catch (error) {
        return failed(error);
      }
    },
  );

  server.registerTool(
    'focus_window',
    {
      title: 'Переключиться на окно',
      description: 'Выводит окно на передний план по части его заголовка.',
      inputSchema: { title: z.string().describe('Часть заголовка окна') },
    },
    async ({ title }) => {
      try {
        const result = await driver.focus(title);
        return say(`Переключился на «${result.title}».`);
      } catch (error) {
        return failed(error);
      }
    },
  );

  server.registerTool(
    'remember',
    {
      title: 'Запомнить',
      description:
        'Сохраняет факт между запусками. Клод начинает каждый запуск с чистого листа, ' +
        'поэтому записывай сюда то, что пришлось выяснять: где лежит кнопка, как ' +
        'пользователь называет программу, какой из похожих вариантов верный. ' +
        'В следующий раз это не придётся искать заново.',
      inputSchema: {
        key: z.string().describe('Коротко, о чём факт: «кнопка Play в Riot»'),
        value: z.string().describe('Сам факт, своими словами'),
      },
    },
    async ({ key, value }) => {
      try {
        const notes = remember(key, value);
        return say(`Запомнил «${key}». Всего записей: ${notes.length}.`);
      } catch (error) {
        return failed(error);
      }
    },
  );

  server.registerTool(
    'recall',
    {
      title: 'Вспомнить',
      description:
        'Показывает, что запомнено. Загляни сюда в начале задачи — возможно, ты уже ' +
        'решал её и знаешь ответ.',
      inputSchema: {
        about: z.string().optional().describe('Тема. Без неё — все записи, свежие первыми.'),
      },
    },
    async ({ about }) => {
      try {
        const notes = recall(about);
        if (notes.length === 0) return say(about ? `Про «${about}» ничего не помню.` : 'Память пуста.');
        return say(notes.map((note) => `${note.key}: ${note.value}`).join('\n'));
      } catch (error) {
        return failed(error);
      }
    },
  );

  server.registerTool(
    'forget',
    {
      title: 'Забыть',
      description: 'Удаляет запись, которая оказалась неверной.',
      inputSchema: { key: z.string() },
    },
    async ({ key }) => {
      try {
        return say(forget(key) ? `Забыл «${key}».` : `Записи «${key}» и не было.`);
      } catch (error) {
        return failed(error);
      }
    },
  );

  server.registerTool(
    'browser_open',
    {
      title: 'Открыть страницу',
      description:
        'Открывает адрес в браузере и возвращает заголовок. Браузер работает в отдельном ' +
        'профиле: входы в нём сохраняются между запусками, но окна пользователя не трогаются.',
      inputSchema: { url: z.string().describe('Адрес, можно без https://') },
    },
    async ({ url }) => {
      try {
        const page = await browser.openUrl(url);
        return say(`Открыл «${page.title}» — ${page.url}`);
      } catch (error) {
        return failed(error);
      }
    },
  );

  server.registerTool(
    'browser_read',
    {
      title: 'Прочитать страницу',
      description:
        'Возвращает видимый текст страницы. Бери его вместо снимка экрана: текст точнее ' +
        'и дешевле, чем разглядывание картинки.',
      inputSchema: {},
    },
    async () => {
      try {
        return say(await browser.readPage());
      } catch (error) {
        return failed(error);
      }
    },
  );

  server.registerTool(
    'browser_controls',
    {
      title: 'Что можно нажать',
      description: 'Перечисляет ссылки и кнопки страницы их видимым текстом — для browser_click.',
      inputSchema: {},
    },
    async () => {
      try {
        const controls = await browser.listControls();
        return say(controls.length ? controls.join('\n') : 'Нажимать нечего.');
      } catch (error) {
        return failed(error);
      }
    },
  );

  server.registerTool(
    'browser_click',
    {
      title: 'Нажать на странице',
      description:
        'Нажимает ссылку или кнопку по видимому тексту. Не по координатам: страница ' +
        'прокручивается и вёрстка плывёт, а текст остаётся собой.',
      inputSchema: { text: z.string().describe('Текст ссылки или кнопки') },
    },
    async ({ text }) => {
      try {
        return say(`Нажал «${text}». Сейчас: ${await browser.clickText(text)}`);
      } catch (error) {
        return failed(error);
      }
    },
  );

  server.registerTool(
    'browser_fill',
    {
      title: 'Заполнить поле',
      description: 'Вводит текст в поле по его подписи или подсказке внутри.',
      inputSchema: {
        label: z.string().describe('Подпись поля или текст-подсказка'),
        value: z.string(),
      },
    },
    async ({ label, value }) => {
      try {
        await browser.fillField(label, value);
        return say(`Заполнил «${label}».`);
      } catch (error) {
        return failed(error);
      }
    },
  );

  server.registerTool(
    'browser_key',
    {
      title: 'Клавиша в браузере',
      description: 'Нажимает клавишу на странице: «Enter», «Escape», «Tab».',
      inputSchema: { key: z.string() },
    },
    async ({ key }) => {
      try {
        await browser.pressKey(key);
        return say(`Нажал ${key}.`);
      } catch (error) {
        return failed(error);
      }
    },
  );

  server.registerTool(
    'browser_tabs',
    {
      title: 'Вкладки',
      description:
        'Работа с вкладками браузера: list — перечислить (номер в начале строки, ' +
        '«→» отмечает рабочую), open — открыть новую и сделать рабочей, switch — ' +
        'переключиться, close — закрыть. Для switch и close нужен target: номер из ' +
        'списка или кусок заголовка либо адреса. Переключение меняет и то, куда идут ' +
        'чтение и нажатия, а не только то, что видно на экране.',
      inputSchema: {
        action: z.enum(['list', 'open', 'switch', 'close']).optional().describe('Что сделать. По умолчанию list.'),
        url: z.string().optional().describe('Адрес для open'),
        target: z.string().optional().describe('Номер вкладки или кусок заголовка/адреса'),
      },
    },
    async ({ action, url, target }) => {
      try {
        if (action === 'open') {
          const tab = await browser.openTab(url);
          return say(`Открыл вкладку: ${tab.title} — ${tab.url}`);
        }
        if (action === 'switch' || action === 'close') {
          if (!target) return say(`Для ${action} нужен target: номер вкладки или кусок заголовка.`);
          const tab = action === 'switch' ? await browser.switchTab(target) : await browser.closeTab(target);
          return say(`${action === 'switch' ? 'Переключился на' : 'Закрыл'}: ${tab.title} — ${tab.url}`);
        }

        const tabs = await browser.listTabs();
        if (!tabs.length) return say('Вкладок нет.');
        return say(tabs.map((t, i) => `${t.active ? '→' : ' '} ${i + 1}. ${t.title} — ${t.url}`).join('\n'));
      } catch (error) {
        return failed(error);
      }
    },
  );

  server.registerTool(
    'blender_live_start',
    {
      title: 'Открыть живой Blender',
      description:
        'Открывает окно Blender, которое остаётся стоять и принимает твои скрипты прямо в нём. ' +
        'Дальше blender_live делает правки В ЭТОМ ЖЕ окне: человек видит, как меняется сцена, ' +
        'и файл не закрывается. Именно этого он просил: «не закрывая файл, при мне». ' +
        'Зови один раз в начале работы над сценой. Если окно уже живое, второй раз не нужно.',
      inputSchema: {
        file: z.string().optional().describe('Открыть этот .blend. Без него — пустая сцена.'),
      },
    },
    async ({ file }) => {
      try {
        if (live.isLive()) return say('Живой Blender уже открыт — шли скрипты через blender_live.');

        const exe = blender.findBlender();
        // Отказ — через `failed`, а не `say`.
        //
        // Без пометки ошибки модель читает отказ как результат и идёт дальше,
        // а журнал стен его не запоминает: урок «на этой машине нет Блендера»
        // пропадал, ради таких уроков журнал и заведён.
        if (!exe) return failed(new Error('Blender не найден на этой машине.'));

        live.startLive(exe, file);
        const up = await live.waitLive();
        if (!up) {
          return failed(new Error('Blender запущен, но слушатель не отозвался за минуту. Проверь окно глазами.'));
        }
        return say('Живой Blender открыт и слушает. Дальше работай через blender_live — окно не закроется.');
      } catch (error) {
        return failed(error);
      }
    },
  );

  server.registerTool(
    'blender_live',
    {
      title: 'Выполнить Python в открытом Blender',
      description:
        'Исполняет скрипт ВНУТРИ уже открытого окна Blender — человек видит изменение сразу, ' +
        'файл не закрывается и не открывается заново. Это главный способ работы со сценой: ' +
        'сделал ракету, человек говорит «пусть летит в космос» — ты добавляешь анимацию сюда же. ' +
        'Печатай результат через print(). Сохраняй только когда просили: ' +
        'bpy.ops.wm.save_as_mainfile(filepath=...).',
      inputSchema: {
        code: z.string().describe('Код на Python с использованием bpy'),
      },
    },
    async ({ code }) => {
      try {
        const answer = await live.sendLive(code);
        const text = [answer.printed, answer.error].filter(Boolean).join('\n').trim();
        if (!answer.ok) {
          return { content: [{ type: 'text' as const, text: text || 'не вышло' }], isError: true };
        }
        return say(text || 'Сделано в открытом окне.');
      } catch (error) {
        return failed(error);
      }
    },
  );

  server.registerTool(
    'blender_python',
    {
      title: 'Выполнить Python в Blender',
      description:
        'Запускает скрипт в Blender через его официальный Python API (bpy) без открытия окна. ' +
        'Так делается всё: создание и правка объектов, модификаторы, материалы, ' +
        'камеры, рендер, экспорт. Печатай результат через print() — он вернётся сюда. ' +
        'Чтобы работа сохранилась, вызови bpy.ops.wm.save_as_mainfile(filepath=...).',
      inputSchema: {
        code: z.string().describe('Код на Python с использованием bpy'),
        file: z.string().optional().describe('Открыть этот .blend перед выполнением'),
        show: z
          .string()
          .optional()
          .describe(
            'Путь к .blend, который надо открыть в окне Blender после работы, чтобы человек ' +
              'увидел результат. Обычно тот же файл, что ты только что сохранил.',
          ),
      },
    },
    async ({ code, file, show }) => {
      try {
        const result = await blender.runPython(code, file);
        if (!result.ok) {
          return { content: [{ type: 'text' as const, text: result.output }], isError: true };
        }

        // Фоновый запуск ничего не показывает, а человек, для которого делали
        // сцену, хочет её видеть. Окно открывается и живёт само.
        //
        // И проверяется. Один раз инструмент сообщил «открыл», окна не было, и
        // агент честно повторил человеку неправду — тот справедливо ответил
        // «ты врёшь». Проверка здесь стоит нескольких секунд ожидания и
        // избавляет от целого класса ложных докладов.
        let shown = '';
        if (show) {
          blender.openInBlender(show);
          shown = (await blenderWindowAppeared(6, 1_500, show))
            ? `\nОткрыл в окне Blender: ${show}`
            : '\nОкно Blender не появилось — скажи об этом человеку, не утверждай обратное.';
        }

        return say((result.output || 'Выполнено, скрипт ничего не напечатал.') + shown);
      } catch (error) {
        return failed(error);
      }
    },
  );

  server.registerTool(
    'write_skill',
    {
      title: 'Записать навык',
      description:
        'Сохраняет найденное как постоянный навык: в следующем запуске он прочитается сам, ' +
        'до начала работы. Пиши сюда то, что пришлось выяснять и что повторится: каким флагом ' +
        'запускается программа, где у неё нужная кнопка, какой оператор переименовали в этой ' +
        'версии, что именно не сработало и почему. Не пиши то, что узнаётся командой за секунду. ' +
        'Имя — строчными латинскими через дефис: «obs-recording». Навык, написанный человеком, ' +
        'не перезаписывается без replace=true.',
      inputSchema: {
        name: z.string().describe('Имя навыка: строчные латинские буквы и дефис'),
        description: z.string().describe('Одна строка: когда этот навык нужен'),
        body: z.string().describe('Тело навыка в Markdown'),
        replace: z.boolean().optional().describe('Перезаписать чужой навык — только по прямой просьбе'),
      },
    },
    async ({ name, description, body, replace }) => {
      try {
        const file = skillPath(skillsRoot(), name);

        if (existsSync(file) && !replace) {
          const existing = readFileSync(file, 'utf8');
          if (!isSelfAuthored(existing)) {
            return failed(
              new Error(
                `Навык «${name}» написан человеком. Перезапись стёрла бы его работу; ` +
                  'если это действительно нужно — вызови с replace=true.',
              ),
            );
          }
        }

        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, buildSkillFile({ name, description, body }), 'utf8');
        return say(`Записал навык «${name}»: ${file}`);
      } catch (error) {
        return failed(error);
      }
    },
  );

  server.registerTool(
    'list_skills',
    {
      title: 'Какие навыки уже есть',
      description:
        'Перечисляет навыки с их описаниями. Смотри сюда, прежде чем писать новый: дополнить ' +
        'существующий почти всегда лучше, чем завести второй про то же самое.',
      inputSchema: {},
    },
    async () => {
      try {
        const root = skillsRoot();
        if (!existsSync(root)) return say('Навыков пока нет.');

        const lines: string[] = [];
        for (const entry of readdirSync(root, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          const file = path.join(root, entry.name, 'SKILL.md');
          if (!existsSync(file)) continue;

          const content = readFileSync(file, 'utf8');
          const description = /^description:\s*(.+)$/mu.exec(content)?.[1]?.trim() ?? '';
          const mine = isSelfAuthored(content) ? ' (мой)' : '';
          lines.push(`${entry.name}${mine} — ${description}`);
        }
        return say(lines.length > 0 ? lines.sort().join('\n') : 'Навыков пока нет.');
      } catch (error) {
        return failed(error);
      }
    },
  );

  server.registerTool(
    'recent_actions',
    {
      title: 'Что делали недавно',
      description:
        'Возвращает, что Джарвис делал в последнее время: свежее дословно, старое сводкой. ' +
        'Смотри сюда, когда человек говорит «переделай», «а где он», «тот файл», «как в прошлый ' +
        'раз» — это указывает на уже случившееся, и гадать про него не надо.',
      inputSchema: {},
    },
    async () => {
      try {
        const lines = openJournal().context();
        return say(lines.length > 0 ? lines.join('\n') : 'Пока ничего не делали.');
      } catch (error) {
        return failed(error);
      }
    },
  );

  server.registerTool(
    'page_ride',
    {
      title: 'Снять страницу целиком',
      description:
        'Проезжает открытую страницу по той оси, где у неё запас, и снимает кадр за кадром. ' +
        'Обычный снимок показывает один экран — у горизонтальной работы это заставка, и судить ' +
        'по ней о ней нельзя. Если скриптом страница неподвижна (так устроены горизонтальные ' +
        'новеллы и сайты вроде Бруно Симон), едет настоящим колесом. ' +
        'Зови это ВМЕСТО screenshot, когда смотришь на чужую работу или проверяешь свою.',
      inputSchema: {},
    },
    async () => {
      try {
        const ride = await ridePage();
        return say(
          [
            ride.fact,
            `ехали ${ride.how}${ride.axis ? `, ось ${ride.axis}` : ''}`,
            ride.arrived ? 'доехали до конца' : 'упёрлись в потолок кадров: конца не видели',
            'кадры:',
            ...ride.files,
          ].join('\n'),
        );
      } catch (error) {
        return failed(error);
      }
    },
  );

  server.registerTool(
    'page_depth',
    {
      title: 'Есть ли на странице что делать',
      description:
        'Трогает открытую страницу двенадцатью действиями (прокрутка, её же кнопки, мышь, ' +
        'клавиша) и считает, сколько РАЗНОГО она показала. Отвечает на вопрос, на который не ' +
        'отвечает ни один снимок: работа это или тридцать секунд. ' +
        'Проверяй этим свою работу перед тем, как сказать «готово»: страница может быть ' +
        'безупречной на вид и пустой по сути. Покупки, входы и отправку форм не нажимает.',
      inputSchema: {},
    },
    async () => {
      try {
        const depth = await probePage();
        const ink = await inkOfPage();
        return say(
          [
            depth.fact,
            depth.has === null
              ? 'запас: мерить нечем'
              : depth.has
                ? 'запас есть'
                : 'запаса нет',
            ink === null ? 'чернил: мерить нечем' : `нарисовано ${Math.round(ink * 100)}% кадра`,
          ].join('\n'),
        );
      } catch (error) {
        return failed(error);
      }
    },
  );

  server.registerTool(
    'set_plan',
    {
      title: 'Записать план работы',
      description:
        'Записывает план: ради чего работа и из каких шагов состоит. ' +
        'Делай это первым делом, если работа больше, чем на пару действий — человек должен ' +
        'видеть, что ты собираешься делать, а не гадать. План переживает перезапуск: ' +
        'вернувшись к работе, ты продолжишь с нужного шага, а не начнёшь заново. ' +
        'Новый вызов заменяет план целиком — для отметки шага есть mark_step.',
      inputSchema: {
        goal: z.string().describe('Что просил человек, его словами.'),
        steps: z.array(z.string()).describe('Шаги по порядку, каждый — одним предложением.'),
      },
    },
    async ({ goal, steps }) => {
      try {
        const plan = makePlan(goal, steps, Date.now());
        // Отчёт об успехе только после успешной записи.
        //
        // Раньше отказ диска глотался, и модель слышала «план записан», пока
        // окно показывало старый план, а перезапуск начинал работу заново.
        if (!openPlan().write(plan)) {
          return failed('план не сохранился на диск, окно покажет старый');
        }
        return say(renderPlan(plan));
      } catch (error) {
        return failed(error);
      }
    },
  );

  server.registerTool(
    'mark_step',
    {
      title: 'Отметить шаг плана',
      description:
        'Меняет состояние шага: «делаю», когда взялся, «сделано» или «не вышло», когда кончил. ' +
        'Номер — тот же, что показан в плане. Отмечай сразу, а не в конце всей работы: ' +
        'человек смотрит на это окно, чтобы понять, идёт ли дело.',
      inputSchema: {
        index: z.number().int().describe('Номер шага из плана.'),
        state: z
          .enum(['ждёт', 'делаю', 'сделано', 'не вышло'])
          .describe('Новое состояние шага.'),
        note: z.string().optional().describe('Чем кончилось: что вышло или обо что споткнулся.'),
      },
    },
    async ({ index, state, note }) => {
      try {
        const store = openPlan();
        const plan = store.read();
        if (!plan) return say('Плана пока нет — сначала запиши его через set_plan.');

        const updated = markStep(plan, index, state as StepState, Date.now(), note);
        // То же, что и в set_plan: «отметил» говорим только про записанное.
        if (!store.write(updated)) {
          return failed('шаг не сохранился на диск, отметка не удержится');
        }
        return say(renderPlan(updated));
      } catch (error) {
        return failed(error);
      }
    },
  );

  server.registerTool(
    'show_plan',
    {
      title: 'Посмотреть план',
      description:
        'Показывает записанный план и то, что уже сделано. ' +
        'Смотри сюда, вернувшись к длинной работе: продолжать надо с неоконченного шага, ' +
        'а не с начала.',
      inputSchema: {},
    },
    async () => {
      try {
        return say(renderPlan(openPlan().read()));
      } catch (error) {
        return failed(error);
      }
    },
  );

  server.registerTool(
    'check_notes',
    {
      title: 'Что человек сказал, пока ты работал',
      description:
        'Забирает реплики, сказанные человеком уже после того, как ты взялся за работу. ' +
        'Это поправки к тому, что ты делаешь прямо сейчас, а не новая задача. ' +
        'Вызывай перед каждым крупным шагом длинной работы: человек не должен ждать ' +
        'полчаса, чтобы сказать «крышу сделай синей». ' +
        'Забранное исчезает из ящика, поэтому учитывай его сразу — второй раз не покажут.',
      inputSchema: {},
    },
    async () => {
      try {
        return say(renderNotes(openNotes().take()));
      } catch (error) {
        return failed(error);
      }
    },
  );

  server.registerTool(
    'browser_download',
    {
      title: 'Скачать файл со страницы',
      description:
        'Нажимает кнопку скачивания по её видимому тексту, дожидается файла и кладёт его ' +
        'в папку ассистента — в раздел по типу файла. Так забирают картинку или ролик, ' +
        'сделанные на сайте: пока файл не на диске, для человека его не существует.',
      inputSchema: {
        text: z.string().describe('Видимый текст кнопки или ссылки скачивания'),
        seconds: z.number().optional().describe('Сколько ждать файл; по умолчанию 180'),
      },
    },
    async ({ text, seconds }) => {
      try {
        const file = await browser.downloadVia(text, Math.round((seconds ?? 180) * 1000));
        const moved = await files.moveIntoFolder(file.path);
        return say(`Скачал «${file.name}». Файл здесь: ${moved}`);
      } catch (error) {
        return failed(error);
      }
    },
  );

  server.registerTool(
    'browser_wait_for',
    {
      title: 'Дождаться текста на странице',
      description:
        'Ждёт появления текста на странице до указанного времени. Нужен там, где ответ ' +
        'готовится долго — генерация картинки или ролика, — и страница всё это время ' +
        'выглядит законченной. Возвращает, дождался или нет.',
      inputSchema: {
        text: z.string().describe('Текст, по которому видно, что готово'),
        seconds: z.number().optional().describe('Сколько ждать; по умолчанию 180'),
      },
    },
    async ({ text, seconds }) => {
      try {
        const found = await browser.waitForText(text, Math.round((seconds ?? 180) * 1000));
        return say(found ? `Дождался: «${text}».` : `Не дождался «${text}» за отведённое время.`);
      } catch (error) {
        return failed(error);
      }
    },
  );

  // Файлы. Без этих четырёх инструментов агент делал файл и терял его: на
  // вопрос «где картинка» отвечал, что она «в чате», — в месте, которого нет.
  server.registerTool(
    'output_folder',
    {
      title: 'Папка для готовых файлов',
      description:
        'Возвращает путь к папке ассистента на рабочем столе человека и список того, ' +
        'что в ней лежит, по разделам. Сюда клади всё, что человек просил получить: ' +
        'эту папку он видит. Раздел выбирается по типу файла, вручную его называть не надо; ' +
        'подпапку по теме задаёт move_to_output.',
      inputSchema: {},
    },
    async () => {
      try {
        const dir = await files.ensureSections();
        const sections = files.outputSectionNames().join(', ');
        const tree = await files.readOutputTree(dir);
        return say(`${dir}\n\nРазделы: ${sections} — файл попадает в свой по типу.\n\n${tree}`);
      } catch (error) {
        return failed(error);
      }
    },
  );

  server.registerTool(
    'list_files',
    {
      title: 'Посмотреть папку',
      description:
        'Перечисляет файлы в папке — свежие сверху, с размером и временем. ' +
        'Без пути смотрит папку ассистента. Так проверяют, что файл действительно есть.',
      inputSchema: {
        dir: z.string().optional().describe('Путь к папке; по умолчанию — папка ассистента'),
      },
    },
    async ({ dir }) => {
      try {
        const target = dir?.trim();
        // Без пути смотрим папку ассистента целиком: плоский список её корня
        // показал бы пять пустых разделов и ни одного файла.
        if (!target) {
          const root = files.outputFolder();
          return say(`${root}\n\n${await files.readOutputTree(root)}`);
        }
        const entries = await files.readFolder(target);
        return say(`${target}\n\n${files.formatEntries(entries)}`);
      } catch (error) {
        return failed(error);
      }
    },
  );

  server.registerTool(
    'move_to_output',
    {
      title: 'Переложить файл в папку ассистента',
      description:
        'Переносит готовый файл в папку ассистента и возвращает новый путь. ' +
        'Нужен, когда программа сохранила результат туда, куда умеет, а не туда, где его ' +
        'найдёт человек. Раздел выбирается по типу файла. topic — подпапка внутри раздела: ' +
        'одно и то же короткое название для всех файлов одной задачи («Отчёт за март», ' +
        '«Логотип кафе»), чтобы они лежали вместе. Файл с таким же именем не затирается.',
      inputSchema: {
        file: z.string().describe('Полный путь к файлу, который надо перенести'),
        topic: z.string().optional().describe('Подпапка по теме задачи — на языке человека, 2–5 слов'),
      },
    },
    async ({ file, topic }) => {
      try {
        const moved = await files.moveIntoFolder(file, undefined, topic);
        return say(`Файл теперь здесь: ${moved}`);
      } catch (error) {
        return failed(error);
      }
    },
  );

  server.registerTool(
    'tidy_folder',
    {
      title: 'Разобрать корень папки ассистента',
      description:
        'Раскладывает по разделам файлы, лежащие в корне папки ассистента. ' +
        'Зови ТОЛЬКО когда человек попросил разобрать папку: то, что он положил туда ' +
        'сам, трогать без просьбы нельзя. Папки не трогаются вовсе — ни разделы, ' +
        'ни подпапки задач. Отвечает списком, что куда уехало.',
      inputSchema: {},
    },
    async () => {
      try {
        const { moves, failures } = await files.tidyRoot();
        if (moves.size === 0 && failures.length === 0) {
          return say('В корне папки ничего не лежало — разбирать нечего.');
        }

        const части: string[] = [];
        if (moves.size > 0) {
          const строки = [...moves].map(([было, стало]) => `${path.basename(было)} → ${стало}`);
          части.push(`Разобрал ${moves.size}:\n${строки.join('\n')}`);
        }
        // Споткнулись на одном — остальное всё равно переехало, и человеку
        // надо знать куда. Молчать о переносе из-за одной неудачи значит
        // оставить его искать свои файлы вслепую.
        if (failures.length > 0) {
          const строки = failures.map(({ file, why }) => `${path.basename(file)}: ${why}`);
          части.push(`Не смог ${failures.length}:\n${строки.join('\n')}`);
        }
        return say(части.join('\n\n'));
      } catch (error) {
        return failed(error);
      }
    },
  );

  server.registerTool(
    'show_file',
    {
      title: 'Показать файл человеку',
      description:
        'Открывает проводник на файле и выделяет его, чтобы человек увидел результат ' +
        'своими глазами. Вызывай в конце задачи, которая создала файл. ' +
        'Параметр open=true вместо этого открывает файл программой по умолчанию.',
      inputSchema: {
        file: z.string().describe('Полный путь к файлу или папке'),
        open: z.boolean().optional().describe('Открыть файл, а не показать в проводнике'),
      },
    },
    async ({ file, open }) => {
      try {
        if (open) {
          // Не вышло открыть — показываем в проводнике, а не бросаем человека.
          //
          // Раньше здесь было «Открыл» при любом исходе: на незнакомом
          // расширении не открывалось НИЧЕГО, окна не появлялось, а отчёт
          // говорил об успехе. Человек ждал окна и считал виноватым себя.
          try {
            await files.openPath(file);
            return say(`Открыл ${file}`);
          } catch (причина) {
            await files.revealPath(file);
            const текст = причина instanceof Error ? причина.message : String(причина);
            return say(`${текст} — показал файл в проводнике: ${file}`);
          }
        }
        await files.revealPath(file);
        return say(`Показал в проводнике: ${file}`);
      } catch (error) {
        return failed(error);
      }
    },
  );

  server.registerTool(
    'krita_live_start',
    {
      title: 'Открыть живую Криту',
      description:
        'Открывает Криту, которая остаётся стоять и принимает твои скрипты прямо в ней. ' +
        'Дальше krita_live рисует В ЭТОМ ЖЕ документе: человек видит, как появляется рисунок. ' +
        'Зови один раз в начале работы. Если окно уже живое, второй раз не нужно. ' +
        'ВАЖНО: у Криты нет ключа командной строки для скриптов, слушатель живёт надстройкой. ' +
        'Если она не включена, человек должен поставить галочку в Настройки → Модули Python → ' +
        'Jarvis Live и перезапустить Криту. Об этом надо сказать вслух, а не молчать.',
      inputSchema: {
        file: z.string().optional().describe('Открыть этот .kra. Без него — пустая Крита.'),
      },
    },
    async ({ file }) => {
      try {
        if (krita.isLive()) return say('Живая Крита уже открыта — шли скрипты через krita_live.');

        const exe = krita.findKrita();
        if (!exe) return say('Крита не найдена на этой машине.');
        if (!krita.pluginInstalled()) {
          return say(
            'Надстройка-слушатель не установлена. Без неё Крита откроется и не ответит.',
          );
        }

        krita.startLive(exe, file);
        const up = await krita.waitLive();
        return say(
          up
            ? 'Живая Крита открыта и слушает. Дальше работай через krita_live.'
            : 'Крита запущена, но слушатель не отозвался за минуту. Скорее всего выключен модуль: ' +
              'Настройки → Модули Python → Jarvis Live, галочка, перезапуск Криты. Скажи об этом человеку.',
        );
      } catch (error) {
        return failed(error);
      }
    },
  );

  server.registerTool(
    'krita_live',
    {
      title: 'Рисовать в открытой Крите',
      description:
        'Исполняет Python внутри ОТКРЫТОЙ Криты: слои, кисти, выделения, трансформации, ' +
        'экспорт кадров. Доступны Krita и krita (готовый Krita.instance()). ' +
        'Документ берётся так: doc = krita.activeDocument(). ' +
        'После правки пикселей зови doc.refreshProjection(), иначе человек не увидит изменений. ' +
        'Файл сам не сохраняется — сохраняет тот, кто об этом попросил.',
      inputSchema: {
        code: z.string().describe('Python для исполнения внутри Криты'),
      },
    },
    async ({ code }) => {
      try {
        const результат = await krita.sendLive(code);
        const хвост = результат.printed.trim();
        if (!результат.ok) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Не удалось: ${результат.error ?? 'неизвестно'}${хвост ? `
${хвост}` : ''}`,
              },
            ],
            isError: true,
          };
        }
        return say(хвост || 'Готово.');
      } catch (error) {
        return failed(error);
      }
    },
  );

  server.registerTool(
    'draw_image',
    {
      title: 'Нарисовать картинку диффузией',
      description:
        'Рисует картинку локальной моделью через ComfyUI и кладёт файл в папку ассистента. ' +
        'Это НАСТОЯЩЕЕ рисование: собирать картинку кодом из фигур бессмысленно, проверено. ' +
        'Подсказку пиши ПО-АНГЛИЙСКИ — модели обучены на нём. ' +
        'Для одинакового персонажа в разных кадрах держи один и тот же seed и одну подсказку: ' +
        'меняя только позу и план, получишь того же героя, а не нового. ' +
        'Размеры кратные 64; на этой машине 512x768 — потолок разумного.',
      inputSchema: {
        prompt: z.string().describe('Что нарисовать, по-английски'),
        negative: z.string().optional().describe('Чего не должно быть; без него берётся общий список'),
        width: z.number().optional().describe('Ширина, кратная 64 (по умолчанию 512)'),
        height: z.number().optional().describe('Высота, кратная 64 (по умолчанию 768)'),
        steps: z.number().optional().describe('Шагов сэмплера, 20–30 обычно хватает'),
        seed: z.number().optional().describe('Зерно. Одно и то же зерно — тот же персонаж.'),
        name: z.string().optional().describe('Имя файла без расширения'),
      },
    },
    async ({ prompt, negative, width, height, steps, seed, name }) => {
      try {
        const папка = files.outputFolder();
        mkdirSync(папка, { recursive: true });
        const имя = (name?.trim() || 'рисунок').replace(/[\/:*?"<>|]/gu, '_');
        // Свободное имя, а не постоянное.
        //
        // Без `name` путь был один и тот же: второй рисунок молча уничтожал
        // первый. `files.ts` про это говорит прямо — «вчерашний отчёт с тем же
        // именем это чья-то работа».
        const путь = path.join(папка, files.uniqueName(`${имя}.png`, new Set(readdirSync(папка))));

        const итог = await comfy.draw({
          prompt,
          ...(negative ? { negative } : {}),
          ...(typeof width === 'number' ? { width } : {}),
          ...(typeof height === 'number' ? { height } : {}),
          ...(typeof steps === 'number' ? { steps } : {}),
          ...(typeof seed === 'number' ? { seed } : {}),
          saveTo: путь,
        });

        if (!итог.ok) {
          return {
            content: [{ type: 'text' as const, text: `Не удалось: ${итог.error ?? 'неизвестно'}` }],
            isError: true,
          };
        }
        const данные = readFileSync(путь).toString('base64');
        return {
          content: [
            { type: 'text' as const, text: `Готово: ${путь} (зерно ${итог.seed})` },
            { type: 'image' as const, data: данные, mimeType: 'image/png' },
          ],
        };
      } catch (error) {
        return failed(error);
      }
    },
  );

  server.registerTool(
    'animate_sequence',
    {
      title: 'Собрать анимацию из ключевых кадров',
      description:
        'Берёт папку с ключевыми рисунками и делает из них ролик: промежутки, ' +
        'смазы, импакт-фреймы, сборка. Порядок кадров — порядок имён файлов, ' +
        'поэтому называй их 01, 02, 03. ' +
        'Промежутки считаются по оптическому потоку ИЗ самих кадров, а не ' +
        'дорисовываются: иначе между соседними кадрами поедут складки и цвет. ' +
        'Где позы слишком далеки друг от друга, вместо промежутка сам встаёт ' +
        'смаз — это решается замером, а не на глаз. ' +
        'Частота низкая нарочно: в аниме кадр держат по две-три экранных.',
      inputSchema: {
        keys: z.string().describe('Папка с ключевыми кадрами'),
        name: z.string().optional().describe('Имя ролика без расширения'),
        between: z.number().optional().describe('Промежутков между соседними кадрами (по умолчанию 3)'),
        fps: z.number().optional().describe('Кадров в секунду (по умолчанию 12)'),
        impacts: z.array(z.number()).optional()
          .describe('После каких ключей ставить импакт-фрейм, считая с единицы'),
      },
    },
    async ({ keys, name, between, fps, impacts }) => {
      try {
        const папка = files.outputFolder();
        mkdirSync(папка, { recursive: true });
        const имя = (name?.trim() || 'анимация').replace(/[\/:*?"<>|]/gu, '_');
        // Свободное имя: `ffmpeg -y` затирает молча, и вторая анимация без
        // имени уносила первую.
        const путь = path.join(папка, files.uniqueName(`${имя}.mp4`, new Set(readdirSync(папка))));

        const итог = await mid.sequence({
          keys,
          out: путь,
          ...(typeof between === 'number' ? { between } : {}),
          ...(typeof fps === 'number' ? { fps } : {}),
          ...(Array.isArray(impacts) ? { impacts } : {}),
        });

        if (!итог.ok) {
          return {
            content: [{ type: 'text' as const, text: `Не удалось: ${итог.error ?? 'неизвестно'}` }],
            isError: true,
          };
        }
        return say(
          `Готово: ${путь}. Кадров ${итог.frames}, смазов ${итог.smears ?? 0}, ` +
            `импактов ${итог.impacts ?? 0}. Смаз вместо промежутка значит, что позы ` +
            `там слишком далеки — если таких мест много, нужны промежуточные ключи.`,
        );
      } catch (error) {
        return failed(error);
      }
    },
  );

  registerWindowTools(server);

  return server;
}

/**
 * Работа с окном по именам, а не по координатам.
 *
 * Эти четыре инструмента — весь компьютер-юз, и порядок между ними не совет,
 * а измеренная цена (20.09.2026, окно Электрона на 283 элемента):
 *
 *   window_look   снимок 1199×674   1 078 токенов, видно всё нарисованное
 *   window_find   поиск по имени      190–410, попадание 9 из 9
 *   полное дерево (наружу не выставлено)  6 877 — то же самое вдесятеро дороже
 *
 * Задача в двадцать шагов по одному окну: 7 078 токенов этим путём против
 * 137 540 полными деревьями. Поэтому дерева целиком здесь нет и не будет:
 * инструмент, которым можно разориться, рано или поздно тем и кончится.
 *
 * Работают они на обеих платформах: на Windows через cua-driver, на маке
 * через System Events и CoreGraphics (`windowTools.ts` выбирает). Раньше эти
 * шесть были жёстко привязаны к cua-driver, и на маке компьютер-юза не было
 * вовсе — ни снять чужое окно, ни найти в нём кнопку, ни нажать. Поймано
 * приёмкой на macos-latest 25.09.2026: «Драйвер компьютер-юза не найден».
 */
function registerWindowTools(server: McpServer): void {
  server.registerTool(
    'window_list',
    {
      title: 'Окна',
      description:
        'Перечисляет окна, с которыми можно работать: программа, заголовок, pid и номер окна. ' +
        'Номер окна нужен всем остальным инструментам этой четвёрки.',
      inputSchema: {},
    },
    async () => {
      try {
        const windows = await cua.windows();
        if (windows.length === 0) return say('Открытых окон нет.');
        return say(
          windows
            .map((w) => `${w.title} — ${w.app}, pid ${w.pid}, окно ${w.windowId}`)
            .join('\n'),
        );
      } catch (error) {
        return failed(error);
      }
    },
  );

  server.registerTool(
    'window_look',
    {
      title: 'Посмотреть в окно',
      description:
        'Выводит окно вперёд и возвращает его снимок. С этого начинается работа с незнакомым ' +
        'окном: на снимке разом видны все надписи, а дальше по ним ищешь window_find. ' +
        'Повторяй после действий, которые меняют вид окна.',
      inputSchema: {
        pid: z.number().describe('pid из window_list'),
        window_id: z.number().describe('Номер окна из window_list'),
      },
    },
    async ({ pid, window_id }) => {
      try {
        const file = path.join(shotDir, `window-${shotCounter++}.png`);
        const shot = await cua.look(pid, window_id, file);
        const data = readFileSync(shot.path).toString('base64');
        return {
          content: [
            { type: 'text' as const, text: `Окно ${shot.width}×${shot.height}.` },
            { type: 'image' as const, data, mimeType: 'image/png' },
          ],
        };
      } catch (error) {
        return failed(error);
      }
    },
  );

  server.registerTool(
    'window_find',
    {
      title: 'Найти в окне по имени',
      description:
        'Ищет в окне элементы по надписи и возвращает их номера. Имя бери со снимка окна. ' +
        'Регистр не важен, ищет по вхождению: «Termin» найдёт «Terminal». ' +
        'Найденный номер отдавай в window_press или window_write.',
      inputSchema: {
        pid: z.number(),
        window_id: z.number(),
        name: z.string().describe('Надпись на элементе, например «Сохранить»'),
      },
    },
    async ({ pid, window_id, name }) => {
      try {
        const found = await cua.find(pid, window_id, name);
        if (found.length === 0) {
          return say(
            `«${name}» в окне нет. Сделай window_look и возьми надпись со снимка — ` +
              'возможно, она написана иначе.',
          );
        }
        return say(found.map((e) => `[${e.index}] ${e.role} «${e.name}»`).join('\n'));
      } catch (error) {
        return failed(error);
      }
    },
  );

  server.registerTool(
    'window_press',
    {
      title: 'Нажать по номеру',
      description:
        'Нажимает элемент по номеру из window_find. Это надёжнее клика по координатам: ' +
        'номер указывает на сам элемент, а координаты — на точку, которая могла уехать.',
      inputSchema: {
        pid: z.number(),
        window_id: z.number(),
        element: z.number().describe('Номер из window_find'),
      },
    },
    async ({ pid, window_id, element }) => {
      try {
        await cua.press(pid, window_id, element);
        return say(`Нажал элемент [${element}].`);
      } catch (error) {
        return failed(error);
      }
    },
  );

  server.registerTool(
    'window_write',
    {
      title: 'Напечатать в поле',
      description:
        'Печатает текст в элемент по номеру из window_find. Кириллица и любая раскладка. ' +
        'Отдельной клавишей (Enter, Escape, Tab) жми через window_key.',
      inputSchema: {
        pid: z.number(),
        window_id: z.number(),
        element: z.number(),
        text: z.string(),
      },
    },
    async ({ pid, window_id, element, text }) => {
      try {
        await cua.writeInto(pid, window_id, element, text);
        return say(`Напечатал в [${element}].`);
      } catch (error) {
        return failed(error);
      }
    },
  );

  server.registerTool(
    'window_key',
    {
      title: 'Клавиша в окне',
      description: 'Нажимает клавишу в окне: Enter, Escape, Tab, F5 и прочие.',
      inputSchema: {
        pid: z.number(),
        window_id: z.number(),
        key: z.string().describe('Например Enter или Escape'),
      },
    },
    async ({ pid, window_id, key }) => {
      try {
        await cua.key(pid, window_id, key);
        return say(`Нажал ${key}.`);
      } catch (error) {
        return failed(error);
      }
    },
  );
}

/** Entry point for `claude mcp add`. */
/**
 * Сколько ждать, прежде чем уйти силой.
 *
 * Закрытие браузера и драйвера обычно занимает доли секунды. Если не уложились
 * — значит что-то держит, и висеть дальше хуже, чем уйти невежливо.
 */
const GOODBYE_MS = 3_000;

/**
 * Уйти, когда клиент ушёл.
 *
 * ## Зачем
 *
 * Сервер живёт, пока открыт его stdin. Claude Code завершает задачу и
 * отсоединяется, а процесс остаётся: его держат открытый браузер Playwright и
 * PowerShell-драйвер. Каждый запуск агента оставлял по одному такому.
 *
 * Найдено на живой машине: шесть брошенных серверов от 12:19, 18:22, 18:23,
 * 20:34, 20:45 и 22:55, около гигабайта выделенной памяти. Человек написал
 * прямо: «диск и память наглухо забиты».
 *
 * ## Почему именно stdin
 *
 * Это единственный надёжный признак. Родительский процесс на Windows не
 * оповещает о своей смерти, а stdin закрывается всегда — и когда клиент
 * отсоединился, и когда его убили.
 */
function leaveWhenClientLeaves(): void {
  let leaving = false;

  const goodbye = (why: string): void => {
    if (leaving) return;
    leaving = true;
    console.error(`[jarvis:desktop] клиент ушёл (${why}) — закрываюсь`);

    // Уходим в любом случае: висящий браузер не повод остаться навсегда.
    const force = setTimeout(() => process.exit(0), GOODBYE_MS);
    force.unref?.();

    void (async () => {
      try {
        await browser.dispose();
      } catch {
        // Браузер мог уже умереть сам.
      }
      try {
        driver.dispose();
      } catch {
        // И драйвер тоже.
      }
      try {
        cua.dispose();
      } catch {
        // И драйвер компьютер-юза: он отдельный процесс и сам не уйдёт.
      }
      try {
        // Папка снимков заводится на каждый запуск и остаётся навсегда. За
        // день их накопилось сто пятьдесят две на двадцать мегабайт.
        rmSync(shotDir, { recursive: true, force: true });
      } catch {
        // Файл мог быть занят — не повод остаться.
      }
      process.exit(0);
    })();
  };

  process.stdin.on('end', () => goodbye('stdin закрыт'));
  process.stdin.on('close', () => goodbye('stdin закрыт'));
  process.stdin.on('error', () => goodbye('stdin оборван'));
  process.on('SIGTERM', () => goodbye('SIGTERM'));
  process.on('SIGINT', () => goodbye('SIGINT'));
}

export async function runDesktopMcpServer(): Promise<void> {
  const server = createDesktopMcpServer();
  leaveWhenClientLeaves();
  await server.connect(new StdioServerTransport());
}
