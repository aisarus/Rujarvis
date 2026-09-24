/**
 * Разговор, идущий вторым потоком рядом с работой.
 *
 * ## Почему живая сессия
 *
 * Разговор обязан помнить нить: «а почему?» без предыдущей реплики — это
 * уверенный ответ ни о чём. Живая сессия CLI помнит её сама и кеширует, и это
 * даром: замер 20.09.2026 дал 28,5 с на первый ход, 5,4 на второй и 3,2 на
 * третий. Своя катушка реплик означала бы слать нить заново каждый ход.
 *
 * ## Почему у разговора нет рук
 *
 * Не из вежливости и не по обещанию в запросе: у него физически нет
 * инструментов, кроме пяти глаголов. Папка — дом Джарвиса, а не проект
 * человека. Режим разрешений — `default`, который в безголовом запуске молча
 * отказывает всему, чего нет в списке разрешённого.
 *
 * Значит «останови», «заведи работу», «поправь» проходят ровно через те же
 * ворота, что и голосовая задача, — со всеми красными линиями человека.
 *
 * ## Почему нет потолка на ход
 *
 * `turnCeilingMs` убивает сессию целиком. Потерять нить разговора из-за одного
 * медленного ответа — дороже, чем подождать. Границей служит молчание.
 */

import { createStreamState } from '../backends/cliRunner';
import { consumeClaudeStreamLine } from '../backends/claudeCode';
import { LiveSession, type SessionKey } from '../backends/liveSession';
import { agentEnv } from '../backends/subscriptionEnv';
import type { BackendResult } from '../backends/types';
import { stripUnspeakable, toSpokenResponse } from '../voice/spokenResponse';
import { buildTalkOpening, buildTalkTurn } from './talkPrompt';
import { WorkDelta, type WorkDeltaOptions } from './workDelta';

/** Имя сервера разговора в конфиге MCP. */
export const TALK_SERVER = 'jarvis-talk';

/**
 * Глаголы разговора.
 *
 * Латиницей — и это не вкусовщина: имена инструментов MCP обязаны попадать в
 * `^[a-zA-Z0-9_.-]{1,64}$`, кириллические отклоняются целиком. Русский живёт в
 * описаниях, которые читает модель.
 */
export const TALK_TOOLS = [
  'start_work',
  'add_note',
  'stop_work',
  'pause_work',
  'resume_work',
  'add_step',
  'work_now',
] as const;

/** Как эти же глаголы называются в `--allowedTools`. */
export const talkToolNames = (): string[] =>
  TALK_TOOLS.map((name) => `mcp__${TALK_SERVER}__${name}`);

/** Столько молчания хватает, чтобы признать ход зависшим. */
const SILENCE_MS = 90_000;

/** То немногое, что разговору нужно от живой сессии. */
export interface TalkLive {
  isAlive(): boolean;
  hasSpoken(): boolean;
  ask(prompt: string): { result(): Promise<BackendResult> };
  dispose(why?: string): void;
  /** Поднять процесс заранее, не тратя хода. */
  warm?(): void;
}

export interface TalkState {
  /** План работы строками, как его видит человек. */
  work: readonly string[];
  /** Последние действия Джарвиса. */
  recent: readonly string[];
  /** Характер: постоянные указания человека. */
  instructions: string;
}

export interface TalkSessionOptions {
  /** Где лежит CLI. `null` — разговора не будет, и об этом надо сказать. */
  cliPath: () => Promise<string | null>;
  /** Папка разговора. Дом Джарвиса, а не проект человека. */
  cwd: string;
  /** Конфиг MCP с ролью разговора. Без него рычагов нет. */
  mcpConfig?: string;
  model?: string;
  env?: NodeJS.ProcessEnv;
  /** Где журнал и план: по ним считается «что случилось с прошлого раза». */
  delta: WorkDeltaOptions;
  state: () => TalkState;
  speak: (text: string) => Promise<void> | void;
  log?: (line: string) => void;
  /** Подмена живой сессии в тестах. */
  createSession?: (key: SessionKey, command: string) => TalkLive;
}

export class TalkSession {
  private live: TalkLive | null = null;
  private delta: WorkDelta | null = null;
  /**
   * Подъём, который уже идёт.
   *
   * Пока сессия поднимается, второй фразе ждать, а не заводить вторую. Подъём
   * асинхронный: между «живой нет» и «вот живая» проходят доли секунды, и
   * человек успевает сказать ещё одну фразу. Два процесса CLI вместо одного —
   * это не только лишняя память: первый остался бы без ссылки, то есть закрыть
   * его было бы некому.
   */
  private поднимается: Promise<TalkLive | null> | null = null;
  /** Была ли сессия и умерла ли сама. Нарочное «забудь» сюда не считается. */
  private lostThread = false;
  /**
   * Фраза, над которой разговор думает прямо сейчас.
   *
   * Человек повторяет себя, когда не слышит ответа, — и это одна просьба, а не
   * три. Живая сессия обрабатывает ходы по очереди, поэтому повтор не ускоряет
   * ответ, а встаёт за ним в очередь и удлиняет ожидание втрое.
   *
   * Поймано 24.09.2026: «Сделай сферу зелёной» сказано трижды за тридцать
   * секунд, ответ пришёл через полторы минуты, и со стороны это выглядело как
   * «игнорирует».
   */
  private думаетНад: string | null = null;
  private complained = false;

