/**
 * Optional local router model.
 *
 * A small model on a 4 GB card is a cheap way to catch what stem rules miss:
 * an app nobody added to the lexicon, a project referred to obliquely, a
 * request phrased as a story. It is a *router*, not the intelligence of the
 * system — Jarvis works fully without it, and this module is written so that
 * every failure mode (no server, slow server, malformed JSON, a model that
 * decides to answer the question instead of routing it) degrades to the
 * rule-based decision.
 *
 * Its output can add capabilities and tighten permissions. It cannot grant a
 * permission, pick a backend or lower a risk class.
 */

import type { ChatCompletionClient } from '../backends/openAiCompatible';
import { JARVIS_CAPABILITIES, type JarvisCapability } from '../types';
import type { ModelNormalization } from './normalize';
import type { RoutingDecision } from './router';

export const ROUTER_SYSTEM_PROMPT = [
  'Ты — маршрутизатор голосового ассистента. Ты НЕ решаешь задачу пользователя.',
  'Верни ТОЛЬКО JSON без пояснений:',
  '{"needs":["..."],"goal":"...","constraints":["..."],"project":"...","read_only":true|false}',
  '',
  'needs — из списка: ' + JARVIS_CAPABILITIES.join(', ') + '.',
  'goal — одно предложение: что нужно сделать. Не выдумывай новых целей.',
  'constraints — только те ограничения, которые пользователь назвал сам.',
  'project — название проекта, если оно прозвучало, иначе пустая строка.',
  'read_only — true, если пользователь просил ничего не менять.',
].join('\n');

export interface LocalRouterOptions {
  client: ChatCompletionClient;
  model: string;
  /** A router that is slower than this is worse than no router. */
  timeoutMs?: number;
}

export interface LocalRouterOutput {
  capabilities: JarvisCapability[];
  normalization: ModelNormalization;
}

const CAPABILITY_SET = new Set<string>(JARVIS_CAPABILITIES);

/** Pulls the first JSON object out of a reply that may be wrapped in prose. */
export function extractJsonObject(text: string): Record<string, unknown> | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1] ?? text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    const parsed: unknown = JSON.parse(candidate.slice(start, end + 1));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Validates the model's reply, dropping anything unrecognised. */
export function parseRouterOutput(text: string): LocalRouterOutput | null {
  const parsed = extractJsonObject(text);
  if (!parsed) return null;

  const rawNeeds = Array.isArray(parsed.needs) ? parsed.needs : [];
  const capabilities = rawNeeds
    .filter((value): value is string => typeof value === 'string')
    .map((value) => value.trim().toLowerCase())
    .filter((value) => CAPABILITY_SET.has(value)) as JarvisCapability[];

  const rawConstraints = Array.isArray(parsed.constraints) ? parsed.constraints : [];
  const constraints = rawConstraints.filter((value): value is string => typeof value === 'string');

  const goal = typeof parsed.goal === 'string' ? parsed.goal.trim() : '';
  const project = typeof parsed.project === 'string' ? parsed.project.trim() : '';

  // `read_only` may only take the edit permission away; there is no field the
  // model could use to hand one back.
  const readOnly = parsed.read_only === true;

  return {
    capabilities,
    normalization: {
      goal: goal || undefined,
      constraints,
      project: project || undefined,
      permissions: readOnly ? { edit: false } : undefined,
    },
  };
}

export class LocalRouterModel {
  constructor(private readonly options: LocalRouterOptions) {}

  /**
   * Asks the local model to refine a decision.
   *
   * Returns null on any problem at all — that is the whole contract, and it is
   * why the caller can treat this as a pure optimisation.
   */
  async refine(utterance: string): Promise<LocalRouterOutput | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 2_000);
    try {
      const text = await this.options.client.complete({
        model: this.options.model,
        messages: [
          { role: 'system', content: ROUTER_SYSTEM_PROMPT },
          { role: 'user', content: utterance },
        ],
        temperature: 0,
        maxTokens: 300,
        signal: controller.signal,
      });
      return parseRouterOutput(text);
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Merges the model's capabilities into a rule-based decision.
 *
 * Capabilities are additive — a missed one costs the user a wrong backend, so
 * the model is allowed to add. Risk, target and permissions are not touched
 * here: those come back through `applyModelNormalization`, which intersects.
 */
export function mergeRouterCapabilities(
  decision: RoutingDecision,
  output: LocalRouterOutput | null,
): RoutingDecision {
  if (!output || output.capabilities.length === 0) return decision;
  const needs = new Set<JarvisCapability>([...decision.needs, ...output.capabilities]);
  return {
    ...decision,
    needs: [...needs],
    confidence: Math.min(1, decision.confidence + 0.1),
  };
}
