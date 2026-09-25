/**
 * Рычаги разговора, отданные ему как инструменты MCP.
 *
 * ## Почему это отдельный сервер, а не часть рабочего
 *
 * Не для порядка, а ради безопасности. Роль задаётся при запуске процесса:
 * в рабочем сервере этих глаголов нет вовсе, а здесь нет ни экрана, ни мыши,
 * ни браузера, ни файлов. Разговор не может «случайно» дотянуться до рабочих
 * инструментов — их нет в его процессе, а не «есть, но запрещены».
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
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';

import { JournalStore } from '../memory/journalStore';
import { NoteStore } from './noteStore';
import { PlanStore } from '../agent/planStore';
import { TalkBridge } from './talkBridge';
import { TALK_SERVER } from './talkSession';
import { addStep, renderPlan } from '../agent/plan';

function dataFile(variable: string, name: string): string {
  return (
    process.env[variable]?.trim() ||
    path.join(
      process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'),
      'Rujarvis',
      'data',
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
      },
    },
    async ({ task }) => {
      const answer = await bridge.ask('start', task);
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
