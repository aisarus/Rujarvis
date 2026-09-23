/**
 * Сквозная проверка голосовых команд на живой машине.
 *
 * ## Зачем
 *
 * 20.09.2026 за один день вылезли пять поломок подряд, и ни одну не поймали
 * 1445 модульных тестов. Все пять были на стыках:
 *
 *   - имя «Джарвис» в начале фразы     мост → разбор команд
 *   - таблица псевдонимов              запуск ↔ поиск окна
 *   - «тишина» ничего не останавливала ядро → сессия
 *   - 401 у системы без ключей         Электрон → окружение CLI
 *   - фокус врал об успехе             драйвер не проверял себя
 *
 * Модульный тест проверяет функцию. Здесь проверяется ПУТЬ: фраза проходит
 * тот же разбор, тот же драйвер, те же таблицы — и проверяется не «вернулось
 * ли что-то», а что правда случилось на машине.
 *
 * ## Чего здесь нет
 *
 * Голоса. Всё остальное — настоящее, поэтому проверка живёт скриптом, а не в
 * наборе тестов: она открывает и закрывает окна на живом рабочем столе.
 *
 *   npx tsx scripts/проверка-команд.ts
 */

import { aliasTarget, matchAppLaunch, spokenCloseTarget, windowAlias } from '../jarvis/apps/launch';
import { parseDirectCommand } from '../jarvis/control/commands';
import { obviousAside } from '../jarvis/dialogue/aside';
import { matchVoiceControl } from '../jarvis/voice/interrupts';
import { DesktopDriver } from '../jarvis/desktop/driver';
import { meaningfulSpeech } from '../jarvis/voice/noise';
import { findWakeWord } from '../jarvis/voice/wakeWord';

const driver = new DesktopDriver();

interface Case {
  /** Что человек сказал вслух. */
  said: string;
  /** Что обязано произойти. Возвращает null, когда всё хорошо. */
  check: (said: string) => Promise<Verdict> | Verdict;
}

/**
 * Три исхода, а не два.
 *
 * «Окно не открыто» — не поломка команды, и записывать это провалом значит
 * приучить всех не смотреть на проверку. Прибор, который кричит по пустякам,
 * хуже отсутствующего.
 */
type Verdict = null | string | { нечем: string };

/** Так фразу видит мост: имя убрано, шум отсеян. */
function asBridgeSees(said: string): string | null {
  const heard = meaningfulSpeech(said);
  if (!heard) return null;
  const found = findWakeWord(heard);
  // Имя — обращение только в начале. Внутри фразы это содержание.
  if (!found || found.index !== 0) return heard;
  return found.command || heard;
}

function mustParse(said: string, kind: string): string | null {
  const command = parseDirectCommand(asBridgeSees(said) ?? '');
  if (!command) return `не разобрано как команда (ушло бы агенту)`;
  if (command.kind !== kind) return `разобрано как «${command.kind}», ожидали «${kind}»`;
  return null;
}

async function front(): Promise<string> {
  const windows = await driver.windows();
  return windows.find((w) => w.focused)?.title ?? '(нет)';
}

/** Переключение проверяется тем, что окно правда впереди, а не ответом драйвера. */
async function mustFocus(said: string, expect: RegExp): Promise<string | null> {
  const parsed = mustParse(said, 'focus');
  if (parsed) return parsed;

  const command = parseDirectCommand(asBridgeSees(said) ?? '');
  const title = (command as { title: string }).title;
  const tries = [windowAlias(title), aliasTarget(title), title].filter(Boolean) as string[];

  for (const candidate of tries) {
    try {
      await driver.focus(candidate);
    } catch {
      continue;
    }
    await new Promise((r) => setTimeout(r, 500));
    const now = await front();
    return expect.test(now) ? null : `впереди «${now}», ожидали ${expect}`;
  }
  return { нечем: `окно не открыто (пробовали: ${tries.join(', ')})` };
}

