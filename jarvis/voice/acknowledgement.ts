/**
 * Короткий отклик, пока работа ещё не началась.
 *
 * Главное число для голосового помощника — сколько он молчит. Ответ, который
 * начался через секунду и занял пять минут, ощущается быстрым; ответ, который
 * двадцать секунд молчит, ощущается сломанным, даже если в сумме он быстрее.
 *
 * Поэтому Джарвис отвечает сразу по решению разбора — до того, как модель
 * выдала хоть одно слово.
 *
 * ## Почему отклик не говорит «готово»
 *
 * Это расписка в том, что услышал, а не отчёт о сделанном. «Понял, берусь» —
 * правда в момент, когда произносится. «Готово» в тот же момент — неправда:
 * работа ещё не начиналась, и проверить её результат было нечем. Главное
 * правило проекта запрещает отчитываться успехом, не проверив результата, и
 * оно относится и к словам, которые человек слышит.
 */

import type { JarvisIntent, RoutingDecision } from '../router/router';
import { byLanguage, tr } from '../locale/language';

/**
 * Acknowledgements per intent.
 *
 * Several per intent, because hearing the identical phrase every single time
 * is the fastest way to make an assistant feel like a phone menu.
 */
const ACKNOWLEDGEMENTS_RU: Record<JarvisIntent, string[]> = {
  open_app: ['Открываю.', 'Сейчас открою.', 'Секунду, открываю.'],
  // «Открываю» в ответ на «создай сферу» обещает не то, что произойдёт.
  make: ['Делаю.', 'Сейчас сделаю.', 'Принялся.'],
  // Не «Готово»: отклик звучит ДО работы, и обещать сделанное в этот момент
  // нечем.
  control_window: ['Сейчас.', 'Переключаю.', 'Ага, делаю.'],
  modify_project: ['Понял, берусь.', 'Так, смотрю проект.', 'Ок, займусь этим.'],
  inspect_project: ['Сейчас посмотрю проект.', 'Да, смотрю.', 'Гляну.'],
  query_screen: ['Смотрю на экран.', 'Сейчас гляну.', 'Секунду, смотрю.'],
  browse: ['Открываю браузер.', 'Сейчас посмотрю.', 'Секунду.'],
  file_task: ['Ищу.', 'Сейчас найду.', 'Смотрю файлы.'],
  communicate: ['Подготовлю.', 'Сейчас соберу.', 'Понял.'],
  system: ['Сейчас проверю настройки.', 'Смотрю.', 'Секунду.'],
  continue: ['Продолжаю.', 'Ок, дальше.', 'Возвращаюсь к этому.'],
  chat: ['Да, слушаю.', 'Сейчас.', 'Понял.'],
};

const ACKNOWLEDGEMENTS_EN: Record<JarvisIntent, string[]> = {
  open_app: ['Opening.', 'Opening it now.', 'One second, opening.'],
  make: ['On it.', 'Making it now.', 'Starting.'],
  control_window: ['Sure.', 'Doing it.', 'Right away.'],
  modify_project: ['Got it, on it.', 'Looking at the project.', 'OK, working on it.'],
  inspect_project: ['Looking at the project.', 'Checking.', 'Let me look.'],
  query_screen: ['Looking at the screen.', 'Let me see.', 'One second, looking.'],
  browse: ['Opening the browser.', 'Let me look.', 'One second.'],
  file_task: ['Searching.', 'Let me find it.', 'Looking at the files.'],
  communicate: ['I will prepare it.', 'Putting it together.', 'Got it.'],
  system: ['Checking the settings.', 'Looking.', 'One second.'],
  continue: ['Resuming.', 'OK, continuing.', 'Back to it.'],
  chat: ['Yes, listening.', 'Sure.', 'Got it.'],
};

/** Named a coding backend out loud — say which one is picking it up. */
const BACKEND_ACKNOWLEDGEMENTS: Record<string, [string, string]> = {
  'claude-code': ['Передаю Клод Коду.', 'Handing it to Claude Code.'],
  codex: ['Передаю Кодексу.', 'Handing it to Codex.'],
};

export interface AcknowledgementOptions {
  /** Injected so the phrasing is deterministic in tests. */
  pick?: (options: readonly string[]) => string;
  /** Mention the project when one was resolved. */
  mentionProject?: boolean;
}

function defaultPick(options: readonly string[]): string {
  return options[Math.floor(Math.random() * options.length)] ?? options[0] ?? tr('Понял.', 'Got it.');
}

/**
 * The line to speak the instant a request is understood.
 *
 * It never claims the work is done, because it is produced before the work
 * starts.
 */
export function acknowledgementFor(
  decision: RoutingDecision,
  options: AcknowledgementOptions = {},
): string {
  const pick = options.pick ?? defaultPick;

  const handoff = decision.requestedBackend ? BACKEND_ACKNOWLEDGEMENTS[decision.requestedBackend] : undefined;
  if (handoff) return tr(handoff[0], handoff[1]);

  const table = byLanguage({ ru: ACKNOWLEDGEMENTS_RU, en: ACKNOWLEDGEMENTS_EN });
  const base = pick(table[decision.intent] ?? table.chat);

  if (options.mentionProject !== false && decision.project && isProjectIntent(decision.intent)) {
    return `${base.replace(/[.!]$/, '')} — ${tr('проект', 'project')} ${decision.project}.`;
  }
  return base;
}

function isProjectIntent(intent: JarvisIntent): boolean {
  return intent === 'modify_project' || intent === 'inspect_project';
}

/**
 * The line for a request whose meaning depends on context Jarvis does not have.
 *
 * Asking is better than guessing when the action cannot be undone.
 */
export function clarificationFor(decision: RoutingDecision): string | null {
  // Вопрос — не поручение, и уточнять в нём нечего.
  //
  // Разбор помечает вопрос отдельно, но уверенность такого разбора бывает
  // низкой, и человек, спросивший «а что у меня на экране», слышал в ответ
  // «Не понял, что именно сделать» — хотя ничего делать и не просил.
  if (decision.asks) return null;
  if (decision.confidence >= 0.4) return null;
  if (decision.intent === 'continue') return null;
  return tr('Не понял, что именно сделать. Уточни?', 'I am not sure what to do. Could you say it differently?');
}
