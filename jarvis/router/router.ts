/**
 * The router.
 *
 * Its job is emphatically *not* to solve the user's task. It decides which
 * capabilities a request implies, which backend should get it, what the
 * permission ceiling is, and whether the current world state is needed to make
 * sense of it. The task itself is solved by whichever backend it picks.
 *
 * It is rule-based and deterministic, so it works with no model loaded at all.
 * An optional small local model can refine the result (see `localModel.ts`),
 * and everything it returns is filtered through the same invariants.
 */

import type { BackendId } from '../backends/types';
import type { BackendPreference } from '../backends/manager';
import {
  DEFAULT_PERMISSIONS,
  READ_ONLY_PERMISSIONS,
  maxRisk,
  narrowPermissions,
  type JarvisCapability,
  type RiskLevel,
  type TaskPermissions,
} from '../types';
import {
  BACKEND_MENTIONS,
  CAPABILITY_RULES,
  CONTINUATION_PHRASES,
  INSPECT_ONLY_PHRASES,
  NO_EXECUTE_PHRASES,
  REFERENTIAL_STEMS,
} from './lexicon.ru';
import {
  hasAnyPhrase,
  hasAnyStem,
  hasPhrase,
  hasStem,
  indexOfStem,
  isNegatedBefore,
  splitClauses,
  tokenize,
} from './text';

export type JarvisIntent =
  | 'open_app'
  | 'make'
  | 'control_window'
  | 'modify_project'
  | 'inspect_project'
  | 'query_screen'
  | 'browse'
  | 'file_task'
  | 'communicate'
  | 'system'
  | 'continue'
  | 'chat';

export interface KnownProject {
  /** Canonical name, e.g. "aegis". */
  name: string;
  /** Absolute path, e.g. "D:\\Projects\\aegis". */
  path: string;
  /** How the user says it out loud: "аегис", "эгида". */
  aliases?: string[];
}

export interface RouterContext {
  knownProjects?: KnownProject[];
  /** Project the user is currently working in, from world state. */
  currentProject?: string;
  /** Whether a task is running right now — «продолжай» refers to it. */
  hasRunningTask?: boolean;
  /** Settings selectors. */
  codingPreference?: 'auto' | BackendId;
  mainPreference?: 'auto' | BackendId;
}

export interface RoutingDecision {
  intent: JarvisIntent;
  /** Every capability the request implies; never mutually exclusive. */
  needs: JarvisCapability[];
  /** The backend the plan will start with. */
  target: BackendId;
  project?: string;
  projectPath?: string;
  risk: RiskLevel;
  permissions: TaskPermissions;
  /** Backend the user named out loud. */
  requestedBackend?: BackendId;
  /** Backends the user ruled out out loud. */
  excludedBackends: BackendId[];
  /** The utterance leans on «это», «туда», «продолжай» and needs world state. */
  needsWorldState: boolean;
  /**
   * Человек спросил, а не велел.
   *
   * Вынесено наружу, потому что на этом держится одно решение за пределами
   * роутера: у вопроса уверенность разбора низкая всегда — делать-то ничего не
   * надо, — и ядро отвечало «Не понял, что именно сделать. Уточни?» на вопрос
   * о книге. Переспрашивать в ответ на вопрос нельзя; на невнятное «ну это» —
   * нужно, и отличить одно от другого может только этот признак.
   */
  asks: boolean;
  /** Explicit constraints heard in the utterance, in the user's own terms. */
  constraints: string[];
  /** 0..1 — how confident the rules are. Low values are worth a confirmation. */
  confidence: number;
}

/**
 * Finds a backend the user named, and any they ruled out.
 *
 * Negation is resolved per clause. A «не» in one sentence must not reach a
 * backend named in the next: «только ничего не меняй. Через Клод Код» is a
 * request for Claude Code with a read-only constraint, not a refusal of it.
 */
