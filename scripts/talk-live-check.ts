/**
 * Живая проверка разговора: настоящий CLI, настоящий MCP-сервер, настоящий мост.
 *
 * Модульные наборы проверяют куски по отдельности, и каждый из них прав. Ломается
 * обычно шов: роль сервера не долетела через окружение, имя инструмента не прошло
 * проверку схемы, мост положил файл не туда. Поэтому здесь всё вместе и
 * по-настоящему — как человек проверял бы руками, только быстрее.
 *
 *     npx tsx scripts/talk-live-check.ts
 *
 * Стоит одной сессии CLI и нескольких ходов по подписке. Работу ничего не
 * трогает: мост подставной, задачу он никуда не заводит, а только записывает,
 * что его попросили.
 */

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { TalkBridge, type TalkRequest } from '../jarvis/dialogue/talkBridge';
import { TalkSession } from '../jarvis/dialogue/talkSession';
import { createClaudeProbe } from '../jarvis/backends/cliProbes';
import { makePlan, renderPlan, type Plan } from '../jarvis/agent/plan';
import { resolveDesktopMcpLaunch } from '../jarvis/desktop/launch';

const ДОМ = mkdtempSync(path.join(os.tmpdir(), 'jarvis-talk-live-'));
const МОСТ = path.join(ДОМ, 'bridge');
const ЖУРНАЛ = path.join(ДОМ, 'journal.json');
const ПЛАН = path.join(ДОМ, 'plan.json');

/** Тот же сервер, что у рабочего стола, — с другой ролью. */
function конфиг(): string | undefined {
  const server = resolveDesktopMcpLaunch({ appRoot: process.cwd() });
  if (!server.ok) {
    console.log(`НЕТ сервера: ${server.missing} — сначала pnpm run build`);
    return undefined;
  }

  const file = path.join(ДОМ, 'talk.json');
  writeFileSync(
    file,
    JSON.stringify({
      mcpServers: {
        'jarvis-talk': {
          type: 'stdio',
          command: server.launch.command,
          args: server.launch.args,
          env: {
            ...server.launch.env,
            JARVIS_MCP_ROLE: 'talk',
            JARVIS_TALK_BRIDGE: МОСТ,
            JARVIS_JOURNAL: ЖУРНАЛ,
            JARVIS_NOTES: path.join(ДОМ, 'notes.json'),
            JARVIS_PLAN: ПЛАН,
          },
        },
      },
    }),
    'utf8',
  );
  console.log(`сервер разговора: ${server.launch.args[0] ?? server.launch.command}`);
  return file;
}

