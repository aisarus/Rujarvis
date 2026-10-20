/**
 * Политика одного запуска Gemini CLI — красные линии Джарвиса его же движком.
 *
 * ## Почему политика, а не хук
 *
 * У Gemini есть хук `BeforeTool`, и явный отказ он держит. Но на собственном
 * сбое хук пропускает вызов — это записано в его документации («Other: Warning
 * … the interaction proceeds») и замерено на Gemini CLI 0.64.0 20.10.2026:
 * упавший хук (код 1), хук с мусором вместо JSON и зависший хук — запись
 * файла прошла во всех трёх случаях. Правило Джарвиса — любой сбой означает
 * отказ, и такой хук его не держит.
 *
 * Поэтому как у Codex (путь «Б»): встроенные опасные инструменты Gemini
 * выключены его же настройками, а действия на экране идут только через
 * MCP-сервер Джарвиса, где каждый вызов проверяет `risk/serverGate.ts`.
 *
 * ## Почему уровень администратора
 *
 * Политика передаётся флагом `--admin-policy`: это верхний уровень движка
 * Gemini, выше пользовательских настроек и настроек папки проекта. Чужой
 * `.gemini/settings.json` в папке задачи не может разрешить то, что здесь
 * запрещено. Правила — белый список: сначала «запрещено всё», потом
 * разрешено ровно то, что нужно этой задаче. Запрет без условия Gemini не
 * показывает модели вовсе, и лишние инструменты не стоят ей токенов.
 *
 * ## Запись — только в папки задачи
 *
 * Сам Gemini не пишет вне своих рабочих папок (замер: «Path not in
 * workspace»). Поверх этого — свой список: путь внутри рабочей папки или
 * папки результатов, без «..», без `.claude`, `.codex`, `.gemini` и без
 * папки Джарвиса. Пути сравниваются в виде, в каком Gemini их сверяет, —
 * строкой JSON аргументов, где обратная косая удвоена.
 */

import path from 'node:path';

export interface GeminiPolicyOptions {
  /** Встроенные инструменты, разрешённые без условий. */
  builtins: readonly string[];
  /** Сервер Джарвиса этого запуска и его инструменты (`undefined` — все). */
  server?: { name: string; tools?: readonly string[] };
  /** Можно ли писать файлы. Нет — `write_file` и `replace` запрещены. */
  writes?: {
    /** Папки, куда можно писать: рабочая папка задачи и папка результатов. */
    roots: readonly string[];
    /** Папки, куда нельзя никогда: папка Джарвиса или её данные. */
    protectedRoots: readonly string[];
    /** Рабочая папка: относительные пути Gemini отсчитывает от неё. */
    cwd: string;
    /**
     * Относительные пути — только внутри этой подпапки рабочей папки
     * (`out` у разбора документа). Не задано — любой относительный путь.
     */
    relativeUnder?: string;
  };
  platform?: NodeJS.Platform;
}

/** Инструменты записи файлов у Gemini. */
export const GEMINI_WRITE_TOOLS = ['write_file', 'replace'] as const;

/** Папки настроек агентов: правка там переживает задачу и меняет всех. */
const AGENT_FOLDERS = ['.claude', '.codex', '.gemini', '.agents'];

/**
 * Разделитель пути в строке JSON аргументов: `\\` (удвоенная косая) или `/`.
 *
 * Классом знаков, а не группой — и ни одного повторителя за группой во всём
 * шаблоне. Gemini 0.64.0 отвергает такой шаблон как опасный («Unsafe regex
 * pattern (potential ReDoS)»: проверка `\([^)]*[*+?{].*\)[*+?{]` и длина не
 * больше 2048), и правило выпадает целиком. Замер 20.10.2026: с `(?:\\|/)+`
 * выпали все правила записи, и Gemini остался без записи вовсе.
 */