export function detectBackendMentions(utterance: string): {
  requested?: BackendId;
  excluded: BackendId[];
} {
  const excluded: BackendId[] = [];
  let requested: BackendId | undefined;

  for (const clause of splitClauses(utterance)) {
    const tokens = tokenize(clause);
    for (const mention of BACKEND_MENTIONS) {
      for (const stem of mention.stems) {
        const index = indexOfStem(tokens, stem);
        if (index === -1) continue;
        if (isNegatedBefore(tokens, index)) {
          if (!excluded.includes(mention.backend)) excluded.push(mention.backend);
        } else if (!requested) {
          requested = mention.backend;
        }
        break;
      }
    }
  }

  // «не используй клод» must not also read as a request for Claude.
  if (requested && excluded.includes(requested)) {
    requested = undefined;
  }
  return { requested, excluded };
}

function detectCapabilities(tokens: string[]): Set<JarvisCapability> {
  const found = new Set<JarvisCapability>();
  for (const rule of CAPABILITY_RULES) {
    if (hasAnyStem(tokens, rule.stems) || hasAnyPhrase(tokens, rule.phrases ?? [])) {
      found.add(rule.capability);
    }
  }
  // Every request goes through a model, so reasoning is always in play.
  found.add('reasoning');
  return found;
}

/** Locates a known project named in the utterance. */
export function detectProject(
  utterance: string,
  projects: readonly KnownProject[] = [],
): KnownProject | undefined {
  const tokens = tokenize(utterance);
  for (const project of projects) {
    const names = [project.name, ...(project.aliases ?? [])];
    for (const name of names) {
      const stem = tokenize(name)[0];
      if (!stem) continue;
      // Only match on a stem long enough to be distinctive.
      const probe = stem.length > 4 ? stem.slice(0, Math.max(4, stem.length - 1)) : stem;
      if (hasStem(tokens, probe)) return project;
    }
  }
  return undefined;
}

function detectIntent(
  capabilities: ReadonlySet<JarvisCapability>,
  tokens: string[],
  editing: boolean,
): JarvisIntent {
  if (hasAnyPhrase(tokens, CONTINUATION_PHRASES) && tokens.length <= 4) return 'continue';

  // Вопрос — это вопрос, а не приказ.
  //
  // Человек сказал прямо: «он не понимает концепцию вопросов». Так и было.
  // «Кто написал войну и мир» попадало в общение с людьми — из-за слова
  // «написал» — и получало чувствительный риск, то есть Джарвис просил
  // разрешения ответить на вопрос о книге. А «что это за окно» понималось
  // как приказ открыть программу.
  //
  // Решает первое слово. Вопросительное слово в начале — спрашивают; то же
  // слово в середине ничего не значит («сделай так, как я сказал»). Вежливое
  // «можешь открыть хром» вопросом не считается: это просьба.
  if (asksSomething(tokens)) {
    if (capabilities.has('vision') || aboutTheScreen(tokens)) return 'query_screen';
    // Спросить у Джарвиса — не то же, что написать человеку.
    if (!capabilities.has('files') && !capabilities.has('coding')) return 'chat';
  }

  if (capabilities.has('communication')) return 'communicate';
  if (capabilities.has('vision')) return 'query_screen';
  if (capabilities.has('coding')) return editing ? 'modify_project' : 'inspect_project';

  // «Сделать» важнее того, где именно: и таблица, и сцена, и картинка — это
  // работа, а не запуск программы и не поиск файла. Отвечать «Открываю» на
  // «создай сферу» значит обещать не то, что произойдёт.
  if (
    hasAnyStem(tokens, MAKING_VERBS) &&
    (capabilities.has('computer') || capabilities.has('files') || capabilities.has('browser'))
  ) {
    return 'make';
  }

  if (capabilities.has('browser')) return 'browse';
  if (capabilities.has('system')) return 'system';
  if (capabilities.has('files')) return 'file_task';
  if (capabilities.has('computer')) {
    return hasAnyStem(tokens, ['закро', 'сверн', 'разверн', 'переключ'])
      ? 'control_window'
      : 'open_app';
  }
  return 'chat';
}

/**
 * Слова, с которых начинают вопрос.
 *
 * Только начало фразы: в середине они значат другое. «Что это за окно» —
 * вопрос, «сделай так, что бы всё работало» — нет.
 */
