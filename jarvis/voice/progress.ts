/**
 * Голос во время работы.
 *
 * Задача «открой блендер и создай красную сферу» выполняется ровно так, как
 * просили, и занимает две минуты. Всё это время Джарвис молчал — и человек,
 * прождав пятьдесят секунд, решил, что он сломался: сказал «спасибо», «пока»,
 * и каждая из этих фраз запустила новую задачу. Готовый ответ пришёл в пустоту.
 *
 * Молчание длиннее полуминуты неотличимо от поломки. Поэтому во время долгой
 * работы Джарвис коротко говорит, чем занят.
 *
 * ## Чего здесь нарочно нет
 *
 * **Доклада о каждом шаге.** Агент делает десятки вызовов в минуту; озвучивать
 * их значит превратить помощника в бубнящее радио. Говорится один раз в
 * четверть минуты и только о последнем шаге.
 *
 * **Доклада о коротких задачах.** Первые двадцать секунд — тишина: задача,
 * которая укладывается в них, в сопровождении не нуждается.
 */

import type { BackendEvent } from '../backends/types';

/** Сколько молчать в начале: короткой задаче доклад не нужен. */
const QUIET_MS = 20_000;
/** Сколько молчать между докладами. */
const GAP_MS = 25_000;

/**
 * Инструмент → то, что человек поймёт.
 *
 * Ключ — начало имени: у инструментов рабочего стола оно длинное и с
 * приставкой сервера, и сравнивать целиком незачем.
 */
const STEPS: Array<[string, string]> = [
  ['mcp__jarvis-desktop__blender', 'Работаю в блендере'],
  ['mcp__jarvis-desktop__screenshot', 'Смотрю на экран'],
  ['mcp__jarvis-desktop__browser', 'Работаю в браузере'],
  ['mcp__jarvis-desktop__click', 'Нажимаю'],
  ['mcp__jarvis-desktop__type', 'Печатаю'],
  ['mcp__jarvis-desktop__press', 'Нажимаю клавиши'],
  ['mcp__jarvis-desktop__list_windows', 'Смотрю, что открыто'],
  ['mcp__jarvis-desktop__focus', 'Переключаю окно'],
  ['mcp__jarvis-desktop__move_to_output', 'Убираю файл в папку'],
  ['mcp__jarvis-desktop__show_file', 'Показываю файл'],
  ['mcp__jarvis-desktop__output_folder', 'Смотрю папку'],
  ['mcp__jarvis-desktop__list_files', 'Смотрю файлы'],
  ['mcp__jarvis-desktop__write_skill', 'Записываю навык'],
  ['WebSearch', 'Ищу в интернете'],
  ['WebFetch', 'Читаю страницу из интернета'],
  ['Bash', 'Выполняю команду'],
  ['Write', 'Пишу файл'],
  ['Edit', 'Правлю файл'],
  ['MultiEdit', 'Правлю файл'],
  ['Read', 'Читаю файл'],
  ['Glob', 'Ищу файлы'],
  ['Grep', 'Ищу по тексту'],
];

/** Когда сказать по делу нечего — чтобы тишина не читалась как поломка. */
const NEUTRAL = ['Ещё работаю.', 'Продолжаю.', 'Пока занят этим.'];

/** Что сказать про этот шаг, или ничего. */
export function describeStep(event: BackendEvent): string | null {
  if (event.type === 'command') return 'Выполняю команду';
  if (event.type !== 'tool') return null;

  for (const [prefix, phrase] of STEPS) {
    if (event.name.startsWith(prefix)) return phrase;
  }
  return null;
}

export interface ProgressOptions {
  quietMs?: number;
  gapMs?: number;
  now?: () => number;
}

export class ProgressVoice {
  private readonly quietMs: number;
  private readonly gapMs: number;
  private readonly now: () => number;

  private startedAt: number;
  private lastSpokeAt = 0;
  private lastLine: string | null = null;
  private step: string | null = null;
  private neutralIndex = 0;

  constructor(options: ProgressOptions = {}) {
    this.quietMs = options.quietMs ?? QUIET_MS;
    this.gapMs = options.gapMs ?? GAP_MS;
    this.now = options.now ?? Date.now;
    this.startedAt = this.now();
  }

  /** Запоминает шаг. Говорить о нём будем не сразу и не о каждом. */
  saw(event: BackendEvent): void {
    const described = describeStep(event);
    if (described) this.step = described;
  }

  /** Что произнести прямо сейчас, или ничего. */
  due(): string | null {
    const now = this.now();
    const since = this.lastSpokeAt === 0 ? now - this.startedAt : now - this.lastSpokeAt;
    const wait = this.lastSpokeAt === 0 ? this.quietMs : this.gapMs;
    if (since < wait) return null;

    const line = this.pick();
    this.lastSpokeAt = now;
    this.lastLine = line;
    return line;
  }

  /** Новая задача — новый отсчёт. */
  reset(): void {
    this.startedAt = this.now();
    this.lastSpokeAt = 0;
    this.lastLine = null;
    this.step = null;
  }

  private pick(): string {
    const fromStep = this.step ? `${this.step}.` : null;

    // Дважды подряд одно и то же звучит как заевшая пластинка — тогда лучше
    // нейтральное «ещё работаю», оно хотя бы меняется.
    if (fromStep && fromStep !== this.lastLine) return fromStep;

    const neutral = NEUTRAL[this.neutralIndex % NEUTRAL.length] as string;
    this.neutralIndex += 1;
    return neutral;
  }
}
