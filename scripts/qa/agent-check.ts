/**
 * Живая проверка пути «агент → инструменты окон → хук красных линий».
 *
 * Тот путь, на котором у владельца 26.09.2026 «управление окнами отказывало»:
 * задача не получала умения `computer`, инструменты окон не попадали в
 * разрешённые, и агент докладывал «нужно разрешить инструменты
 * jarvis-desktop». Классификацию тогда починили, а сам путь не проверяла ни
 * одна проверка: `jarvis:try` создаёт Джарвиса без MCP-сервера рабочего стола
 * и без хука, а `jarvis:hands-check` зовёт инструменты напрямую, минуя агента.
 *
 * Здесь Джарвис собирается так же, как в приложении: тот же конфиг MCP
 * (`jarvis/desktop/mcpConfig.ts`) и тот же хук (`prepareGate`). Задача только
 * читает — «какие окна открыты», — так что ничего у человека не двигает.
 *
 * Что модель правда позвала инструмент, а не выдумала ответ, видно по самому
 * ответу: в нём должен быть кусок настоящего заголовка окна с этого экрана.
 * Такой не угадать.
 *
 * Нужны вход в Claude Code и Codex на подписке, поэтому гоняется на машине
 * человека, а не в CI. Данные и результаты — во временных папках: журнал и
 * план человека проверка не трогает.
 */
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createJarvis } from '../../jarvis/createJarvis';
import { writeDesktopMcpConfig } from '../../jarvis/desktop/mcpConfig';
import { createDesktopDriver } from '../../jarvis/desktop/platform';
import { GateBridge } from '../../jarvis/risk/gateBridge';
import { prepareGate } from '../../jarvis/risk/gateSetup';
import { jarvisPaths } from '../../jarvis/setup/paths';

type Итог =
  | { вид: 'прошло'; чем: string }
  | { вид: 'не прошло'; почему: string }
  | { вид: 'нечем мерить'; почему: string };

/** Слова, по которым ответ не доказывает ничего: их можно назвать наугад. */
const ОБЩИЕ = new Set([
  'microsoft', 'windows', 'edge', 'google', 'chrome', 'claude', 'настройки', 'параметры',
  'проводник', 'explorer', 'terminal', 'notepad', 'блокнот', 'страницы', 'вкладка',
]);

/** Отличительные куски заголовков: длинные и не из общих слов. */
function приметы(заголовки: readonly string[]): string[] {
  const все = new Set<string>();
  for (const заголовок of заголовки) {
    for (const слово of заголовок.replace(/[​-‍]/gu, '').split(/[^\p{L}\p{N}]+/u)) {
      const с = слово.toLowerCase();
      if (с.length >= 5 && !ОБЩИЕ.has(с)) все.add(с);
    }
  }
  return [...все];
}

/** Признаки того самого отказа: агент просит разрешить то, что ему не дали. */
const ОТКАЗ = /разрешить инструмент|нет доступа к управлению|нужно разрешить|permission|not allowed|не разрешен/iu;

