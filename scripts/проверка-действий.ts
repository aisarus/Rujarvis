/**
 * Проверка действий, а не разбора.
 *
 * ## Зачем
 *
 * Все прежние сквозные проверки отвечали на вопрос «фраза превратилась в
 * верную команду?». Два бага 20.09.2026 жили ровно в зазоре между этим
 * вопросом и следующим: «диктую» разбиралось верно и падало при выполнении,
 * «тишина» разбиралась верно и не останавливала речь. Оба прошли бы любую
 * проверку разбора.
 *
 * Здесь каждая фраза не только разбирается, но и ВЫПОЛНЯЕТСЯ, а потом
 * сверяется разница состояния машины до и после. Ожидаемая разница и есть
 * определение того, что команда работает.
 *
 * Проверка трогает живой рабочий стол: открывает и закрывает окна, переключает
 * фокус. Поэтому она скрипт, а не тест.
 *
 *   npx tsx scripts/проверка-действий.ts
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { windowCandidates } from '../jarvis/apps/launch';
import { parseDirectCommand } from '../jarvis/control/commands';
import { DesktopDriver } from '../jarvis/desktop/driver';
import {
  diff,
  describeDiff,
  unmet,
  НЕЧЕМ,
  type Expectation,
  type Snapshot,
} from '../jarvis/observe/machine';
import { meaningfulSpeech } from '../jarvis/voice/noise';
import { findWakeWord } from '../jarvis/voice/wakeWord';

const NL = String.fromCharCode(10);
const run = promisify(execFile);
const driver = new DesktopDriver();

/** Три исхода: прошло, не прошло, нечем проверить. */
type Исход = null | string | { нечем: string };

interface Случай {
  сказано: string;
  ждём: Expectation;
  /** Когда проверять нечем — например, нужная программа не запущена. */
  пропустить?: () => Promise<string | null>;
}

/** Так фразу видит мост: шум отсеян, обращение снято. */
function какВидитМост(сказано: string): string | null {
  const услышано = meaningfulSpeech(сказано);
  if (!услышано) return null;
  const имя = findWakeWord(услышано);
  if (!имя || имя.index !== 0) return услышано;
  return имя.command || услышано;
}

