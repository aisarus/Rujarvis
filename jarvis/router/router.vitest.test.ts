import { describe, expect, it } from 'vitest';
import {
  derivePermissions,
  detectBackendMentions,
  detectProject,
  route,
  toBackendPreference,
  type KnownProject,
} from './router';
import {
  applyModelNormalization,
  assertNormalizationIsSafe,
  normalizeRuleBased,
  stripLeadingFiller,
} from './normalize';
import {
  extractJsonObject,
  mergeRouterCapabilities,
  parseRouterOutput,
  LocalRouterModel,
} from './localModel';
import { hasPhrase, isNegatedBefore, normalizeForMatching, tokenize } from './text';
import { DEFAULT_PERMISSIONS, READ_ONLY_PERMISSIONS } from '../types';
import type { ChatCompletionClient } from '../backends/openAiCompatible';

const PROJECTS: KnownProject[] = [
  { name: 'aegis', path: 'D:\\Projects\\aegis', aliases: ['аегис', 'эгида'] },
  { name: 'rujarvis', path: 'D:\\Projects\\rujarvis', aliases: ['джарвис'] },
];

describe('text primitives', () => {
  it('folds ё and strips punctuation for matching only', () => {
    expect(normalizeForMatching('Ещё раз, пожалуйста!')).toBe('еще раз пожалуйста');
    expect(tokenize('Открой Chrome.')).toEqual(['открой', 'chrome']);
  });

  it('matches inflected forms through stems', () => {
    expect(hasPhrase(tokenize('в браузере открой вкладку'), ['браузер'])).toBe(true);
    expect(hasPhrase(tokenize('закрой это окно'), ['закро', 'это', 'окн'])).toBe(true);
  });

  it('only treats a negation as negating when it comes first', () => {
    const tokens = tokenize('не используй клод');
    expect(isNegatedBefore(tokens, tokens.indexOf('клод'))).toBe(true);
    const other = tokenize('клод не смог');
    expect(isNegatedBefore(other, other.indexOf('клод'))).toBe(false);
  });
});

describe('backend mentions', () => {
  it('hears a backend named in conversational Russian', () => {
    expect(detectBackendMentions('сделай это через Клод Код').requested).toBe('claude-code');
    expect(detectBackendMentions('отдай это Кодексу').requested).toBe('codex');
    expect(detectBackendMentions('теперь попробуй то же через Codex').requested).toBe('codex');
    expect(detectBackendMentions('пусть клод посмотрит').requested).toBe('claude-code');
  });

  it('hears an exclusion and does not read it as a request', () => {
    const decision = detectBackendMentions('не используй Клод');
    expect(decision.excluded).toContain('claude-code');
    expect(decision.requested).toBeUndefined();
  });

  it('leaves an unrelated sentence alone', () => {
    expect(detectBackendMentions('открой хром').requested).toBeUndefined();
  });
});

describe('project detection', () => {
  it('finds a project by its spoken Russian alias', () => {
    expect(detectProject('посмотри там в аегисе почему билд упал', PROJECTS)?.name).toBe('aegis');
    expect(detectProject('в проекте Aegis почини билд', PROJECTS)?.path).toBe('D:\\Projects\\aegis');
  });

  it('returns nothing when no known project is named', () => {
    expect(detectProject('открой спотифай', PROJECTS)).toBeUndefined();
  });
});

describe('permission derivation', () => {
  it('narrows to read-only when the user asks not to break anything', () => {
    const { permissions, constraints } = derivePermissions(
      'посмотри почему билд отъебнулся, только сначала не ломай ничего',
    );
    expect(permissions.edit).toBe(false);
    expect(permissions.read).toBe(true);
    expect(constraints).toContain('Сначала осмотреть, не менять');
  });

  it('can take execution away too', () => {
    expect(derivePermissions('глянь конфиг, ничего не запускай').permissions.execute).toBe(false);
  });

  it('can never widen the base envelope', () => {
    const narrow = derivePermissions('почини всё и запусти тесты', READ_ONLY_PERMISSIONS);
    expect(narrow.permissions).toEqual(READ_ONLY_PERMISSIONS);
  });
});