const SEP = String.raw`[\\\\/]`;
const SEPS = `${SEP}+`;
/** Конец сегмента: дальше разделитель или конец пути. */
const КОНЕЦ = String.raw`[\\\\/"]`;
/** Начало значения `file_path` в строке аргументов Gemini: `\0"file_path":"…`. */
const НАЧАЛО = String.raw`\x00"file_path":"`;

/** Самая длинная строка шаблона, которую Gemini ещё принимает. */
export const GEMINI_PATTERN_LIMIT = 2048;

/** Та же проверка, что у Gemini (`isSafeRegExp`): шаблон, который он не отвергнет. */
export function geminiAcceptsPattern(pattern: string): boolean {
  try {
    new RegExp(pattern);
  } catch {
    return false;
  }
  return pattern.length <= GEMINI_PATTERN_LIMIT && !/\([^)]*[*+?{].*\)[*+?{]/u.test(pattern);
}

function экранировать(текст: string): string {
  return текст.replace(/[.*+?^${}()|[\]\\/-]/gu, (знак) => `\\${знак}`);
}

/**
 * Кусок пути как регулярное выражение: без учёта регистра там, где его не
 * учитывает система (Windows и мак). Флагов у шаблонов Gemini нет, поэтому
 * регистр — классами: `[cC]`.
 */
function кусок(текст: string, безРегистра: boolean): string {
  let итог = '';
  for (const знак of текст) {
    const верх = знак.toUpperCase();
    const низ = знак.toLowerCase();
    if (безРегистра && верх !== низ && верх.length === 1 && низ.length === 1) итог += `[${низ}${верх}]`;
    else итог += экранировать(знак);
  }
  return итог;
}

/** Абсолютная папка как начало пути в JSON: сегменты через любой разделитель. */
export function rootPattern(root: string, platform: NodeJS.Platform = process.platform): string {
  const безРегистра = platform === 'win32' || platform === 'darwin';
  const части = root.split(/[\\/]+/u).filter(Boolean);
  const начало = platform === 'win32' ? '' : SEPS;
  return начало + части.map((часть) => кусок(часть, безРегистра)).join(SEPS);
}

function строка(значение: string): string {
  // Строка TOML в двойных кавычках экранируется как JSON — и обратная косая,
  // и кавычка, и управляющие знаки. Кириллица остаётся как есть (UTF-8).
  return JSON.stringify(значение);
}

function список(значения: readonly string[]): string {
  return `[${значения.map(строка).join(', ')}]`;
}

/** Шаблоны путей, куда писать нельзя никогда. Хватит совпадения одного. */
export function protectedWritePatterns(options: NonNullable<GeminiPolicyOptions['writes']>, platform: NodeJS.Platform): string[] {
  const безРегистра = platform === 'win32' || platform === 'darwin';
  const папкиАгентов = `(${AGENT_FOLDERS.map((имя) => кусок(имя, безРегистра)).join('|')})`;
  const шаблоны = [
    // «..» — в начале пути или после разделителя.
    String.raw`${НАЧАЛО}\.\.${КОНЕЦ}`,
    String.raw`${НАЧАЛО}[^"]*${SEP}\.\.${КОНЕЦ}`,
    // Настройки агентов — в начале пути или где угодно в нём.
    `${НАЧАЛО}${папкиАгентов}${КОНЕЦ}`,
    `${НАЧАЛО}[^"]*${SEP}${папкиАгентов}${КОНЕЦ}`,
  ];
  for (const корень of options.protectedRoots) {
    шаблоны.push(`${НАЧАЛО}${rootPattern(корень, platform)}${КОНЕЦ}`);
    // Защищённое внутри рабочей папки достижимо и относительным путём.
    const пути = platform === 'win32' ? path.win32 : path.posix;
    const относительно = пути.relative(options.cwd, корень);
    if (относительно && !относительно.startsWith('..') && !пути.isAbsolute(относительно)) {
      const сегменты = относительно.split(/[\\/]+/u).filter(Boolean).map((часть) => кусок(часть, безРегистра)).join(SEPS);
      шаблоны.push(`${НАЧАЛО}${сегменты}${КОНЕЦ}`, String.raw`${НАЧАЛО}\.${SEPS}${сегменты}${КОНЕЦ}`);
    }
  }
  return шаблоны;
}

/**
 * Шаблоны путей, куда писать можно: относительный путь (Gemini отсчитывает
 * его от рабочей папки) или путь внутри разрешённой папки. Хватит одного.
 */
export function allowedWritePatterns(options: NonNullable<GeminiPolicyOptions['writes']>, platform: NodeJS.Platform): string[] {
  const безРегистра = platform === 'win32' || platform === 'darwin';
  const под = options.relativeUnder
    ?.split(/[\\/]+/u)
    .filter(Boolean)
    .map((часть) => кусок(часть, безРегистра))
    .join(SEPS);
  const относительные = под
    ? // Только внутри подпапки: «out/…» и «./out/…».
      [`${НАЧАЛО}${под}${SEP}`, String.raw`${НАЧАЛО}\.${SEPS}${под}${SEP}`]
    : // Не диск, не корень, не сетевой путь и не «~».
      [`${НАЧАЛО}(?![A-Za-z]:|${SEP}|~)[^"]*"\\x00`];
  return [...относительные, ...options.roots.filter(Boolean).map((корень) => `${НАЧАЛО}${rootPattern(корень, platform)}${КОНЕЦ}`)];
}

/** Текст политики TOML для одного запуска. */
export function geminiPolicy(options: GeminiPolicyOptions): string {
  const platform = options.platform ?? process.platform;
  const правила: string[] = [
    '# Красные линии Джарвиса для одного запуска Gemini CLI.',
    '# Сначала запрещено всё, потом разрешено ровно то, что нужно этой задаче.',
    '',
    '[[rule]]',
    'toolName = "*"',
    'decision = "deny"',
    'priority = 100',
    `denyMessage = ${строка('Этого инструмента у тебя здесь нет: Джарвис его не разрешил. Скажи человеку, чего не хватило.')}`,
  ];

  if (options.builtins.length > 0) {
    правила.push('', '[[rule]]', `toolName = ${список(options.builtins)}`, 'decision = "allow"', 'priority = 500');
  }

  if (options.server) {
    правила.push('', '[[rule]]', `mcpName = ${строка(options.server.name)}`);
    if (options.server.tools) правила.push(`toolName = ${список(options.server.tools)}`);
    правила.push('decision = "allow"', 'priority = 500');
  }

  if (options.writes) {
    for (const шаблон of allowedWritePatterns(options.writes, platform)) {
      правила.push(
        '',
        '[[rule]]',
        `toolName = ${список(GEMINI_WRITE_TOOLS)}`,
        `argsPattern = ${строка(шаблон)}`,
        'decision = "allow"',
        'priority = 600',
        'modes = ["autoEdit"]',
      );
    }
    for (const шаблон of protectedWritePatterns(options.writes, platform)) {
      правила.push(
        '',
        '[[rule]]',
        `toolName = ${список(GEMINI_WRITE_TOOLS)}`,
        `argsPattern = ${строка(шаблон)}`,
        'decision = "deny"',
        'priority = 900',
        `denyMessage = ${строка('Сюда писать нельзя: это настройки агентов или папка Джарвиса. Скажи человеку, если без этого не обойтись.')}`,
      );
    }
  }

  // Оболочка — запрет поверх всего, отдельной строкой: даже если кто-то
  // добавит её в список разрешённых выше, она не пройдёт.
  правила.push(
    '',
    '[[rule]]',
    'toolName = "run_shell_command"',
    'decision = "deny"',
    'priority = 999',
    `denyMessage = ${строка('Оболочки у тебя нет: её проверку Gemini не умеет держать надёжно.')}`,
    '',
  );
  return правила.join('\n');
}
