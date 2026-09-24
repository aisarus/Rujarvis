/**
 * Что Джарвис делает прямо сейчас, словами, которые читает человек.
 *
 * ## Зачем
 *
 * Человек попросил окно с человекочитаемым логом — и попросил не от любви к
 * логам. Замысел следующий: одна команда вроде «сделай сайт по моей биографии
 * в концепции Бруно Симон» запускает работу на десятки минут, в которой агент
 * сам роется в архиве, лезет в гитхаб, лепит модели, качает текстуры и пишет
 * физику. Всё это время человек не должен гадать, жив ли он и туда ли идёт.
 *
 * Сегодня такого окна нет, и видно это лучше всего по тому, как прошёл день:
 * человек писал «проверь логи, почини», а логи читались через меня.
 *
 * ## Чем это не является
 *
 * Не файлом `jarvis.log`. Там вперемешку кириллица дела и английский шум
 * подсистем — за один день `[FileTreeCache] Saved cache` занял больше строк,
 * чем вся работа. Человеку нужен рассказ о деле, а не поток отладки.
 *
 * Не пересказом голосом. `jarvis/voice/progress.ts` говорит раз в четверть
 * минуты и нарочно скупо: голосом нельзя зачитывать каждый шаг. Глазами —
 * можно и нужно, поэтому здесь строка на каждое событие и с подробностью,
 * которую голос опускает: какой файл, какая команда.
 *
 * ## Устройство
 *
 * Чистая функция плюс список. Ни окон, ни таймеров, ни электрона — всё это
 * снаружи. Так рассказ можно проверить тестом за миллисекунду, а не глазами в
 * запущенном приложении.
 */

import { stepStateLabel, type StepState } from '../agent/plan';
import type { BackendEvent } from '../backends/types';
import { tr } from '../locale/language';

/** О чём строка. Вид нужен окну: цвет, значок, отступ. */
export type StoryKind =
  | 'task'
  | 'start'
  | 'step'
  | 'command'
  | 'file'
  | 'said'
  | 'note'
  | 'plan'
  | 'error'
  | 'done';

export interface StoryLine {
  at: number;
  kind: StoryKind;
  /** Главное: что происходит. Короткое, читается с одного взгляда. */
  text: string;
  /** Над чем именно: имя файла, команда, текст ошибки. */
  detail?: string;
}

/**
 * Инструмент → то, что человек поймёт.
 *
 * Ключ — начало имени: у инструментов рабочего стола оно длинное и с
 * приставкой сервера, и сравнивать целиком незачем. Порядок важен: более
 * длинная приставка должна стоять выше более короткой, иначе «browser» съест
 * «browser_download».
 */
const STEPS: Array<[string, string, string]> = [
  ['mcp__jarvis-desktop__blender', 'Работаю в блендере', 'Working in Blender'],
  ['mcp__jarvis-desktop__browser_download', 'Скачиваю из браузера', 'Downloading from the browser'],
  ['mcp__jarvis-desktop__browser', 'Работаю в браузере', 'Working in the browser'],
  ['mcp__jarvis-desktop__screenshot', 'Смотрю на экран', 'Looking at the screen'],
  ['mcp__jarvis-desktop__elements', 'Разбираю окно', 'Reading the window'],
  ['mcp__jarvis-desktop__list_windows', 'Смотрю, что открыто', 'Checking what is open'],
  ['mcp__jarvis-desktop__focus', 'Переключаю окно', 'Switching windows'],
  ['mcp__jarvis-desktop__click', 'Нажимаю', 'Clicking'],
  ['mcp__jarvis-desktop__type', 'Печатаю', 'Typing'],
  ['mcp__jarvis-desktop__press', 'Нажимаю клавиши', 'Pressing keys'],
  ['mcp__jarvis-desktop__move_to_output', 'Убираю файл в папку', 'Moving the file to the folder'],
  ['mcp__jarvis-desktop__show_file', 'Показываю файл', 'Showing the file'],
  ['mcp__jarvis-desktop__output_folder', 'Смотрю папку результатов', 'Looking at the results folder'],
  ['mcp__jarvis-desktop__list_files', 'Смотрю файлы', 'Looking at the files'],
  ['mcp__jarvis-desktop__write_skill', 'Записываю навык', 'Writing a skill'],
  ['mcp__jarvis-desktop__list_skills', 'Смотрю навыки', 'Looking at skills'],
  ['mcp__jarvis-desktop__recent_actions', 'Вспоминаю, что делал', 'Recalling what I did'],
  ['WebSearch', 'Ищу в интернете', 'Searching the web'],
  ['WebFetch', 'Читаю страницу', 'Reading a page'],
  ['Bash', 'Выполняю команду', 'Running a command'],
  ['MultiEdit', 'Правлю файл', 'Editing a file'],
  ['NotebookEdit', 'Правлю тетрадь', 'Editing a notebook'],
  ['Write', 'Пишу файл', 'Writing a file'],
  ['Edit', 'Правлю файл', 'Editing a file'],
  ['Read', 'Читаю файл', 'Reading a file'],
  ['Glob', 'Ищу файлы', 'Looking for files'],
  ['Grep', 'Ищу по тексту', 'Searching the text'],
  ['TodoWrite', 'Веду список шагов', 'Keeping a step list'],
  ['Task', 'Отправляю подзадачу', 'Sending a subtask'],
];