async function main(): Promise<void> {
  console.log('');
  console.log('Путь через агента: инструменты окон и хук, как в приложении');
  console.log('');

  const итоги: Array<{ имя: string; итог: Итог }> = [];
  const paths = jarvisPaths();
  const данные = mkdtempSync(path.join(os.tmpdir(), 'jarvis-agent-data-'));
  const результаты = mkdtempSync(path.join(os.tmpdir(), 'jarvis-agent-out-'));

  // 1. Конфиг MCP — тот же, что у приложения.
  const mcp = writeDesktopMcpConfig({
    appRoot: process.cwd(),
    dataDir: данные,
    outputDir: результаты,
    language: 'ru',
  });
  if (!mcp.ok) {
    const почему = 'missing' in mcp ? `не найден ${mcp.missing} — сначала pnpm build` : String(mcp.error);
    console.log(`НЕЧЕМ МЕРИТЬ: ${почему}`);
    process.exit(2);
  }

  // 2. Хук красных линий — тот же, что у приложения.
  const gate = prepareGate({
    appRoot: process.cwd(),
    dataDir: данные,
    outputDir: результаты,
    homeDir: paths.home,
    language: 'ru',
  });
  if (!gate.ok) {
    console.log(`НЕЧЕМ МЕРИТЬ: хук красных линий не собрался: ${gate.reason}`);
    process.exit(2);
  }
  // Спросит — отказываем. Задача только читает; вопрос хука здесь сам по
  // себе новость, и она попадёт в отчёт.
  const вопросыХука: string[] = [];
  const гасиМост = new GateBridge(gate.bridgeDir).serve((вопрос) => {
    вопросыХука.push(вопрос.summary);
    return false;
  });

  // 3. Что сейчас на экране — чтобы было с чем сверить ответ.
  const desktop = createDesktopDriver();
  const окнаЭкрана = await desktop.windows();
  desktop.dispose();
  const заголовки = окнаЭкрана.map((о) => о.title).filter(Boolean);
  // Главное доказательство — pid. Первая версия сверяла только отличительные
  // слова заголовков, и на живом прогоне 26.09.2026 промахнулась: агент честно
  // назвал три окна с настоящими pid (18076, 2036, 27784), но у всех трёх
  // названия общие — «Claude», «Настройки», «Параметры». Pid не угадать.
  const pids = [...new Set(окнаЭкрана.map((о) => String(о.pid)).filter((p) => p.length >= 3))];
  const признаки = приметы(заголовки);
  console.log(`    на экране ${заголовки.length} окон; pid: ${pids.length}, отличительных слов: ${признаки.length}`);

  const jarvis = createJarvis({
    workspace: результаты,
    desktopMcpConfig: mcp.file,
    gateSettings: gate.settings,
    homeDir: paths.home,
    outputDir: результаты,
    speak: () => undefined,
  });
  await jarvis.ready();
  const готовы = new Map((await jarvis.backends.availability(true)).map((b) => [b.id, b.ready]));

  const случаи: Array<{ имя: string; фраза: string; бэкенд: string }> = [
    { имя: 'Claude Code видит окна через инструменты', фраза: 'Какие окна сейчас открыты на экране? Перечисли их заголовки.', бэкенд: 'claude-code' },
    {
      имя: 'Codex видит окна через инструменты',
      фраза: 'Какие окна сейчас открыты на экране? Перечисли их заголовки. Сделай это через Codex.',
      бэкенд: 'codex',
    },
  ];

  for (const случай of случаи) {
    if (!готовы.get(случай.бэкенд as never)) {
      итоги.push({ имя: случай.имя, итог: { вид: 'нечем мерить', почему: `${случай.бэкенд} не готов: нет входа или не установлен` } });
      continue;
    }
    const было = вопросыХука.length;
    const turn = await jarvis.core.handleUtterance(случай.фраза);
    if (turn.kind !== 'task') {
      итоги.push({ имя: случай.имя, итог: { вид: 'не прошло', почему: `фраза не стала задачей, а стала «${turn.kind}»` } });
      continue;
    }
    if (turn.decision.target !== случай.бэкенд) {
      итоги.push({
        имя: случай.имя,
        итог: { вид: 'нечем мерить', почему: `задачу взял ${turn.decision.target}, а не ${случай.бэкенд}` },
      });
      continue;
    }
    console.log(`    ${случай.бэкенд}: умения ${turn.decision.needs.join(', ')}`);

    const закончилась = await new Promise<boolean>((resolve) => {
      if (turn.task.state !== 'running' && turn.task.state !== 'queued') return resolve(true);
      const таймер = setTimeout(() => {
        стоп();
        resolve(false);
      }, 240_000);
      const стоп = jarvis.tasks.subscribe((событие) => {
        if (событие.type === 'task-finished' && событие.task.id === turn.task.id) {
          clearTimeout(таймер);
          стоп();
          resolve(true);
        }
      });
    });
    if (!закончилась) {
      jarvis.tasks.cancel(turn.task.id);
      итоги.push({ имя: случай.имя, итог: { вид: 'не прошло', почему: 'задача не кончилась за 4 минуты' } });
      continue;
    }

    const текст = (turn.task.result?.text ?? '').toLowerCase();
    // Числа ответа целыми словами: pid 2036 не должен найтись внутри 20368.
    const числаОтвета = new Set(текст.split(/[^0-9]+/u).filter(Boolean));
    const совпало = [
      ...pids.filter((p) => числаОтвета.has(p)).map((p) => `pid ${p}`),
      ...признаки.filter((п) => текст.includes(п)),
    ];
    const вопросы = вопросыХука.slice(было);
    const итог: Итог = !turn.decision.needs.includes('computer')
      ? { вид: 'не прошло', почему: `задача не получила умения computer: ${turn.decision.needs.join(', ')}` }
      : ОТКАЗ.test(текст)
        ? { вид: 'не прошло', почему: `агент упёрся в запрет: ${текст.replace(/\s+/gu, ' ').slice(0, 220)}` }
        : turn.task.result?.ok !== true
          ? { вид: 'не прошло', почему: `задача не удалась: ${turn.task.result?.error ?? текст.slice(0, 200)}` }
          : совпало.length === 0
            ? {
                вид: 'не прошло',
                почему: `в ответе нет ни настоящего pid, ни настоящего заголовка — похоже на выдумку: ${текст.replace(/\s+/gu, ' ').slice(0, 220)}`,
              }
            : {
                вид: 'прошло',
                чем: `назвал настоящие окна (${совпало.slice(0, 3).join(', ')})${вопросы.length ? `; хук спрашивал: ${вопросы.join(' | ')}` : ''}`,
              };
    итоги.push({ имя: случай.имя, итог });
  }

  гасиМост();

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
  process.exit(неПрошло > 0 ? 1 : нечем > 0 ? 2 : 0);
}

void main();