/** Имена запущенных программ. */
async function программы(): Promise<string[]> {
  try {
    const { stdout } = await run(
      'powershell',
      ['-NoProfile', '-Command', 'Get-Process | Select-Object -ExpandProperty ProcessName'],
      { windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
    );
    return stdout.split(/\r?\n/u).map((s) => s.trim()).filter(Boolean);
  } catch (error) {
    // Пустой список вместо отказа — ложь в обе стороны.
    //
    // Если PowerShell недоступен совсем, процессы не мерились НИКОГДА, и
    // случаи «ничего не должно случиться» проходили, не проверив запуск
    // программ. Если он упал разово, «до» и «после» получали разные списки, и
    // разбор видел запуск и закрытие программ, которых не было.
    throw new Error(
      `не удалось прочитать список программ: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Снимок машины: что впереди, какие окна, какие программы. */
async function снять(): Promise<Snapshot> {
  const [окна, процессы] = await Promise.all([driver.windows(), программы()]);
  return {
    at: Date.now(),
    front: окна.find((w) => w.focused)?.title ?? '',
    windows: окна.map((w) => ({ title: w.title, process: String(w.pid), focused: w.focused })),
    processes: процессы,
  };
}

/**
 * Выполнить фразу так же, как это делает мост.
 *
 * Только прямые команды: задача с агентом заняла бы минуты и зависела бы от
 * модели, а здесь проверяется мгновенный слой.
 */
async function выполнить(сказано: string): Promise<string | null> {
  const фраза = какВидитМост(сказано);
  // Отсеяно фильтром шума — значит ничего и не произошло, и это ровно то,
  // чего ждут от подписи Whisper под музыку за окном.
  if (!фраза) return null;

  const команда = parseDirectCommand(фраза);
  if (!команда) return null; // Не прямая команда — так и задумано в части случаев.

  switch (команда.kind) {
    case 'key':
      await driver.key(команда.keys);
      return null;
    case 'scroll':
      await driver.scroll(команда.amount);
      return null;
    case 'focus': {
      // Тот же список имён и тот же порядок, что у моста.
      const варианты = windowCandidates(команда.title);
      for (const цель of варианты) {
        try {
          await driver.focus(цель);
          return null;
        } catch {
          // Пробуем следующее написание.
        }
      }
      return `окно не найдено ни под одним именем: ${варианты.join(', ')}`;
    }
    default:
      return `эта проверка не умеет выполнять «${команда.kind}»`;
  }
}

/**
 * Ждать, пока ожидаемое сбудется, а не смотреть один раз.
 *
 * Однократный снимок через паузу воюет с посторонним: на живом столе рядом
 * всплывают уведомления и чужие окна, и снимок ловит их, а не результат
 * команды. Здесь проверка повторяется, пока ожидаемое не сбудется или не
 * кончится срок — «условие должно стать истинным за N мс» вместо «посмотрели
 * один раз и решили».
 */
async function дождаться(ждём: Expectation, до: Snapshot, срок = 2_500): Promise<string | null> {
  // Ожидание бездействия ждать нельзя: ему надо дать шанс нарушиться.
  if (ждём.nothing) {
    await new Promise((r) => setTimeout(r, 700));
    const после = await снять();
    return unmet(ждём, diff(до, после), после);
  }

  const край = Date.now() + срок;
  let последняя: string | null = 'ничего не дождались';
  while (Date.now() < край) {
    await new Promise((r) => setTimeout(r, 250));
    const после = await снять();
    последняя = unmet(ждём, diff(до, после), после);
    if (последняя === null) return null;
  }
  return последняя;
}

/**
 * Есть ли открытое окно с таким заголовком.
 *
 * Именно окно, а не процесс: процесс `claude` — это ещё и сам CLI, и проверка
 * по имени процесса врала, будто окно приложения открыто.
 */
async function естьОкно(часть: string): Promise<boolean> {
  // Без `try`: отказ драйвера — это «не прошло», а не «окна нет».
  //
  // Раньше любое исключение давало `false`, все три случая переключения
  // уходили в «нечем проверить», `плохо` оставалось нулём, и прогон выходил с
  // кодом 0 со словами «Всё прошло, нечем проверить: 3». Исключение теперь
  // ловит общий `catch` прогона и пишет ПЛОХО.
  const окна = await driver.windows();
  return окна.some((w) => w.title.toLowerCase().includes(часть.toLowerCase()));
}

const СЛУЧАИ: Случай[] = [
  {
    сказано: 'джарвис переключись на эдж',
    ждём: { frontContains: 'Edge' },
    пропустить: async () => ((await естьОкно('Edge')) ? null : 'окна Edge нет'),
  },
  {
    сказано: 'переключи вкладку на клод',
    ждём: { frontContains: 'Claude' },
    пропустить: async () => ((await естьОкно('Claude')) ? null : 'окна Claude нет'),
  },
  {
    сказано: 'переключись на эдж',
    ждём: { frontContains: 'Edge' },
    пропустить: async () => ((await естьОкно('Edge')) ? null : 'окна Edge нет'),
  },

  // Просьбы, которые обязаны уйти агенту: перехватить их таблицей значит
  // сделать половину дела и отчитаться целым.
  { сказано: 'найди отчёт за март', ждём: { nothing: true } },
  { сказано: 'открой блендер и сделай ракету', ждём: { nothing: true } },
  { сказано: 'расскажи что нового', ждём: { nothing: true } },

  // Шум за окном не должен двигать машину.
  { сказано: 'ДИНАМИЧНАЯ МУЗЫКА', ждём: { nothing: true } },
];

async function main(): Promise<void> {
  console.log(`Проверка действий: ${СЛУЧАИ.length} случаев${NL}`);
  let плохо = 0;
  let нечем = 0;

  for (const случай of СЛУЧАИ) {
    let исход: Исход;
    try {
      const пропуск = случай.пропустить ? await случай.пропустить() : null;
      if (пропуск) {
        исход = { нечем: пропуск };
      } else {
        const до = await снять();
        const беда = await выполнить(случай.сказано);
        const ответ = беда ?? (await дождаться(случай.ждём, до));
        // Пометка «нечем мерить» из наблюдателя — это третий исход, а не
        // провал: сворачивать его в «не прошло» правила проекта запрещают.
        исход = typeof ответ === 'string' && ответ.startsWith(НЕЧЕМ) ? { нечем: ответ } : ответ;
        if (исход === null && !случай.ждём.nothing) {
          console.log(`       ${describeDiff(diff(до, await снять()))}`);
        }
      }
    } catch (ошибка) {
      исход = ошибка instanceof Error ? ошибка.message : String(ошибка);
    }

    if (исход === null) console.log('  ок   ' + случай.сказано);
    else if (typeof исход === 'object') {
      нечем += 1;
      console.log('нечем  ' + случай.сказано.padEnd(36) + исход.нечем);
    } else {
      плохо += 1;
      console.log('ПЛОХО  ' + случай.сказано.padEnd(36) + исход);
    }
  }

  console.log('');
  const хвост = нечем > 0 ? `, нечем проверить: ${нечем}` : '';
  console.log(плохо === 0 ? `Всё прошло${хвост}.` : `Не прошло: ${плохо}${хвост}.`);
  driver.dispose?.();
  process.exit(плохо === 0 ? 0 : 1);
}

void main();