  constructor(private readonly options: TalkSessionOptions) {}

  isAlive(): boolean {
    return this.live?.isAlive() ?? false;
  }

  /**
   * Поднять сессию заранее, ничего не спрашивая.
   *
   * Первая фраза за вечер стоила 12,7 секунды против 5,8 у третьей. Большая
   * часть этой разницы — не размышление, а подъём: процесс CLI, его MCP-сервер
   * и рукопожатие с ним. Это можно оплатить в момент запуска Джарвиса, когда
   * никто не ждёт.
   *
   * Ход при этом НЕ тратится: молчащий процесс стоит памяти, но не подписки, а
   * лишний ход стоил бы и того, и другого — причём каждый запуск, даже когда
   * человек за вечер не сказал ни слова.
   */
  async warm(): Promise<void> {
    const live = await this.ensure();
    live?.warm?.();
  }

  /**
   * Услышать фразу и ответить.
   *
   * Ждать здесь незачем: вызывающий отпускает обещание, а голос приходит,
   * когда придёт. Пустой ответ — законный: разговор имеет право промолчать.
   */
  async hear(said: string): Promise<void> {
    const фраза = said.trim();
    if (!фраза) return;

    // Повтор той же фразы, пока идёт ход по ней, — это не вторая просьба.
    if (this.думаетНад !== null && this.думаетНад === фраза) {
      this.log(`повтор, уже думаю: ${фраза}`);
      return;
    }

    const live = await this.ensure();
    if (!live) return;

    const prompt = live.hasSpoken()
      ? buildTalkTurn(фраза, this.delta?.since() ?? [])
      : buildTalkOpening({ ...this.options.state(), said: фраза });

    let result: BackendResult;
    this.думаетНад = фраза;
    try {
      result = await live.ask(prompt).result();
    } catch (error) {
      this.log(`ход не удался: ${message(error)}`);
      return;
    } finally {
      this.думаетНад = null;
    }

    if (!result.ok) {
      // Отменённый ход — это «стоп» или «забудь», то есть исполненная просьба
      // человека. Извиняться за неё было бы странно.
      if (!/отмен/iu.test(result.error ?? '')) {
        this.log(`не ответил: ${result.error ?? 'без причины'}`);
        await this.say('Не смог ответить.');
      }
      return;
    }

    const speakable = stripUnspeakable(result.text ?? '').trim();
    if (!speakable) {
      this.log('промолчал');
      return;
    }
    await this.say(toSpokenResponse(result.text, { fallback: speakable }).spoken);
  }

  /**
   * Забыть нить и начать заново.
   *
   * Нарочное забвение молчит: человек сам об этом попросил. Потеря нити от
   * падения сессии — наоборот, говорит, потому что иначе разговор молча
   * притворится помнящим.
   */
  forget(why = 'Человек попросил забыть'): void {
    this.live?.dispose(why);
    this.live = null;
    this.delta = null;
    this.lostThread = false;
  }

  dispose(why = 'Джарвис закрывается'): void {
    this.forget(why);
  }

  private async ensure(): Promise<TalkLive | null> {
    if (this.live?.isAlive()) return this.live;
    if (this.поднимается) return this.поднимается;

    this.поднимается = this.raise().finally(() => {
      this.поднимается = null;
    });
    return this.поднимается;
  }

  private async raise(): Promise<TalkLive | null> {
    // Сессия была и умерла сама. Молча поднять новую значит сделать вид, что
    // нить цела, — и следующее «а почему?» уйдёт в пустоту без объяснений.
    if (this.live) {
      this.live = null;
      this.lostThread = true;
    }

    const command = await this.options.cliPath();
    if (!command) {
      if (!this.complained) {
        this.complained = true;
        await this.say('Разговор недоступен: не нашёл Claude Code.');
      }
      return null;
    }
    this.complained = false;

    const key: SessionKey = {
      cwd: this.options.cwd,
      tools: talkToolNames().join(','),
      // `default` в безголовом запуске не спрашивает — он молча отказывает
      // всему, чего нет в списке. Для разговора это и нужно: пять глаголов и
      // ничего больше.
      permissionMode: 'default',
      mcpConfig: this.options.mcpConfig,
      model: this.options.model,
    };

    const live = this.options.createSession
      ? this.options.createSession(key, command)
      : new LiveSession({
          key,
          command,
          consumeLine: (raw, emit) => consumeClaudeStreamLine(raw, createStreamState(), emit),
          // Подписка, а не ключ: это условие человека, и оно задаётся здесь.
          env: this.options.env ?? agentEnv(),
          turnTimeoutMs: SILENCE_MS,
          // Потолка нет нарочно: он убивает сессию, то есть теряет нить.
        });

    this.live = live;
    this.delta = new WorkDelta(this.options.delta);
    this.log('поднял сессию разговора');

    if (this.lostThread) {
      this.lostThread = false;
      await this.say('Нить разговора потерял, начинаю заново.');
    }
    return live;
  }

  private async say(text: string): Promise<void> {
    try {
      await this.options.speak(text);
    } catch (error) {
      this.log(`не смог сказать: ${message(error)}`);
    }
  }

  private log(line: string): void {
    this.options.log?.(`[разговор] ${line}`);
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