const FILE_ACTIONS: Record<string, [string, string]> = {
  created: ['Создал файл', 'Created a file'],
  modified: ['Изменил файл', 'Changed a file'],
  deleted: ['Удалил файл', 'Deleted a file'],
};

/** Сколько строк держать: часовая работа — это тысячи событий. */
const DEFAULT_LIMIT = 500;
/** Длиннее этого подробность не читается на ходу. */
const DETAIL_LIMIT = 120;

/**
 * Имя файла вместо пути.
 *
 * Полный путь в каждой строке превращает окно в стену, в которой не видно
 * дела. Разделитель может быть любым: пути приходят и от Windows, и из-под
 * инструментов, которые пишут через косую черту.
 */
function fileName(value: string): string {
  const parts = value.split(/[\\/]/u).filter(Boolean);
  return parts.length > 0 ? (parts[parts.length - 1] as string) : value;
}

function short(value: string): string {
  const clean = value.replace(/\s+/gu, ' ').trim();
  return clean.length > DETAIL_LIMIT ? `${clean.slice(0, DETAIL_LIMIT - 1)}…` : clean;
}

/** Выглядит ли подробность путём к файлу, а не просто текстом. */
function looksLikePath(value: string): boolean {
  return /[\\/]/u.test(value) && !value.includes(' ');
}

/**
 * Событие в строку ленты.
 *
 * Стойко к неполному событию, и это не перестраховка. Строка пишется внутри
 * подписки на задачи: исключение здесь оборвало бы не одну строку, а всю
 * ленту — и человек, глядящий в окно посреди получасовой работы, увидел бы,
 * что она замерла. Находка сторожа `storyline.coverage.vitest.test.ts`.
 */
export function describeEvent(event: BackendEvent, at: number): StoryLine | null {
  switch (event.type) {
    case 'started':
      return { at, kind: 'start', text: tr('Взялся за работу', 'Started the work'), detail: event.backend };

    case 'tool': {
      const name = event.name ?? '';
      const known = STEPS.find(([prefix]) => name.startsWith(prefix));
      // Незнакомый инструмент показывается своим именем. Придумать ему
      // красивую фразу значит соврать: человек прочтёт «работаю с файлами»
      // там, где на деле происходит что-то другое.
      const text = known ? tr(known[1], known[2]) : name || tr('Делаю что-то', 'Doing something');
      const detail = event.detail
        ? short(looksLikePath(event.detail) ? fileName(event.detail) : event.detail)
        : undefined;
      return { at, kind: 'step', text, ...(detail ? { detail } : {}) };
    }

    case 'command': {
      const failed = typeof event.exitCode === 'number' && event.exitCode !== 0;
      const command = short(event.command ?? '');
      return {
        at,
        kind: failed ? 'error' : 'command',
        text: failed ? tr('Команда не удалась', 'Command failed') : tr('Команда', 'Command'),
        ...(command ? { detail: command } : {}),
      };
    }

    case 'file-changed': {
      const change = event.change;
      return {
        at,
        kind: 'file',
        text: (() => {
          const action = change ? FILE_ACTIONS[change.action] : undefined;
          return action ? tr(action[0], action[1]) : tr('Тронул файл', 'Touched a file');
        })(),
        ...(change?.path ? { detail: fileName(change.path) } : {}),
      };
    }

    case 'assistant-text': {
      const text = short(event.text ?? '');
      return text ? { at, kind: 'said', text } : { at, kind: 'said', text: '…' };
    }

    case 'error':
      return {
        at,
        kind: 'error',
        text: tr('Ошибка', 'Error'),
        detail: short(event.message ?? tr('без объяснения', 'no explanation')),
      };

    case 'completed': {
      // Итог показывается словами самого ответа. «Готово» без него — то же
      // молчание: человек, отошедший на двадцать минут, вернётся и увидит, что
      // работа кончилась, но не узнает чем.
      const result = event.result;
      const ok = result?.ok === true;
      const outcome = ok ? result?.text : (result?.error ?? result?.text);
      return {
        at,
        kind: 'done',
        text: ok ? tr('Готово', 'Done') : tr('Не получилось', 'Did not work'),
        ...(outcome ? { detail: short(outcome) } : {}),
      };
    }

    default:
      // Молчание — только по списку выше. Незнакомый вид сюда не доходит:
      // сторож `storyline.coverage.vitest.test.ts` валит набор раньше.
      return null;
  }
}

