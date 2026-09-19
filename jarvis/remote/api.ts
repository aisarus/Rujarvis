/**
 * Что телефон может попросить у Джарвиса.
 *
 * Разбор запроса отделён от сервера нарочно: правила доступа — единственное
 * место, где ошибка стоит компьютера целиком, и их надо проверять тестами, а
 * не запускать и смотреть. Здесь нет ни сокетов, ни Electron — только правила.
 *
 * Список путей короткий и таким останется. Каждый новый путь — это ещё одна
 * дверь; открывать их стоит поштучно и с поводом.
 */

import { isPaired, type Pairing } from './pairing';

/** Длиннее человек голосом не скажет, а присылать книги сюда незачем. */
export const MAX_COMMAND_LENGTH = 500;

export interface RemoteRequest {
  method: string;
  path: string;
  token?: string;
  body?: unknown;
}

export interface RemoteResponse {
  status: number;
  body: unknown;
}

export interface RemoteStatus {
  listening: boolean;
  busy: boolean;
  says: string;
}

export interface RemoteHandlers {
  status(): RemoteStatus | Promise<RemoteStatus>;
  say(text: string): void | Promise<void>;
  files(): string | Promise<string>;
}

export interface RemoteContext {
  pairing: Pairing | null;
  handlers: RemoteHandlers;
}

export async function handleRemoteRequest(
  request: RemoteRequest,
  context: RemoteContext,
): Promise<RemoteResponse> {
  const path = normalisePath(request.path);

  // Единственный путь без ключа: по нему телефон убеждается, что нашёл
  // компьютер. Ничего о человеке он не сообщает.
  if (path === '/health') {
    return { status: 200, body: { ok: true, service: 'jarvis' } };
  }

  if (!isPaired(context.pairing, request.token)) {
    return { status: 401, body: { error: 'Нет доступа' } };
  }

  try {
    switch (path) {
      case '/status': {
        if (request.method !== 'GET') return methodNotAllowed('GET');
        return { status: 200, body: await context.handlers.status() };
      }
      case '/files': {
        if (request.method !== 'GET') return methodNotAllowed('GET');
        return { status: 200, body: { listing: await context.handlers.files() } };
      }
      case '/say': {
        // Только POST: команду, доступную по GET, можно подсунуть обычной
        // ссылкой — и человек выполнит её, просто открыв её на телефоне.
        if (request.method !== 'POST') return methodNotAllowed('POST');

        const text = readCommand(request.body);
        if (!text) {
          return { status: 400, body: { error: 'Пустая или слишком длинная команда' } };
        }
        await context.handlers.say(text);
        return { status: 200, body: { accepted: text } };
      }
      default:
        return { status: 404, body: { error: 'Такого нет' } };
    }
  } catch {
    // Наружу уходит факт поломки и ничего больше: текст исключения умеет
    // рассказывать о путях, ключах и внутреннем устройстве.
    return { status: 500, body: { error: 'Внутренняя ошибка' } };
  }
}

function methodNotAllowed(expected: string): RemoteResponse {
  return { status: 405, body: { error: `Здесь ожидается ${expected}` } };
}

function normalisePath(path: string): string {
  const withoutQuery = path.split('?')[0] ?? path;
  const trimmed = withoutQuery.replace(/\/+$/u, '');
  return trimmed === '' ? '/' : trimmed;
}

function readCommand(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const value = (body as { text?: unknown }).text;
  if (typeof value !== 'string') return null;

  const text = value.trim();
  if (text.length === 0 || text.length > MAX_COMMAND_LENGTH) return null;
  return text;
}
