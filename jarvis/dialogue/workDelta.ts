/**
 * Что случилось в работе с прошлой реплики.
 *
 * ## Зачем
 *
 * Разговор идёт рядом с работой и обязан знать, что там происходит. Иначе на
 * «как там дела» он либо зовёт инструмент и тратит секунды, либо отвечает
 * уверенно и ни о чём.
 *
 * Прикладывать к каждой реплике всё состояние работы нельзя: журнал за вечер
 * не помещается ни в какой запрос и вытесняет собой сам разговор. Поэтому
 * прикладывается разница — то, чего разговор ещё не видел.
 *
 * ## Почему журнал читается заново
 *
 * В него пишут два процесса: голосовой мост и MCP-сервер агента. Долгоживущий
 * `JournalStore` держит события в памяти и переписывает файл целиком, поэтому
 * его копия показала бы половину правды — ровно ту половину, которую записал
 * он сам.
 *
 * ## Почему отсчёт начинается с рождения
 *
 * Первый ход разговора и так несёт полную картину работы: план, последние
 * действия, ошибки. Отдать в придачу всю историю значит сказать одно и то же
 * дважды, потратив на это половину запроса.
 */

import { readFileSync } from 'node:fs';

import type { Plan, StepState } from '../agent/plan';
import type { JarvisEvent } from '../memory/journal';

export interface WorkDeltaOptions {
  journalFile: string;
  planFile: string;
  /** Сколько строк помещается в один блок. */
  limit?: number;
}

/** Больше этого человек не слушает, а разговор не удерживает. */
const LIMIT = 15;

/**
 * Чем помечены записи журнала, которые сделал сам разговор.
 *
 * Реплика человека попадает и в журнал (это его память и запись для агента), и
 * в разговор. Без метки она вернулась бы в разговор второй раз, уже как
 * новость о работе, — и «ты же сам это только что слышал» стало бы обычным
 * делом.
 */
export const ЭХО_РАЗГОВОРА = 'разговор';

/**
 * Три ответа вместо двух: прочиталось, файла нет, прочитать не вышло.
 *
 * Раньше и то и другое давало `null`, опорная точка вставала в ноль, и если
 * файл чинился к следующему ходу, разговору вываливалась вся накопленная
 * история как новости. «Ничего не случилось» тоже было неотличимо от отказа
 * чтения.
 */
type Чтение = { есть: true; данные: unknown } | { есть: false; почему: 'нет файла' | 'не прочитался' };

function readJson(file: string): Чтение {
  try {
    return { есть: true, данные: JSON.parse(readFileSync(file, 'utf8')) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return { есть: false, почему: 'нет файла' };
    // Испорчен или занят. Это не данные — но и не повод падать посреди
    // разговора.
    return { есть: false, почему: 'не прочитался' };
  }
}

function readEvents(file: string): JarvisEvent[] {
  const чтение = readJson(file);
  const parsed = чтение.есть ? чтение.данные : null;
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(
    (item): item is JarvisEvent =>
      typeof item === 'object' &&
      item !== null &&
      typeof (item as JarvisEvent).at === 'number' &&
      typeof (item as JarvisEvent).text === 'string' &&
      typeof (item as JarvisEvent).kind === 'string',
  );
}

function readPlan(file: string): Plan | null {
  const чтение = readJson(file);
  const parsed = чтение.есть ? чтение.данные : null;
  if (!parsed || typeof parsed !== 'object') return null;
  const plan = parsed as Partial<Plan>;
  if (typeof plan.goal !== 'string' || !Array.isArray(plan.steps)) return null;
  return plan as Plan;
}

export class WorkDelta {
  private readonly limit: number;
  /** Время последнего показанного события. Строго больше — значит новое. */
  private seenUntil: number;
  private goal: string | null;
  private states: Map<string, StepState>;

  constructor(private readonly options: WorkDeltaOptions) {
    this.limit = options.limit ?? LIMIT;
    const events = readEvents(options.journalFile);
    this.seenUntil = events.reduce((max, event) => Math.max(max, event.at), 0);
    const plan = readPlan(options.planFile);
    this.goal = plan?.goal ?? null;
    this.states = statesOf(plan);
  }

  /**
   * Строки о том, что изменилось. Пустой список — ничего не случилось.
   *
   * План идёт первым: он — костяк, а события журнала объясняют его движение.
   */
  since(): string[] {
    const план = this.planLines();
    const журнал = this.journalLines();

    // Режем ЖУРНАЛ, а план оставляем целиком.
    //
    // Потолок брал хвост общего списка, и при смене цели с полутора десятками
    // событий строка «новый план» и движение шагов уходили в «…и ещё N
    // раньше», а оставались рядовые «открыл» и «сохранил». То есть терялось
    // ровно то, что названо костяком строкой выше.
    const место = Math.max(0, this.limit - план.length);
    if (журнал.length <= место) return [...план, ...журнал];

    // Остаются свежие: старое человек уже слышал или оно уже неважно.
    const hidden = журнал.length - место;
    return [...план, `…и ещё ${hidden} раньше`, ...журнал.slice(журнал.length - место)];
  }

  private journalLines(): string[] {
    const events = readEvents(this.options.journalFile).filter(
      // Собственное эхо разговору не новость: реплику человека он только что
      // слышал сам, и вернуть её как «что случилось» значит сбить его с толку.
      (event) => event.at > this.seenUntil && event.subject !== ЭХО_РАЗГОВОРА,
    );
    for (const event of events) this.seenUntil = Math.max(this.seenUntil, event.at);
    return events.map((event) =>
      // Сбой обязан называться сбоем: в одном ряду с «открыл» и «сохранил» он
      // читается как ещё одно сделанное дело.
      event.kind === 'error' ? `сбой: ${event.text}` : event.text,
    );
  }

  private planLines(): string[] {
    const plan = readPlan(this.options.planFile);
    if (!plan) return [];

    const lines: string[] = [];
    if (plan.goal !== this.goal) {
      lines.push(`новый план: ${plan.goal}`);
      this.goal = plan.goal;
      // Шаги нового плана — все новые, даже если текст совпал со старым.
      this.states = new Map();
    }

    for (const step of plan.steps) {
      if (this.states.get(step.text) === step.state) continue;
      this.states.set(step.text, step.state);
      lines.push(
        step.note
          ? `шаг «${step.text}» — ${step.state}: ${step.note}`
          : `шаг «${step.text}» — ${step.state}`,
      );
    }
    return lines;
  }
}

function statesOf(plan: Plan | null): Map<string, StepState> {
  const states = new Map<string, StepState>();
  for (const step of plan?.steps ?? []) states.set(step.text, step.state);
  return states;
}