/**
 * Виды событий, о которых человеку намеренно не говорят.
 *
 * Список нужен не коду, а сторожу. Он требует, чтобы каждый вид события был
 * либо пересказан словами, либо назван здесь — то есть чтобы молчание было
 * решением, а не забывчивостью.
 *
 * Приём взят у Aegis: там тест регуляркой выгребает все виды записей из ядра и
 * падает, если хоть один печатается сырым JSON. По словам автора, этот тест
 * поймал его дважды за сутки.
 */
export const SILENT_EVENTS: readonly string[] = [
  // Служебный поток бэкенда: «думаю», «пишу» — десятки строк в минуту, в
  // которых тонет дело. Человеку он не говорит ничего.
  'status',
];

export interface StorylineOptions {
  limit?: number;
  /**
   * Куда сообщать о новой строке — обычно в окно.
   *
   * Иначе окну пришлось бы перечитывать весь список на каждое событие и самому
   * догадываться, что в нём нового.
   */
  onLine?: (line: StoryLine) => void;
}

export class Storyline {
  private readonly limit: number;
  private readonly onLine: ((line: StoryLine) => void) | undefined;
  private readonly kept: StoryLine[] = [];

  constructor(options: StorylineOptions = {}) {
    this.limit = options.limit ?? DEFAULT_LIMIT;
    this.onLine = options.onLine;
  }

  /** Новая задача — новая глава: без неё поток сливается в одну ленту. */
  begin(utterance: string, at: number): void {
    this.add({ at, kind: 'task', text: short(utterance) });
  }

  /**
   * Человек сказал что-то, пока шла работа.
   *
   * Отдельным видом, а не как слова агента: в ленте должно быть видно, кто
   * говорит. Иначе человек, отлиставший назад, не поймёт, откуда взялась
   * поправка.
   */
  heard(text: string, at: number): void {
    const said = short(text);
    if (said) this.add({ at, kind: 'note', text: tr('Ты сказал', 'You said'), detail: said });
  }

  /**
   * Шаг плана сменил состояние.
   *
   * Отдельной строкой в ленте, а не только числом в заголовке: человек,
   * вернувшийся через двадцать минут, должен видеть не «сделано 4 из 7», а
   * когда именно каждый шаг был взят и чем кончился.
   */
  planStep(index: number, total: number, text: string, state: StepState, at: number): void {
    const label = stepStateLabel(state);
    this.add({
      at,
      kind: 'plan',
      text: tr(`Шаг ${index + 1} из ${total}: ${label}`, `Step ${index + 1} of ${total}: ${label}`),
      detail: short(text),
    });
  }

  saw(event: BackendEvent, at: number): void {
    const line = describeEvent(event, at);
    if (line) this.add(line);
  }

  get lines(): readonly StoryLine[] {
    return this.kept;
  }

  private add(line: StoryLine): void {
    this.kept.push(line);
    if (this.kept.length > this.limit) this.kept.splice(0, this.kept.length - this.limit);
    try {
      this.onLine?.(line);
    } catch {
      // Окно могло закрыться. Рассказ из-за этого прерываться не должен.
    }
  }
}