const QUESTION_WORDS = [
  'что', 'чего', 'чему', 'чем', 'кто', 'кого', 'кому', 'кем', 'чей', 'чья',
  'где', 'куда', 'откуда', 'когда', 'почему', 'зачем', 'сколько', 'насколько',
  'какой', 'какая', 'какое', 'какие', 'каков', 'который', 'правда',
];

/**
 * Спрашивают ли.
 *
 * Три признака, и третий важнее двух первых. В русском вопрос без
 * вопросительного слова отличается ТОЛЬКО интонацией: «ты сделал ракету?» и
 * «ты сделал ракету.» — разные вещи, и никакой разбор слов их не различит.
 * Распознаватель слышит интонацию и записывает её знаком вопроса; наше дело —
 * его не потерять.
 */
function asksSomething(tokens: readonly string[], raw?: string): boolean {
  if (raw?.trimEnd().endsWith('?')) return true;

  const first = tokens[0];
  if (!first) return false;
  if (QUESTION_WORDS.includes(first)) return true;
  // «Слышишь ли ты меня» — вопрос по частице, а не по первому слову.
  return tokens.length > 1 && tokens[1] === 'ли';
}

/** Спрашивают ли про то, что сейчас на экране. */
function aboutTheScreen(tokens: readonly string[]): boolean {
  return hasAnyStem(tokens, ['окн', 'экран', 'программ', 'вкладк', 'видн', 'открыт']);
}

/**
 * Слова, которыми показывают на только что случившееся, не называя его.
 *
 * «Это», «оно», «так» — отсылка к предыдущей реплике или к тому, что Джарвис
 * сейчас делал. Ответ на такой вопрос лежит в журнале, а не в исходниках.
 */
const УКАЗАТЕЛЬНЫЕ = ['это', 'оно', 'этот', 'эта', 'так', 'тут', 'там', 'все'];

/**
 * Вопрос о происходящем, а не о проекте.
 *
 * «Почему это не работает?» и «почему не проходят тесты?» — разные просьбы. Во
 * второй названо конкретное, в первой — только «это».
 *
 * Признак «coding» ставится в том числе фразами «не работает», «не собирается»
 * и «не проходит», и без этой проверки ЛЮБОЙ вопрос о неудаче уходил осматривать
 * проект: сквозная проверка 20.09.2026 поймала «почему это не работает?» —
 * намерение inspect_project, три способности, работа агента вместо ответа.
 * Это ровно то, на что человек жаловался словами «он не понимает концепцию
 * вопроса и не может на него по факту отвечать».
 *
 * Разделяет одно: названо ли хоть что-нибудь из мира кода. Если названо —
 * работа, как и было.
 */
function aboutWhatJustHappened(tokens: readonly string[]): boolean {
  const кодовые = CAPABILITY_RULES.find((rule) => rule.capability === 'coding')?.stems ?? [];
  if (hasAnyStem(tokens, кодовые)) return false;
  return hasAnyStem(tokens, УКАЗАТЕЛЬНЫЕ);
}

/**
 * Глаголы созидания.
 *
 * Отличают работу в программе от её запуска. Проверяются после слов закрытия,
 * но до «открыть»: «открой блендер и создай сферу» — это всё-таки работа.
 */
const MAKING_VERBS = [
  'созда', 'сдела', 'нарисуй', 'нарисова', 'рисуй', 'начерт', 'постро',
  'собер', 'собра', 'отрендер', 'напиши', 'сгенерир', 'смоделир', 'слепи',
  'перекрас', 'помен', 'измен', 'испра', 'переде',
  // Неопределённая форма: распознаватель слышит «поменять» вместо «поменяй».
  'сделать', 'создать', 'нарисовать', 'построить', 'поменять', 'изменить',
];

