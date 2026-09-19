/**
 * Fast acknowledgements.
 *
 * The main UX number for a voice assistant is how long it stays silent. A
 * reply that starts in a second and takes five minutes feels responsive; a
 * reply that says nothing for twenty seconds feels broken, even when it is
 * faster overall.
 *
 * So Jarvis answers immediately from the routing decision — before any model
 * has produced a token — and the acknowledgement is deliberately honest about
 * what it means: «Понял, запускаю» is a receipt, not a completion.
 */

import type { JarvisIntent, RoutingDecision } from '../router/router';

/**
 * Acknowledgements per intent.
 *
 * Several per intent, because hearing the identical phrase every single time
 * is the fastest way to make an assistant feel like a phone menu.
 */
const ACKNOWLEDGEMENTS: Record<JarvisIntent, string[]> = {
  open_app: ['Открываю.', 'Сейчас открою.', 'Секунду, открываю.'],
  // «Открываю» в ответ на «создай сферу» обещает не то, что произойдёт.
  make: ['Делаю.', 'Сейчас сделаю.', 'Принялся.'],
  control_window: ['Сейчас.', 'Готово, делаю.', 'Ага, делаю.'],
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

/** Named a coding backend out loud — say which one is picking it up. */
const BACKEND_ACKNOWLEDGEMENTS: Record<string, string> = {
  'claude-code': 'Передаю Клод Коду.',
  codex: 'Передаю Кодексу.',
};

export interface AcknowledgementOptions {
  /** Injected so the phrasing is deterministic in tests. */
  pick?: (options: readonly string[]) => string;
  /** Mention the project when one was resolved. */
  mentionProject?: boolean;
}

function defaultPick(options: readonly string[]): string {
  return options[Math.floor(Math.random() * options.length)] ?? options[0] ?? 'Понял.';
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

  if (decision.requestedBackend && BACKEND_ACKNOWLEDGEMENTS[decision.requestedBackend]) {
    return BACKEND_ACKNOWLEDGEMENTS[decision.requestedBackend] as string;
  }

  const base = pick(ACKNOWLEDGEMENTS[decision.intent] ?? ACKNOWLEDGEMENTS.chat);

  if (options.mentionProject !== false && decision.project && isProjectIntent(decision.intent)) {
    return `${base.replace(/[.!]$/, '')} — проект ${decision.project}.`;
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
  if (decision.confidence >= 0.4) return null;
  if (decision.intent === 'continue') return null;
  return 'Не понял, что именно сделать. Уточни?';
}
