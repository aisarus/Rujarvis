/**
 * OpenAI-compatible backend.
 *
 * One adapter covers every endpoint that speaks `/v1/chat/completions`:
 * a hosted OpenAI-compatible provider, Ollama, LM Studio, llama.cpp's server.
 * It is the last rung of the fallback ladder — when no subscription backend is
 * available, Jarvis still answers — and it is the client the optional local
 * router model uses.
 *
 * It has no tools: it reasons and writes, it does not act on the computer.
 */

import type { JarvisCapability } from '../types';
import { buildBackendPrompt } from './prompt';
import { createManagedRun } from './managedRun';
import { looksUsageLimited } from './process';
import type {
  AgentBackend,
  BackendAvailability,
  BackendId,
  BackendRequest,
  BackendRun,
} from './types';

const CAPABILITIES: ReadonlySet<JarvisCapability> = new Set<JarvisCapability>([
  'reasoning',
  'creative',
]);

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

/** Minimal transport so tests do not need a live endpoint. */
export interface ChatCompletionClient {
  complete(request: ChatCompletionRequest): Promise<string>;
  /** Cheap reachability probe. */
  ping(): Promise<{ ok: boolean; reason?: string }>;
}

export interface OpenAiCompatibleBackendOptions {
  /** 'local' for an on-device server, 'openai-compatible' for anything else. */
  id?: Extract<BackendId, 'openai-compatible' | 'local'>;
  name?: string;
  model: string;
  client: ChatCompletionClient;
  availabilityTtlMs?: number;
  now?: () => number;
}

export class OpenAiCompatibleBackend implements AgentBackend {
  readonly id: BackendId;
  readonly name: string;
  readonly capabilities = CAPABILITIES;

  private cached: BackendAvailability | null = null;
  private readonly now: () => number;

  constructor(private readonly options: OpenAiCompatibleBackendOptions) {
    this.id = options.id ?? 'openai-compatible';
    this.name = options.name ?? (this.id === 'local' ? 'Локальная модель' : 'OpenAI-совместимый');
    this.now = options.now ?? Date.now;
  }

  async checkAvailability(force = false): Promise<BackendAvailability> {
    const ttl = this.options.availabilityTtlMs ?? 15_000;
    if (!force && this.cached && this.now() - this.cached.checkedAt < ttl) {
      return this.cached;
    }
    let availability: BackendAvailability;
    try {
      const ping = await this.options.client.ping();
      availability = {
        id: this.id,
        installed: ping.ok,
        authenticated: ping.ok,
        ready: ping.ok,
        reason: ping.ok ? undefined : (ping.reason ?? 'Эндпоинт недоступен'),
        checkedAt: this.now(),
      };
    } catch (error) {
      availability = {
        id: this.id,
        installed: false,
        authenticated: false,
        ready: false,
        reason: error instanceof Error ? error.message : String(error),
        checkedAt: this.now(),
      };
    }
    this.cached = availability;
    return availability;
  }

  invalidate(): void {
    this.cached = null;
  }

  run(request: BackendRequest): BackendRun {
    return createManagedRun({
      backend: this.id,
      now: this.now,
      availability: () => this.checkAvailability(),
      execute: async ({ emit, onCancel }) => {
        const controller = new AbortController();
        onCancel(() => controller.abort());

        try {
          const text = await this.options.client.complete({
            model: this.options.model,
            messages: [
              {
                role: 'system',
                content:
                  'Ты — ассистент Джарвис. Отвечай по-русски, коротко и по делу. У тебя нет доступа к компьютеру: если задача требует действий, скажи об этом прямо.',
              },
              { role: 'user', content: buildBackendPrompt(request) },
            ],
            signal: controller.signal,
          });
          if (text.trim()) {
            emit({ type: 'assistant-text', backend: this.id, text });
          }
          return { ok: true, text };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          emit({ type: 'error', backend: this.id, message, retryable: true });
          return {
            ok: false,
            text: '',
            error: message,
            usageLimited: looksUsageLimited(message),
          };
        }
      },
    });
  }
}

export interface HttpChatClientOptions {
  baseUrl: string;
  apiKey?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/** `fetch`-based client for any `/v1/chat/completions` endpoint. */
export function createHttpChatClient(options: HttpChatClientOptions): ChatCompletionClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const base = options.baseUrl.replace(/\/+$/, '');
  const headers = (): Record<string, string> => {
    const result: Record<string, string> = { 'content-type': 'application/json' };
    if (options.apiKey) result.authorization = `Bearer ${options.apiKey}`;
    return result;
  };

  return {
    async ping() {
      try {
        const response = await fetchImpl(`${base}/models`, {
          method: 'GET',
          headers: headers(),
          signal: AbortSignal.timeout(options.timeoutMs ?? 3_000),
        });
        return response.ok
          ? { ok: true }
          : { ok: false, reason: `HTTP ${response.status}` };
      } catch (error) {
        return { ok: false, reason: error instanceof Error ? error.message : String(error) };
      }
    },

    async complete(request) {
      const response = await fetchImpl(`${base}/chat/completions`, {
        method: 'POST',
        headers: headers(),
        signal: request.signal,
        body: JSON.stringify({
          model: request.model,
          messages: request.messages,
          temperature: request.temperature ?? 0,
          max_tokens: request.maxTokens,
          stream: false,
        }),
      });

      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new Error(`HTTP ${response.status}: ${detail.slice(0, 500)}`);
      }

      const payload = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      return payload.choices?.[0]?.message?.content ?? '';
    },
  };
}