/**
 * Четыре красные линии — и больше ничего.
 *
 * Разрешение на каждый чих превращает голосового помощника в анкету: человек
 * говорит «сделай громче» и ждёт вопроса «выполнять?». Поэтому спрашиваем
 * только там, где ошибка необратима или стоит денег:
 *
 *   1. трата денег;
 *   2. общение от его имени с другими людьми;
 *   3. системные файлы Windows и чужие большие проекты;
 *   4. выключение и перезагрузка машины.
 *
 * Всё остальное — громкость, окна, файлы в своей папке, работа в программах —
 * делается молча.
 */
const DESTRUCTIVE_HINT_PHRASES: string[][] = [
  ['удал', 'все'],
  ['удал', 'всё'],
  ['снеси', 'все'],
  ['снеси', 'всё'],
  ['очист', 'диск'],
  ['форматир'],
  ['сброс', 'настройк'],
  ['отключ', 'защит'],
  ['отключ', 'антивирус'],
  ['отключ', 'брандмауэр'],
];

/** Системные места Windows: ошибка здесь чинится переустановкой. */
const SYSTEM_PLACE_STEMS = [
  'windows', 'виндов', 'system32', 'систем32', 'реестр', 'registry',
  'program', 'загрузчик', 'boot', 'драйвер',
];

/** Слова, за которыми стоят деньги. */
const MONEY_STEMS = [
  'куп', 'покуп', 'оплат', 'плат', 'платеж', 'платёж', 'подписк', 'заказ',
  'карт', 'счёт', 'счет', 'банк', 'кошел', 'биткоин',
  'крипт', 'продай', 'ставк',
];

/**
 * «Перевести» — это два разных дела, и одно из них про деньги.
 *
 * Слово стояло в списке денежных прямо, и живой случай показал цену: «переведи
 * все рассказы и портфолио на английский» попало под красную линию «трата
 * денег». Дальше Claude Code запустился в режиме, который в безголовом запуске
 * не спрашивает, а молча отклоняет каждую запись, — и час работы ушёл в никуда
 * с бодрым отчётом о сделанном.
 *
 * Различает не слово, а то, что стоит рядом. Деньги переводят на счёт, на
 * карту, в рублях; тексты — на язык.
 */
const TRANSFER_STEMS = ['переведи', 'перевод', 'переведён', 'переведен'];

const MONEY_NEIGHBOURS = [
  'деньг', 'рубл', 'доллар', 'евро', 'шекел', 'гривн', 'тенге', 'сум',
  'карт', 'счёт', 'счет', 'банк', 'кошел', 'крипт', 'биткоин', 'зарплат',
];

/** Действия с машиной, у которых цена ошибки — чужая несохранённая работа. */
const MACHINE_STEMS = ['перезагруз', 'выключ', 'выруб', 'заверш', 'выйти'];

function aprioriRisk(
  capabilities: ReadonlySet<JarvisCapability>,
  tokens: string[],
  editing: boolean,
): RiskLevel {
  if (hasAnyPhrase(tokens, DESTRUCTIVE_HINT_PHRASES)) return 'dangerous';

  // Третья красная линия: системные места Windows. Стирание в них не
  // откатывается ничем, кроме переустановки.
  const touchesSystemPlace = hasAnyStem(tokens, SYSTEM_PLACE_STEMS);
  // Приставки важны: «почисти» не начинается с «очист», и без этого слова
  // «почисти system32» проходило как безопасное.
  const destroys = hasAnyStem(tokens, [
    'удал', 'сотр', 'снеси', 'очист', 'почист', 'вычист', 'перезапиш', 'перепиш', 'формат',
  ]);
  if (touchesSystemPlace && destroys) return 'dangerous';

  let level: RiskLevel = 'safe';

  // Первая и вторая линии.
  //
  // Вопрос — не общение с людьми. «Кто написал войну и мир» получало
  // чувствительный риск из-за слова «написал», и Джарвис просил разрешения
  // ответить на вопрос о книге. Красная линия — отправить сообщение живому
  // человеку, а не произнести слово «написал».
  if (capabilities.has('communication') && !asksSomething(tokens)) {
    level = maxRisk(level, 'sensitive');
  }
  if (hasAnyStem(tokens, MONEY_STEMS)) level = maxRisk(level, 'sensitive');
  // Перевод — деньги только рядом с деньгами. Иначе это язык.
  if (hasAnyStem(tokens, TRANSFER_STEMS) && hasAnyStem(tokens, MONEY_NEIGHBOURS)) {
    level = maxRisk(level, 'sensitive');
  }
  if (hasAnyStem(tokens, ['push', 'запуш', 'запушь', 'опублик'])) {
    level = maxRisk(level, 'sensitive');
  }

  // Четвёртая: выключение и перезагрузка. Само по себе наличие capability
  // «system» больше ничего не значит — громкость и вайфай спрашивать незачем.
  if (hasAnyStem(tokens, MACHINE_STEMS) && capabilities.has('system')) {
    level = maxRisk(level, 'sensitive');
  }
  if (editing && (capabilities.has('coding') || capabilities.has('files'))) {
    level = maxRisk(level, 'normal');
  }
  if (capabilities.has('shell')) level = maxRisk(level, 'normal');
  return level;
}

