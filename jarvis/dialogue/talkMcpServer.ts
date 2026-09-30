/**
 * Рычаги разговора, отданные ему как инструменты MCP.
 *
 * ## Почему это отдельный сервер, а не часть рабочего
 *
 * Не для порядка, а ради безопасности. Роль задаётся при запуске процесса:
 * в рабочем сервере этих глаголов нет вовсе, а здесь нет ни браузера, ни
 * файлов, ни команд. Разговор не может «случайно» дотянуться до рабочих
 * инструментов — их нет в его процессе, а не «есть, но запрещены».
 *
 * Экран у разговора есть, но узкий и чужими руками (30.09.2026): переключиться,
 * нажать, пройти меню, клавиши, текст в поле, приложение Claude. Всё это
 * просьбы к главному процессу через мост, а исполняет и проверяет там
 * `uiHands.ts`: покупку, отправку и Enter модель не нажимает.
 *
 * ## Почему часть рычагов работает прямо здесь, а часть через мост
 *
 * Ящик правок, план и журнал — обычные файлы. Их сервер читает и пишет сам,
 * как это делает рабочий сервер соседним кодом.
 *
 * Завести работу, остановить, отложить и продолжить — всё это живёт в
 * менеджере задач внутри Электрона. Туда ведёт файловый мост, и его ответ
 * обязателен: инструмент, промолчавший об отказе, читается моделью как успех —
 * и разговор скажет человеку «запустил» про незапущенное.
 *
 * ## Почему имена латиницей
 *
 * Имя инструмента MCP обязано попадать в `^[a-zA-Z0-9_.-]{1,64}$`.
 * Кириллическое имя отклоняется вместе со всем сервером. Русский живёт в
 * описаниях — их читает модель, а не проверяльщик схемы.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import path from 'node:path';
import { z } from 'zod';

import { JournalStore } from '../memory/journalStore';
import { NoteStore } from './noteStore';
import { PlanStore } from '../agent/planStore';
import { TalkBridge, type TalkUiRequest } from './talkBridge';
import { TALK_SERVER } from './talkSession';
import { addStep, renderPlan } from '../agent/plan';
import { jarvisDataRoot } from '../setup/paths';

function dataFile(variable: string, name: string): string {
  // Папка данных — из paths.ts. Собранная руками, она была виндовой везде, и
  // на маке разговор писал план в ~/AppData/Local/Rujarvis, которой там нет.
  return (
    process.env[variable]?.trim() ||
    path.join(
      jarvisDataRoot(),
      name,
    )
  );
}

/** Папка моста до главного процесса. */
function bridgeDir(): string {
  return (
    process.env.JARVIS_TALK_BRIDGE?.trim() ||
    path.join(path.dirname(dataFile('JARVIS_JOURNAL', 'journal.json')), 'talk-bridge')
  );
}