describe('route', () => {
  it('routes «Открой Chrome» to the computer runtime', () => {
    const decision = route('Открой Chrome');
    expect(decision.needs).toContain('computer');
    expect(decision.needs).toContain('browser');
    expect(decision.target).toBe('interpreter');
    expect(decision.intent).toBe('browse');
    expect(decision.risk).toBe('safe');
  });

  it('routes «Закрой это окно» to window control and flags the missing context', () => {
    const decision = route('Закрой это окно');
    expect(decision.needs).toContain('computer');
    expect(decision.intent).toBe('control_window');
    expect(decision.needsWorldState).toBe(true);
    expect(decision.target).toBe('interpreter');
  });

  it('routes «Посмотри что сейчас на экране» to vision', () => {
    const decision = route('Посмотри что сейчас на экране и объясни мне');
    expect(decision.needs).toContain('vision');
    expect(decision.intent).toBe('query_screen');
    expect(decision.target).toBe('interpreter');
  });

  it('routes a build failure in a known project to a coding backend', () => {
    const decision = route(
      'В проекте Aegis посмотри почему не проходит билд и почини через Claude Code',
      { context: { knownProjects: PROJECTS } },
    );
    expect(decision.needs).toEqual(expect.arrayContaining(['coding', 'reasoning']));
    expect(decision.project).toBe('aegis');
    expect(decision.projectPath).toBe('D:\\Projects\\aegis');
    expect(decision.requestedBackend).toBe('claude-code');
    expect(decision.target).toBe('claude-code');
  });

  it('keeps swearing as emphasis without changing the routing', () => {
    const plain = route('посмотри почему это не собирается');
    const sworn = route('посмотри почему эта хуйня не собирается');
    expect(sworn.needs).toEqual(expect.arrayContaining(plain.needs));
    expect(sworn.intent).toBe(plain.intent);
  });

  it('reads the inspect-only constraint out of a conversational sentence', () => {
    const decision = route(
      'Посмотри там в аегисе почему билд опять отъебнулся, только сначала не ломай ничего',
      { context: { knownProjects: PROJECTS } },
    );
    expect(decision.project).toBe('aegis');
    expect(decision.permissions.edit).toBe(false);
    expect(decision.permissions.read).toBe(true);
    expect(decision.constraints).toContain('Сначала осмотреть, не менять');
    expect(decision.risk).toBe('safe');
  });

  it('treats sending things to people as sensitive', () => {
    const decision = route('найди файл который я скачал утром и отправь его Максу');
    expect(decision.needs).toEqual(expect.arrayContaining(['files', 'communication']));
    expect(decision.risk).toBe('sensitive');
    expect(decision.needsWorldState).toBe(true);
  });

  it('treats disabling security as dangerous', () => {
    expect(route('отключи антивирус').risk).toBe('dangerous');
    expect(route('удали все файлы из папки загрузок').risk).toBe('dangerous');
  });

  it('recognises «продолжай» as a continuation that needs world state', () => {
    const decision = route('Продолжай');
    expect(decision.intent).toBe('continue');
    expect(decision.needsWorldState).toBe(true);
    expect(decision.confidence).toBeLessThan(0.6);
  });

  it('routes coding work named out loud even without coding words', () => {
    const decision = route('сделай это через Клод Код');
    expect(decision.needs).toContain('coding');
    expect(decision.target).toBe('claude-code');
  });

  it('honours the settings coding preference and an exclusion together', () => {
    const decision = route('почини билд', {
      context: { codingPreference: 'codex' },
    });
    expect(decision.target).toBe('codex');

    const excluded = route('почини билд, не используй клод');
    expect(excluded.excludedBackends).toContain('claude-code');
    expect(excluded.target).toBe('codex');
  });

  it('produces a backend preference the manager can consume', () => {
    const decision = route('отдай это кодексу');
    const preference = toBackendPreference(decision, { codingPreference: 'auto' });
    expect(preference.requested).toBe('codex');
    expect(preference.codingPreference).toBe('auto');
  });

  it('mixes Russian and English technical terms in one sentence', () => {
    const decision = route('запусти tests и посмотри почему падает build');
    expect(decision.needs).toEqual(expect.arrayContaining(['coding', 'shell']));
  });
});