const CASES: Case[] = [
  // Имя в начале — самая дорогая поломка дня: из-за неё мимо шло ВСЁ.
  { said: 'следующая вкладка', check: (s) => mustParse(s, 'key') },
  { said: 'джарвис следующая вкладка', check: (s) => mustParse(s, 'key') },
  { said: 'Джарвис, переключи вкладку', check: (s) => mustParse(s, 'key') },
  { said: 'джарвис прокрути вниз', check: (s) => mustParse(s, 'scroll') },
  { said: 'джарвис нажми enter', check: (s) => mustParse(s, 'key') },

  // Красные линии: обязаны срабатывать всегда.
  {
    said: 'тишина',
    check: (s) => (matchVoiceControl(s)?.control === 'mute' ? null : 'не понято как заглушение'),
  },
  {
    said: 'джарвис стоп',
    check: (s) => (matchVoiceControl(s)?.control === 'stop' ? null : 'не понято как остановка'),
  },
  {
    said: 'останови всё',
    check: (s) => (matchVoiceControl(s)?.control === 'stop' ? null : 'не понято как остановка'),
  },

  // Шум за окном не должен становиться работой.
  {
    said: 'ДИНАМИЧНАЯ МУЗЫКА',
    check: (s) => (asBridgeSees(s) === null ? null : 'прошло как речь'),
  },
  { said: 'СТОП', check: (s) => (asBridgeSees(s) ? null : 'крик человека съеден') },

  // Запуск: пусковое имя либо есть, либо ищется в меню «Пуск» — но не пустота.
  {
    said: 'открой блокнот',
    check: (s) => (matchAppLaunch(asBridgeSees(s) ?? '') ? null : 'нет пускового имени'),
  },
  {
    said: 'джарвис открой хром',
    check: (s) => (matchAppLaunch(asBridgeSees(s) ?? '') ? null : 'нет пускового имени'),
  },
  {
    said: 'закрой блокнот',
    check: (s) => (spokenCloseTarget(asBridgeSees(s) ?? '') ? null : 'не понято как закрытие'),
  },

  // Режимы и служебное: каждое из этого человек называл вслух, и каждое
  // когда-то молча не срабатывало.
  { said: 'печатай', check: (s) => mustParse(s, 'dictation') },
  { said: 'джарвис печатай за мной', check: (s) => mustParse(s, 'dictation') },
  { said: 'диктую', check: (s) => mustParse(s, 'longSpeech') },
  { said: 'работай в фоне', check: (s) => mustParse(s, 'mode') },
  { said: 'джарвис показывай всё', check: (s) => mustParse(s, 'mode') },
  { said: 'что ты делаешь', check: (s) => mustParse(s, 'log') },
  { said: 'что ты сейчас делаешь', check: (s) => mustParse(s, 'log') },
  { said: 'где ты', check: (s) => mustParse(s, 'where') },
  { said: 'покажи сетку', check: (s) => mustParse(s, 'grid') },

  // Просьбы, которые ОБЯЗАНЫ уходить агенту: перехватить их таблицей значит
  // сделать половину дела и отчитаться целым.
  {
    said: 'открой блендер и сделай ракету',
    check: (s) => (parseDirectCommand(asBridgeSees(s) ?? '') ? 'перехвачено таблицей' : null),
  },
  {
    said: 'найди отчёт за март',
    check: (s) => (parseDirectCommand(asBridgeSees(s) ?? '') ? 'перехвачено таблицей' : null),
  },

  // Сказанное во время работы уходит в разговор, и решает он.
  //
  // Таблица примет тут больше не судья: 22.09.2026 «а пока» значило вторую
  // задачу, «туда же» — поправку, и человек получал «Учту» на вопрос. От
  // прежнего разбора остался один фильтр — пустое, и только он и проверяется.
  {
    said: 'спасибо',
    check: (s) => (obviousAside(s)?.kind === 'ignore' ? null : 'вежливость пошла в работу'),
  },
  {
    said: 'а пока найди мне картинки',
    check: (s) =>
      parseDirectCommand(asBridgeSees(s) ?? '') || obviousAside(s)?.kind === 'ignore'
        ? 'не дошло до разговора'
        : null,
  },
  {
    said: 'ты понял что надо делать',
    check: (s) =>
      parseDirectCommand(asBridgeSees(s) ?? '') || obviousAside(s)?.kind === 'ignore'
        ? 'вопрос не дошёл до разговора'
        : null,
  },
  { said: 'забудь разговор', check: (s) => mustParse(s, 'forgetTalk') },

  // Переключение — с проверкой того, что окно правда вышло вперёд.
  { said: 'джарвис переключись на эдж', check: (s) => mustFocus(s, /Edge/u) },
  { said: 'переключи вкладку на эдж', check: (s) => mustFocus(s, /Edge/u) },
  { said: 'переключись на джарвис', check: (s) => mustFocus(s, /Jarvis/u) },
];

async function main(): Promise<void> {
  let bad = 0;
  console.log(`Сквозная проверка: ${CASES.length} фраз${String.fromCharCode(10)}`);

  let skipped = 0;
  for (const item of CASES) {
    let verdict: Verdict;
    try {
      verdict = await item.check(item.said);
    } catch (error) {
      verdict = error instanceof Error ? error.message : String(error);
    }

    if (verdict === null) {
      console.log(`  ок   ${item.said}`);
    } else if (typeof verdict === 'object') {
      skipped += 1;
      console.log(`нечем  ${item.said.padEnd(34)} ${verdict.нечем}`);
    } else {
      bad += 1;
      console.log(`ПЛОХО  ${item.said.padEnd(34)} ${verdict}`);
    }
  }

  console.log('');
  const tail = skipped > 0 ? `, нечем проверить: ${skipped}` : '';
  console.log(bad === 0 ? `Всё прошло${tail}.` : `Не прошло: ${bad} из ${CASES.length}${tail}.`);
  driver.dispose?.();
  process.exit(bad === 0 ? 0 : 1);
}

void main();
