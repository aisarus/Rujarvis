/**
 * Остановить, отложить, продолжить — рычаги работы, которые дёргает разговор.
 *
 * Разговор идёт отдельным процессом и просит через мост (`talkBridge.ts`), а
 * менеджер задач живёт в приложении. Раньше решение лежало прямо в
 * `app/voiceBridge.ts`, куда тест не дотягивается, — и там жила ошибка:
 * отмена асинхронная, и вторая остановка подряд снова попадала в ту же
 * работу, докладывая «Остановил», пока соседняя шла дальше.
 */
import type { TaskManager } from '../tasks/manager';

export type WorkControl = 'stop' | 'pause' | 'resume';

export interface WorkControlAnswer {
  ok: boolean;
  /** Что сказать разговору. */
  text: string;
  /** Что сделано — для журнала; нет, если не сделано ничего. */
  done?: string;
}

type Tasks = Pick<TaskManager, 'foreground' | 'cancel' | 'stopping' | 'pause' | 'resumableTask' | 'resume'>;

export function applyWorkControl(kind: WorkControl, tasks: Tasks): WorkControlAnswer {
  if (kind === 'stop') {
    const работа = tasks.foreground();
    if (!работа) return { ok: false, text: 'Сейчас ничего не идёт.' };
    // Уже сказано остановиться — повторять «остановил» значит врать: процесс
    // ещё не вышел, а человек решит, что погашено что-то ещё.
    if (tasks.stopping(работа.id)) return { ok: false, text: `«${работа.title}» уже останавливается.` };
    if (!tasks.cancel(работа.id)) return { ok: false, text: `«${работа.title}» остановить не вышло.` };
    return { ok: true, text: `Остановил: ${работа.title}`, done: `остановил: ${работа.title}` };
  }

  if (kind === 'pause') {
    // Отложить — не то же, что погасить: сессия агента остаётся, и он
    // продолжит с того места, а не начнёт заново.
    const работа = tasks.foreground();
    if (!работа) return { ok: false, text: 'Сейчас ничего не идёт.' };
    if (!tasks.pause(работа.id)) return { ok: false, text: `«${работа.title}» отложить не вышло.` };
    return { ok: true, text: `Отложил: ${работа.title}`, done: `отложил: ${работа.title}` };
  }

  const отложенная = tasks.resumableTask();
  if (!отложенная) return { ok: false, text: 'Продолжать нечего.' };
  // Законченную работу продолжить нечем: она не отложена, а прожита.
  if (!tasks.resume(отложенная.id)) return { ok: false, text: `«${отложенная.title}» уже не продолжить.` };
  return { ok: true, text: `Продолжаю: ${отложенная.title}`, done: `продолжил: ${отложенная.title}` };
}