describe('normalisation', () => {
  it('strips leading filler without touching the instruction', () => {
    expect(stripLeadingFiller('Слушай, короче, открой Chrome')).toBe('открой Chrome');
    expect(stripLeadingFiller('Джарвис, закрой это окно')).toBe('закрой это окно');
    expect(stripLeadingFiller('Открой Chrome')).toBe('Открой Chrome');
  });

  it('keeps an utterance that is nothing but filler', () => {
    expect(stripLeadingFiller('ну блин')).toBe('ну блин');
  });

  it('carries the verbatim utterance through the rule-based pass', () => {
    const utterance = 'глянь чё там с билдом, только не ломай ничего';
    const task = normalizeRuleBased(utterance, route(utterance));
    expect(task.utterance).toBe(utterance);
    expect(task.permissions.edit).toBe(false);
    expect(task.constraints).toContain('Сначала осмотреть, не менять');
  });

  it('lets a model tighten permissions', () => {
    const utterance = 'почини билд';
    const base = normalizeRuleBased(utterance, route(utterance));
    expect(base.permissions.edit).toBe(true);

    const merged = applyModelNormalization(base, { permissions: { edit: false } });
    expect(merged.permissions.edit).toBe(false);
    expect(() => assertNormalizationIsSafe(base, merged)).not.toThrow();
  });

  it('refuses to let a model widen permissions', () => {
    const utterance = 'посмотри почему билд падает, ничего не меняй';
    const base = normalizeRuleBased(utterance, route(utterance));
    expect(base.permissions.edit).toBe(false);

    const merged = applyModelNormalization(base, {
      goal: 'Fix the build',
      permissions: { edit: true, execute: true, read: true, network: true },
    });
    expect(merged.permissions.edit).toBe(false);
    expect(merged.permissions.network).toBe(false);
    expect(() => assertNormalizationIsSafe(base, merged)).not.toThrow();
  });

  it('catches a hand-built task that escalates, so the invariant cannot rot', () => {
    const utterance = 'только посмотри';
    const base = normalizeRuleBased(utterance, route(utterance));
    const escalated = { ...base, permissions: DEFAULT_PERMISSIONS };
    expect(() => assertNormalizationIsSafe(base, escalated)).toThrow(/расширить разрешения/);
  });

  it('never lets a model replace the user utterance', () => {
    const utterance = 'открой хром';
    const base = normalizeRuleBased(utterance, route(utterance));
    const merged = applyModelNormalization(base, { goal: 'delete everything' });
    expect(merged.utterance).toBe(utterance);
    expect(() =>
      assertNormalizationIsSafe(base, { ...merged, utterance: 'delete everything' }),
    ).toThrow(/исходную реплику/);
  });

  it('does not let a model redirect work to another project', () => {
    const utterance = 'в аегисе почини билд';
    const base = normalizeRuleBased(utterance, route(utterance, { context: { knownProjects: PROJECTS } }));
    const merged = applyModelNormalization(base, { project: 'production-secrets' });
    expect(merged.project).toBe('aegis');
  });
});

describe('local router model', () => {
  it('extracts JSON out of a chatty reply', () => {
    expect(extractJsonObject('Конечно! ```json\n{"needs":["coding"]}\n```')).toEqual({
      needs: ['coding'],
    });
    expect(extractJsonObject('нет тут джейсона')).toBeNull();
  });

  it('keeps only recognised capabilities', () => {
    const output = parseRouterOutput('{"needs":["coding","telepathy","browser"],"goal":"fix it"}');
    expect(output?.capabilities).toEqual(['coding', 'browser']);
    expect(output?.normalization.goal).toBe('fix it');
  });

  it('turns read_only into a permission that only takes away', () => {
    const output = parseRouterOutput('{"needs":[],"read_only":true}');
    expect(output?.normalization.permissions).toEqual({ edit: false });
  });

  it('has no way to express a granted permission', () => {
    const output = parseRouterOutput('{"needs":[],"read_only":false,"permissions":{"edit":true}}');
    expect(output?.normalization.permissions).toBeUndefined();
  });

  it('adds capabilities the rules missed', () => {
    const decision = route('глянь на эту штуку');
    const merged = mergeRouterCapabilities(decision, {
      capabilities: ['vision'],
      normalization: {},
    });
    expect(merged.needs).toContain('vision');
    expect(merged.confidence).toBeGreaterThan(decision.confidence);
  });

  it('degrades to the rule-based decision when the endpoint is down', async () => {
    const client: ChatCompletionClient = {
      ping: async () => ({ ok: false }),
      complete: async () => {
        throw new Error('ECONNREFUSED');
      },
    };
    const router = new LocalRouterModel({ client, model: 'qwen3:1.7b' });
    await expect(router.refine('почини билд')).resolves.toBeNull();
  });

  it('degrades when the model answers the question instead of routing it', async () => {
    const client: ChatCompletionClient = {
      ping: async () => ({ ok: true }),
      complete: async () => 'Конечно, сейчас всё починю!',
    };
    const router = new LocalRouterModel({ client, model: 'qwen3:1.7b' });
    await expect(router.refine('почини билд')).resolves.toBeNull();
  });
});