/**
 * Reads the permission ceiling out of the utterance.
 *
 * Only ever narrows: the base envelope comes from settings, and an explicit
 * «только посмотри» takes permissions away. Nothing in an utterance can add
 * a permission the base envelope does not already carry.
 */
export function derivePermissions(
  utterance: string,
  base: TaskPermissions = DEFAULT_PERMISSIONS,
): { permissions: TaskPermissions; constraints: string[] } {
  const tokens = tokenize(utterance);
  const constraints: string[] = [];
  let permissions = { ...base };

  if (hasAnyPhrase(tokens, INSPECT_ONLY_PHRASES)) {
    permissions = narrowPermissions(permissions, { edit: false });
    constraints.push('Сначала осмотреть, не менять');
  }
  if (hasAnyPhrase(tokens, NO_EXECUTE_PHRASES)) {
    permissions = narrowPermissions(permissions, { execute: false });
    constraints.push('Ничего не запускать');
  }
  if (hasPhrase(tokens, ['без', 'лишн']) || hasPhrase(tokens, ['ничего', 'лишн'])) {
    constraints.push('Не трогать несвязанное');
  }
  return { permissions, constraints };
}

export interface RouteOptions {
  context?: RouterContext;
  /** The permission ceiling from settings. Rules can only narrow it. */
  basePermissions?: TaskPermissions;
}

export function route(utterance: string, options: RouteOptions = {}): RoutingDecision {
  const context = options.context ?? {};
  const tokens = tokenize(utterance);
  const capabilities = detectCapabilities(tokens);

  // Вопрос — не переписка с людьми.
  //
  // «Кто написал войну и мир» получало умение «общение» из-за слова
  // «написал», и дальше это тянуло за собой и чувствительный риск, и выбор
  // бэкенда, и превращение вопроса в задачу. Красная линия — отправить
  // сообщение живому человеку, а не произнести глагол.
  if (asksSomething(tokens)) capabilities.delete('communication');

  // Вопрос о неудаче — не поручение осмотреть проект.
  //
  // «Почему это не работает?» получало умение «код» из фразы «не работает» и
  // становилось inspect_project: агент, инструменты, двадцать секунд — вместо
  // ответа на вопрос о том, что Джарвис только что сделал. Убирается здесь, а
  // не в выборе намерения, чтобы и бэкенд не выбирался как для работы с кодом.
  if (asksSomething(tokens) && aboutWhatJustHappened(tokens)) capabilities.delete('coding');

  const { permissions, constraints } = derivePermissions(
    utterance,
    options.basePermissions ?? DEFAULT_PERMISSIONS,
  );
  const editing = permissions.edit;

  const { requested, excluded } = detectBackendMentions(utterance);
  const project = detectProject(utterance, context.knownProjects ?? []);

  // A coding backend was named out loud, so this is coding work even if the
  // words did not say so: «сделай это через Клод Код».
  if (requested === 'claude-code' || requested === 'codex') {
    capabilities.add('coding');
  }

  const needsWorldState =
    hasAnyStem(tokens, REFERENTIAL_STEMS) || hasAnyPhrase(tokens, CONTINUATION_PHRASES);
  if (needsWorldState) capabilities.add('memory');

  const intent = detectIntent(capabilities, tokens, editing);
  const risk = aprioriRisk(capabilities, tokens, editing);

  const resolvedProject = project?.name ?? context.currentProject;
  const target = pickTarget({
    capabilities,
    requested,
    excluded,
    codingPreference: context.codingPreference,
    mainPreference: context.mainPreference,
  });

  return {
    intent,
    needs: [...capabilities],
    target,
    project: resolvedProject,
    projectPath: project?.path,
    risk,
    permissions: permissions.edit ? permissions : narrowPermissions(permissions, READ_ONLY_PERMISSIONS),
    requestedBackend: requested,
    excludedBackends: excluded,
    needsWorldState,
    asks: asksSomething(tokens),
    constraints,
    confidence: scoreConfidence(capabilities, tokens, needsWorldState),
  };
}