function say(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function refused(text: string) {
  // isError важен: без него отказ читается моделью как результат, и разговор
  // перескажет человеку успех, которого не было.
  return { content: [{ type: 'text' as const, text }], isError: true };
}

export function createTalkMcpServer(bridge = new TalkBridge(bridgeDir())): McpServer {
  const server = new McpServer({ name: TALK_SERVER, version: '1.0.0' });

  server.registerTool(
    'start_work',
    {
      title: 'Завести работу',
      description:
        'Поручить рабочему потоку новое дело. Идущая работа при этом не прерывается — она ' +
        'уходит в фон. Зови, когда человек просит сделать что-то новое, а не поправить ' +
        'то, что уже делается.',
      inputSchema: {
        task: z.string().describe('Что сделать, словами человека.'),
        quick: z
          .boolean()
          .optional()
          .describe(
            'true — короткое дело: одно-два действия на экране или в программе («нажми запись», ' +
              '«закрой диктофон», «открой вторую вкладку»). Делается быстрой моделью за секунды. ' +
              'Код, модели, документы, поиск и всё, что требует размышлений, — не короткое.',
          ),
      },
    },
    async ({ task, quick }) => {
      const answer = await bridge.ask('start', task, { quick });
      return answer.ok ? say(answer.text) : refused(answer.text);
    },
  );

  server.registerTool(
    'stop_work',
    {
      title: 'Остановить работу',
      description:
        'Погасить работу, которая идёт прямо сейчас. Зови, когда человек передумал: ' +
        '«хватит», «не надо», «останови это».',
      inputSchema: {},
    },
    async () => {
      const answer = await bridge.ask('stop');
      return answer.ok ? say(answer.text) : refused(answer.text);
    },
  );

  server.registerTool(
    'pause_work',
    {
      title: 'Отложить работу',
      description:
        'Остановить работу, но не потерять её: агент помнит, на чём остановился, и ' +
        'сможет продолжить с того же места. Зови на «отложи», «потом», «погоди пока» — ' +
        'в отличие от stop_work, это не насовсем.',
      inputSchema: {},
    },
    async () => {
      const answer = await bridge.ask('pause');
      return answer.ok ? say(answer.text) : refused(answer.text);
    },
  );

  server.registerTool(
    'resume_work',
    {
      title: 'Продолжить отложенное',
      description:
        'Вернуться к работе, которую отложили. Зови на «продолжай», «давай дальше».',
      inputSchema: {},
    },
    async () => {
      const answer = await bridge.ask('resume');
      return answer.ok ? say(answer.text) : refused(answer.text);
    },
  );

  server.registerTool(
    'add_note',
    {
      title: 'Поправка к идущей работе',
      description:
        'Положить поправку в ящик: агент заберёт её сам, ответом на ближайшее своё ' +
        'действие. Зови, когда человек меняет уже идущее дело — «шрифт крупнее», ' +
        '«не синим, а зелёным».',
      inputSchema: {
        text: z.string().describe('Поправка словами человека.'),
      },
    },
    ({ text }) => {
      const clean = text.trim();
      if (!clean) return refused('Пустая поправка — не поправка.');
      // Успех отвечаем только если запись дошла до диска. Иначе человек
      // слышал «положил», а поправка исчезала — и узнать об этом было
      // неоткуда.
      const легло = new NoteStore(dataFile('JARVIS_NOTES', 'notes.json')).add(clean);
      if (!легло) return refused('Не записал поправку: не вышло сохранить.');
      return say('Положил в поправки, агент заберёт сам.');
    },
  );

  server.registerTool(
    'add_step',
    {
      title: 'Дописать шаг в план',
      description:
        'Добавить новое дело в конец плана идущей работы. В отличие от поправки, это ' +
        'отдельный шаг, который человек увидит в окне плана.',
      inputSchema: {
        text: z.string().describe('Что за шаг, одной строкой.'),
      },
    },
    ({ text }) => {
      const store = new PlanStore(dataFile('JARVIS_PLAN', 'plan.json'));
      const plan = store.read();
      if (!plan) return refused('Плана нет — дописывать некуда.');

      const changed = addStep(plan, text, Date.now());
      if (!changed) return refused('Не добавил: пусто, повтор или план уже полон.');

      if (!store.write(changed)) return refused('Не дописал: не вышло сохранить план.');
      return say(`Дописал шагом ${changed.steps.length}.`);
    },
  );

  server.registerTool(
    'work_now',
    {
      title: 'Чем занята работа',
      description:
        'План работы и последние действия Джарвиса. Читается мгновенно из файлов — ' +
        'спрашивать занятого агента не надо, его ответ пришлось бы ждать до конца ' +
        'его хода, то есть до конца работы.',
      inputSchema: {},
    },
    () => {
      const plan = new PlanStore(dataFile('JARVIS_PLAN', 'plan.json')).read();
      const recent = new JournalStore(dataFile('JARVIS_JOURNAL', 'journal.json')).context();
      const parts = [renderPlan(plan)];
      if (recent.length > 0) parts.push(`Недавно:\n${recent.join('\n')}`);
      return say(parts.join('\n\n'));
    },
  );

  // ——— Руки на экране ———
  //
  // Раньше у разговора их не было вовсе, и «переключись на клуб» (ослышка
  // «Клода») уходило агенту — десять секунд на одно нажатие, — а «не нашёл»
  // от прямой команды было концом. Теперь разговор видит список на экране и
  // жмёт сам. Исполняет главный процесс (`uiHands.ts`) — там же проверка
  // красных линий: покупку, отправку и Enter модель не нажимает.
  const ui = async (request: TalkUiRequest) => {
    const answer = await bridge.ask('ui', undefined, { ui: request });
    return answer.ok ? say(answer.text) : refused(answer.text);
  };

  server.registerTool(
    'screen_overview',
    {
      title: 'Что на экране',
      description:
        'Окна, активное окно и то, что в нём можно открыть или нажать: вкладки, разделы, пункты меню, ' +
        'кнопки, поля — с точными названиями. Зови, когда человек просит переключиться, открыть или нажать, ' +
        'а ты не уверен, как это называется на экране (названия часто по-английски или на иврите).',
      inputSchema: {},
    },
    () => ui({ action: 'screen' }),
  );

  server.registerTool(
    'switch_to',
    {
      title: 'Переключиться',
      description:
        'Переключиться на окно, вкладку браузера или вкладку/раздел внутри активного окна — по названию. ' +
        'Лучше точное название из screen_overview; ослышку («клад» про Claude) исправь сам.',
      inputSchema: { target: z.string().describe('Название окна, вкладки или раздела.') },
    },
    ({ target }) => ui({ action: 'switch', target }),
  );

  server.registerTool(
    'press_control',
    {
      title: 'Нажать',
      description:
        'Нажать кнопку, пункт, ссылку или переключатель в активном окне (или в названном окне — сначала ' +
        'переключится). Кнопки покупки и отправки тебе нельзя — это нажимает только человек.',
      inputSchema: {
        target: z.string().describe('Точное название с экрана.'),
        window: z.string().optional().describe('Окно, в котором нажать, если не в активном.'),
      },
    },
    ({ target, window }) => ui({ action: 'press', target, window }),
  );

  server.registerTool(
    'open_menu',
    {
      title: 'Пройти по меню',
      description: 'Меню по пути в активном окне: ["Файл", "Экспорт", "FBX"] — каждый шаг раскрывает следующий.',
      inputSchema: { path: z.array(z.string()).min(1).max(8).describe('Пункты по порядку, как на экране.') },
    },
    ({ path }) => ui({ action: 'menu', path }),
  );

  server.registerTool(
    'press_keys',
    {
      title: 'Клавиши',
      description: 'Сочетание клавиш в активном окне: "ctrl+shift+t", "alt+tab", "f5". Enter тебе нельзя — он может отправить сообщение.',
      inputSchema: { keys: z.string().describe('Клавиши через плюс.') },
    },
    ({ keys }) => ui({ action: 'keys', keys }),
  );

  server.registerTool(
    'type_text',
    {
      title: 'Напечатать',
      description: 'Напечатать текст в активное окно — в названное поле, если указано (например, в поиск). Enter не нажимается.',
      inputSchema: {
        text: z.string().describe('Что напечатать.'),
        field: z.string().optional().describe('Поле по названию с экрана.'),
      },
    },
    ({ text, field }) => ui({ action: 'type', text, target: field }),
  );

  server.registerTool(
    'send_to_claude',
    {
      title: 'Написать Claude',
      description:
        'Отправить сообщение в открытую сессию приложения Claude (Claude Code или чат): текст в поле ввода и ' +
        'отправка. Зови, когда человек говорит «напиши клоду…», «скажи клоду…», «спроси у клода…».',
      inputSchema: { text: z.string().describe('Сообщение словами человека.') },
    },
    ({ text }) => ui({ action: 'claude_send', text }),
  );

  server.registerTool(
    'claude_waiting',
    {
      title: 'Какие сессии Claude ждут',
      description: 'Какие сессии в приложении Claude ждут ответа человека и где новый ответ.',
      inputSchema: {},
    },
    () => ui({ action: 'claude_waiting' }),
  );

  server.registerTool(
    'open_claude_session',
    {
      title: 'Открыть сессию Claude',
      description: 'Открыть сессию в приложении Claude по названию (на слух: неточное название подойдёт).',
      inputSchema: { name: z.string().describe('Название сессии.') },
    },
    ({ name }) => ui({ action: 'claude_session', target: name }),
  );

  server.registerTool(
    'new_claude_session',
    {
      title: 'Новая сессия Claude',
      description: 'Новая сессия в приложении Claude — в папке проекта, если назван («в Rujarvis»).',
      inputSchema: { project: z.string().optional().describe('Проект (папка) для сессии.') },
    },
    ({ project }) => ui({ action: 'claude_new', target: project }),
  );

  server.registerTool(
    'open_site',
    {
      title: 'Открыть сайт',
      description:
        'Открыть сайт в браузере человека — там его вход и закладки: по имени («ютуб», «гитхаб») или адресу. ' +
        'Одним вызовом, без нажатий: не собирай это из новой вкладки, печати адреса и Enter.',
      inputSchema: { name: z.string().describe('Имя сайта или адрес.') },
    },
    ({ name }) => ui({ action: 'site', target: name }),
  );

  return server;
}

/**
 * Уйти вместе с клиентом.
 *
 * Сессия разговора живёт весь вечер, но однажды закроется — и сервер,
 * переживший её, останется висеть до перезагрузки. За сутки небрежности в
 * этой системе уже накопилось шесть осиротевших серверов на 956 МБ.
 *
 * Признак один надёжный: закрытый stdin. Родительский процесс на Windows о
 * своей смерти не оповещает.
 */
function leaveWhenClientLeaves(): void {
  const goodbye = (why: string): void => {
    console.error(`[jarvis:talk] клиент ушёл (${why}) — закрываюсь`);
    process.exit(0);
  };

  process.stdin.on('end', () => goodbye('stdin закрыт'));
  process.stdin.on('close', () => goodbye('stdin закрыт'));
  process.stdin.on('error', () => goodbye('stdin оборван'));
  process.on('SIGTERM', () => goodbye('SIGTERM'));
  process.on('SIGINT', () => goodbye('SIGINT'));
}

export async function runTalkMcpServer(): Promise<void> {
  const server = createTalkMcpServer();
  leaveWhenClientLeaves();
  await server.connect(new StdioServerTransport());
}
