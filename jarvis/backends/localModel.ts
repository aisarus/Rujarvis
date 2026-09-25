/**
 * Своя модель вместо подписки: Claude Code, направленный на сервер человека.
 *
 * ## Зачем так, а не отдельным агентом
 *
 * Ollama (с 0.14), LM Studio и llama.cpp (`llama-server --jinja`) отвечают на
 * `/v1/messages` так же, как Anthropic. Значит, достаточно дать Claude Code
 * другой адрес — и всё остальное остаётся тем же самым: хук красных линий,
 * инструменты рабочего стола, разговор, план. Отдельный агентский цикл для
 * локальной модели означал бы второй путь в обход хука.
 *
 * ## Почему только свой сервер
 *
 * Джарвис не хранит ключей и не ходит в платные API. Адрес принимается, только
 * если он на этом компьютере или в домашней сети: облачный шлюз с чужим
 * ключом сюда не вписать. Токен — заглушка: локальные серверы его не проверяют,
 * а Claude Code без него не стартует.
 *
 * Модель Джарвис не ставит и не качает: это для мощных компьютеров, и человек,
 * у которого такая модель есть, уже поднял её сам.
 */

import { tr } from '../locale/language';

export interface LocalModel {
  /** Корень сервера, без `/v1`: `http://127.0.0.1:11434`. */
  url: string;
  /** Имя модели на этом сервере: `qwen3-coder:30b`. */
  model: string;
}

let active: LocalModel | null = null;

/** Задаётся мостом при запуске из настроек; смена настроек перезапускает мост. */
export function setLocalModel(model: LocalModel | null): void {
  active = model;
}

export function localModel(): LocalModel | null {
  return active;
}

/**
 * Адрес на этом компьютере или в локальной сети.
 *
 * Имя вида `gpu-box.local` / `.lan` / без точки считается своим: так
 * называются машины в домашней сети. Всё с публичным доменом — нет.
 */
export function isPrivateEndpoint(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  if (url.username || url.password) return false;

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/gu, '');
  if (host === 'localhost' || host === '::1') return true;
  if (/\.(local|lan|home\.arpa|internal)$/u.test(host)) return true;
  if (!host.includes('.') && !host.includes(':')) return true;

  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u);
  if (ipv4) {
    const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
    return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254);
  }
  // IPv6: только уникальные локальные (fc00::/7) и link-local (fe80::/10).
  return /^f[cd][0-9a-f]{2}:/u.test(host) || /^fe[89ab][0-9a-f]:/u.test(host);
}

/** Привести ввод человека к корню сервера: без хвостового `/` и `/v1`. */
export function normaliseEndpoint(raw: string): string {
  return raw.trim().replace(/\/+$/u, '').replace(/\/v1$/u, '');
}

/**
 * Переменные, которые уводят Claude Code на свой сервер.
 *
 * Все «роли» моделей указывают на одну: Claude Code сам зовёт лёгкую модель
 * для служебных задач, и на своём сервере её под именем haiku нет.
 * Несущественный трафик выключен: без него Claude Code стучится к Anthropic за
 * телеметрией и обновлениями, а человек выбрал свою модель не за этим.
 */
export function localModelEnv(model: LocalModel): Record<string, string> {
  return {
    ANTHROPIC_BASE_URL: model.url,
    ANTHROPIC_AUTH_TOKEN: 'local',
    ANTHROPIC_MODEL: model.model,
    ANTHROPIC_DEFAULT_OPUS_MODEL: model.model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: model.model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: model.model,
    ANTHROPIC_SMALL_FAST_MODEL: model.model,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  };
}

export type LocalModelCheck =
  | { ok: true; tools: boolean; reply: string }
  | { ok: false; reason: string };

type Fetch = (input: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

/**
 * Проверка настоящим запросом, а не пингом.
 *
 * Два вопроса: отвечает ли модель вообще и умеет ли она вызывать инструменты.
 * Без второго Claude Code «забывает, как быть агентом» — у llama.cpp это
 * запуск без `--jinja`. Такой сервер годится для разговора, но не для работы,
 * и человек должен узнать это здесь, а не по молчащему агенту.
 */
export async function checkLocalModel(
  model: LocalModel,
  options: { fetch?: Fetch; timeoutMs?: number } = {},
): Promise<LocalModelCheck> {
  if (!isPrivateEndpoint(model.url)) {
    return { ok: false, reason: tr('Адрес не на этом компьютере и не в домашней сети.', 'The address is neither on this computer nor on your home network.') };
  }
  if (!model.model.trim()) return { ok: false, reason: tr('Не указано имя модели.', 'No model name given.') };

  const doFetch = options.fetch ?? (globalThis.fetch as unknown as Fetch);
  const ask = async (body: object): Promise<Record<string, unknown>> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 120_000);
    try {
      const response = await doFetch(`${model.url}/v1/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': 'local',
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({ model: model.model, max_tokens: 64, ...body }),
        signal: controller.signal,
      });
      const text = await response.text();
      if (!response.ok) throw new Error(tr(`сервер ответил ${response.status}`, `the server answered ${response.status}`) + `: ${text.slice(0, 200)}`);
      return JSON.parse(text) as Record<string, unknown>;
    } finally {
      clearTimeout(timer);
    }
  };

  let reply: string;
  try {
    const answer = await ask({ messages: [{ role: 'user', content: 'Reply with the single word: ready' }] });
    reply = textOf(answer);
  } catch (error) {
    return { ok: false, reason: tr(`Модель не ответила: ${describe(error)}`, `The model did not answer: ${describe(error)}`) };
  }

  try {
    const answer = await ask({
      messages: [{ role: 'user', content: 'Call the ping tool now.' }],
      tools: [{ name: 'ping', description: 'Checks that tools work.', input_schema: { type: 'object', properties: {} } }],
      tool_choice: { type: 'any' },
    });
    const content = Array.isArray(answer.content) ? (answer.content as Array<{ type?: string }>) : [];
    return { ok: true, tools: content.some((block) => block.type === 'tool_use'), reply };
  } catch {
    // Сервер, отвергающий сам запрос с инструментами, работать агентом не сможет.
    return { ok: true, tools: false, reply };
  }
}

function textOf(answer: Record<string, unknown>): string {
  const content = Array.isArray(answer.content) ? (answer.content as Array<{ type?: string; text?: string }>) : [];
  return content
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join(' ')
    .trim()
    .slice(0, 200);
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    return error.name === 'AbortError' ? tr('нет ответа за отведённое время', 'no answer in time') : error.message;
  }
  return String(error);
}