function pickTarget(input: {
  capabilities: ReadonlySet<JarvisCapability>;
  requested?: BackendId;
  excluded: BackendId[];
  codingPreference?: 'auto' | BackendId;
  mainPreference?: 'auto' | BackendId;
}): BackendId {
  if (input.requested) return input.requested;

  // Переписка — единственное, что остаётся рантайму по умолчанию: у него живые
  // учётные записи в мессенджерах, а у агента только мышь.
  if (input.capabilities.has('communication')) return 'interpreter';

  // Код проверяется раньше экрана: у задачи по коду почти всегда есть заодно
  // capability «файлы», и экранная ветка иначе отменяла бы выбор кодового
  // backend в настройках.
  if (input.capabilities.has('coding')) {
    const preferred = input.codingPreference;
    if (preferred && preferred !== 'auto' && !input.excluded.includes(preferred)) {
      return preferred;
    }
    if (!input.excluded.includes('claude-code')) return 'claude-code';
    if (!input.excluded.includes('codex')) return 'codex';
  }

  // Экран, окна, файлы, браузер, 3D — к Claude Code. Инструменты рабочего
  // стола и скиллы под программы есть только там; рантайм, получив такую
  // задачу, не мог ни открыть Blender, ни положить файл в папку человека.
  const needsScreen =
    input.capabilities.has('computer') ||
    input.capabilities.has('browser') ||
    input.capabilities.has('vision') ||
    input.capabilities.has('files') ||
    input.capabilities.has('system');
  if (needsScreen && !input.excluded.includes('claude-code')) return 'claude-code';
  if (needsScreen) return 'interpreter';

  const main = input.mainPreference;
  if (main && main !== 'auto' && !input.excluded.includes(main)) return main;
  return 'interpreter';
}

/**
 * How much the rules actually recognised.
 *
 * A short utterance full of pronouns is not low-quality input — it is normal
 * speech — but it does mean the decision rests on world state rather than on
 * the words, and the caller may want to confirm before doing something
 * irreversible.
 */
function scoreConfidence(
  capabilities: ReadonlySet<JarvisCapability>,
  tokens: string[],
  needsWorldState: boolean,
): number {
  // 'reasoning' is always present, and 'memory' only means the request leans on
  // context. Neither says anything about whether the request was understood, so
  // neither counts towards confidence.
  const uninformative = 1 + (capabilities.has('memory') ? 1 : 0);
  const recognised = capabilities.size - uninformative;
  if (tokens.length === 0) return 0;
  let score = Math.min(1, 0.35 + recognised * 0.2);
  if (needsWorldState && recognised === 0) score = Math.min(score, 0.4);
  if (tokens.length <= 2 && recognised === 0) score = Math.min(score, 0.3);
  return Number(score.toFixed(2));
}

/** Turns a decision into the preference the BackendManager consumes. */
export function toBackendPreference(
  decision: RoutingDecision,
  context: RouterContext = {},
): BackendPreference {
  return {
    codingPreference: context.codingPreference ?? 'auto',
    mainPreference: context.mainPreference ?? 'auto',
    requested: decision.requestedBackend,
    excluded: decision.excludedBackends,
  };
}
