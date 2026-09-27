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
 * Для Codex ещё две вещи: он не должен звать свой компьютер-юз (`cua_*` из
 * плагинов OpenAI — 27.09.2026 так ушло 333 541 входной токен на неверный
 * ответ) и не должен съедать больше 100 тысяч входных токенов на такой
 * вопрос.
 *
 * И продолжение сессии: «пауза → продолжай» и каждая следующая реплика
 * разговора идут через прошлую сессию агента. 27.09.2026 у Codex оно падало
 * на разборе аргументов, и ни одна проверка этого не видела — все запускали
 * только новые сессии.
 *
 * Нужны вход в Claude Code и Codex на подписке, поэтому гоняется на машине
 * человека, а не в CI. Данные, память и результаты — во временных папках:
 * журнал, память и план человека проверка не трогает. (Память трогала: до
 * 27.09.2026 здесь не был задан её файл, и две проверочные задачи легли в
 * настоящую память владельца.)
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
import type { JarvisTask } from '../../jarvis/tasks/manager';

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

/** Свой компьютер-юз OpenAI в Codex: `cua_repl` и соседи из его плагинов. */
const СВОЙ_КОМПЬЮТЕР_ЮЗ = /^cua_|computer[-_]use/iu;

/**
 * Сколько входных токенов разумно на «какие окна открыты».
 *
 * Замер 27.09.2026: без плагинов владельца Codex тратит 15–70 тысяч, с ними —
 * 333 тысячи. Предел между этими мирами.
 */
const ПРЕДЕЛ_ТОКЕНОВ = 100_000;

/** Какие инструменты звал агент и сколько входных токенов съел. */
function расход(task: JarvisTask): { инструменты: string[]; токены?: number } {
  const инструменты = task.events.flatMap((событие) => (событие.type === 'tool' ? [событие.name] : []));
  return { инструменты: [...new Set(инструменты)], токены: task.result?.inputTokens };
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
    memoryFile: path.join(данные, 'memory.json'),
    desktopMcpConfig: mcp.file,
    gateSettings: gate.settings,
    gateConfig: gate.config,
    homeDir: paths.home,
    outputDir: результаты,
    speak: () => undefined,
  });
  await jarvis.ready();
  const готовы = new Map((await jarvis.backends.availability(true)).map((b) => [b.id, b.ready]));

  /** Дождаться конца задачи; не кончилась за 4 минуты — отменить и false. */
  const дождаться = (task: JarvisTask): Promise<boolean> =>
    new Promise<boolean>((resolve) => {
      if (task.state !== 'running' && task.state !== 'queued') return resolve(true);
      const таймер = setTimeout(() => {
        стоп();
        jarvis.tasks.cancel(task.id);
        resolve(false);
      }, 240_000);
      const стоп = jarvis.tasks.subscribe((событие) => {
        if (событие.type === 'task-finished' && событие.task.id === task.id) {
          clearTimeout(таймер);
          стоп();
          resolve(true);
        }
      });
    });

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

    if (!(await дождаться(turn.task))) {
      итоги.push({ имя: случай.имя, итог: { вид: 'не прошло', почему: 'задача не кончилась за 4 минуты' } });
      continue;
    }
    const { инструменты, токены } = расход(turn.task);
    console.log(`    ${случай.бэкенд}: инструменты ${инструменты.join(', ') || 'нет'}; входных токенов ${токены ?? 'не сообщает'}`);

    const текст = (turn.task.result?.text ?? '').toLowerCase();
    // Числа ответа целыми словами: pid 2036 не должен найтись внутри 20368.
    const числаОтвета = new Set(текст.split(/[^0-9]+/u).filter(Boolean));
    const совпало = [
      ...pids.filter((p) => числаОтвета.has(p)).map((p) => `pid ${p}`),
      ...признаки.filter((п) => текст.includes(п)),
    ];
    const вопросы = вопросыХука.slice(было);
    const своё = инструменты.filter((и) => СВОЙ_КОМПЬЮТЕР_ЮЗ.test(и));
    const итог: Итог = !turn.decision.needs.includes('computer')
      ? { вид: 'не прошло', почему: `задача не получила умения computer: ${turn.decision.needs.join(', ')}` }
      : своё.length > 0
        ? { вид: 'не прошло', почему: `агент работал своим компьютер-юзом, а не инструментами Джарвиса: ${своё.join(', ')}` }
      : токены !== undefined && токены > ПРЕДЕЛ_ТОКЕНОВ
        ? { вид: 'не прошло', почему: `съел ${токены} входных токенов — больше ${ПРЕДЕЛ_ТОКЕНОВ}` }
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

  // Продолжение своей сессии — тем же путём, что «пауза → продолжай» и
  // следующая реплика разговора. Доказательство не в словах ответа: вторая
  // задача прошла у того же агента, и он вернул тот же поток, что вёл первую.
  for (const [бэкенд, через] of [
    ['claude-code', 'через Claude Code'],
    ['codex', 'через Codex'],
  ] as const) {
    const имя = `${бэкенд === 'codex' ? 'Codex' : 'Claude Code'} продолжает свою сессию`;
    if (!готовы.get(бэкенд)) {
      итоги.push({ имя, итог: { вид: 'нечем мерить', почему: `${бэкенд} не готов: нет входа или не установлен` } });
      continue;
    }
    const первая = await jarvis.core.handleUtterance(`Придумай любое пятизначное число и назови только его. Сделай это ${через}.`);
    if (первая.kind !== 'task' || !(await дождаться(первая.task))) {
      итоги.push({ имя, итог: { вид: 'не прошло', почему: `первая просьба не стала задачей или не кончилась (${первая.kind})` } });
      continue;
    }
    const было = первая.task.result;
    if (было?.ok !== true || было.backend !== бэкенд || !первая.task.sessionId) {
      итоги.push({
        имя,
        итог: { вид: 'не прошло', почему: `первая задача: ${было?.backend} ok=${было?.ok}, сессия ${первая.task.sessionId ?? 'нет'}; ${было?.error ?? ''}` },
      });
      continue;
    }
    const вторая = await jarvis.core.handleUtterance('Сделай его на единицу больше');
    if (вторая.kind !== 'task' || !(await дождаться(вторая.task))) {
      итоги.push({ имя, итог: { вид: 'не прошло', почему: `продолжение не стало задачей или не кончилось (${вторая.kind})` } });
      continue;
    }
    const стало = вторая.task.result;
    console.log(
      `    ${бэкенд}: «${было.text.trim().slice(0, 20)}» → «${(стало?.text ?? '').trim().slice(0, 20)}»; поток ${первая.task.sessionId} → ${вторая.task.sessionId}`,
    );
    итоги.push({
      имя,
      итог:
        стало?.ok !== true || стало.backend !== бэкенд
          ? { вид: 'не прошло', почему: `продолжение: ${стало?.backend} ok=${стало?.ok}; ${стало?.error ?? ''}` }
          : вторая.task.request.sessionId !== первая.task.sessionId || вторая.task.sessionId !== первая.task.sessionId
            ? { вид: 'не прошло', почему: `продолжение ушло не в тот поток: ${вторая.task.sessionId ?? 'нет'}` }
            : { вид: 'прошло', чем: `тот же поток ${первая.task.sessionId}` },
    });
  }

  гасиМост();
  // Живые сессии агента — дочерние процессы: process.exit ниже их не гасит.
  jarvis.dispose();

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