async function main(): Promise<void> {
  // План на столе: без него разговору нечего рассказывать о работе.
  writeFileSync(
    ПЛАН,
    JSON.stringify(makePlan('собрать отчёт по продажам', ['найти данные', 'свести таблицу'], Date.now())),
    'utf8',
  );
  writeFileSync(
    ЖУРНАЛ,
    JSON.stringify([{ at: Date.now(), kind: 'error', text: 'не смог открыть сайт налоговой' }]),
    'utf8',
  );

  const просьбы: TalkRequest[] = [];
  const мост = new TalkBridge(МОСТ, { stepMs: 100 });
  const ответы: Record<string, string> = {
    start: 'Запускаю: собрать список ссылок',
    stop: 'Остановил: собрать отчёт',
    pause: 'Отложил: собрать отчёт',
    resume: 'Продолжаю: собрать отчёт',
  };
  const перестать = мост.serve((request) => {
    просьбы.push(request);
    console.log(`  <- мост получил: ${request.kind} ${request.text ?? ''}`);
    return { ok: true, text: ответы[request.kind] ?? 'сделано' };
  });

  const сказанное: string[] = [];
  const разговор = new TalkSession({
    cliPath: async () => {
      const статус = await createClaudeProbe().status();
      console.log(`CLI: ${статус.path ?? 'не найден'} (установлен: ${статус.installed})`);
      return статус.path ?? null;
    },
    cwd: ДОМ,
    mcpConfig: конфиг(),
    delta: { journalFile: ЖУРНАЛ, planFile: ПЛАН },
    state: () => ({
      work: renderPlan(JSON.parse(readFileSync(ПЛАН, 'utf8')) as Plan).split(
        String.fromCharCode(10),
      ),
      recent: ['открыл Chrome'],
      instructions: '',
    }),
    speak: (text) => {
      сказанное.push(text);
      console.log(`  -> вслух: ${text}`);
    },
    log: (line) => console.log(`  ${line}`),
  });

  // Прогрев отдельной строкой: он и есть то, что удешевляет первую фразу.
  const прогрев = Date.now();
  await разговор.warm();
  console.log(`прогрев: ${((Date.now() - прогрев) / 1000).toFixed(1)} с`);

  // Свои фразы через командную строку, разделённые вертикальной чертой: когда
  // проверяешь одно место, гонять все восемь ходов незачем.
  //   npx tsx scripts/talk-live-check.ts "займись вот чем: ..."
  const свои = process.argv[2]?.trim();
  const ходы = свои
    ? свои.split('|').map((ф) => ф.trim()).filter(Boolean)
    : [
    'привет, чем ты сейчас занят',
    'шрифт в отчёте сделай крупнее',
    'и добавь шаг: проверить итог',
    'а почему не получилось',
    'отложи это пока',
    'ладно, продолжай',
    'заодно собери список ссылок по теме',
    'всё, останови',
  ];

  const времена: number[] = [];
  for (const [номер, фраза] of ходы.entries()) {
    console.log(`${String.fromCharCode(10)}[${номер + 1}] человек: ${фраза}`);
    const начало = Date.now();
    await разговор.hear(фраза);
    const прошло = (Date.now() - начало) / 1000;
    времена.push(прошло);
    console.log(`  время хода: ${прошло.toFixed(1)} с`);
  }

  перестать();
  разговор.dispose('проверка окончена');

  console.log(`${String.fromCharCode(10)}— итог —`);
  console.log(`ответов вслух: ${сказанное.length} из ${ходы.length}`);
  console.log(`времена: ${времена.map((т) => т.toFixed(1)).join(', ')} с`);

  // Ящика может не быть вовсе: если разговор не позвал add_note, файл никто не
  // создал. Это ответ «нет», а не повод уронить проверку.
  let ящик: Array<{ text: string }> = [];
  try {
    ящик = JSON.parse(readFileSync(path.join(ДОМ, 'notes.json'), 'utf8')) as Array<{ text: string }>;
  } catch {
    ящик = [];
  }
  const план = JSON.parse(readFileSync(ПЛАН, 'utf8')) as Plan;
  const виды = new Set(просьбы.map((п) => п.kind));

  const проверки: Array<[string, boolean]> = [
    ['add_note положил поправку в ящик', ящик.length > 0],
    ['add_step дописал шаг в план', план.steps.length > 2],
    ['start_work дошёл до моста', виды.has('start')],
    ['stop_work дошёл до моста', виды.has('stop')],
    ['pause_work дошёл до моста', виды.has('pause')],
    ['resume_work дошёл до моста', виды.has('resume')],
    ['разговор отвечал вслух', сказанное.length > 0],
  ];

  let плохо = 0;
  for (const [что, вышло] of проверки) {
    console.log(`${вышло ? 'ДА ' : 'НЕТ'} ${что}`);
    if (!вышло) плохо += 1;
  }
  if (ящик.length > 0) console.log(`  поправка: ${ящик.map((з) => з.text).join('; ')}`);
  console.log(`  план: ${план.steps.map((ш) => ш.text).join(' | ')}`);

  process.exit(плохо === 0 ? 0 : 1);
}

void main().catch((error: unknown) => {
  console.error('проверка сорвалась:', error);
  process.exit(1);
});
