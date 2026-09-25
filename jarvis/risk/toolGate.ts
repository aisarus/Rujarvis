/**
 * Риск конкретного вызова инструмента агентом.
 *
 * ## Зачем
 *
 * Роутер оценивает фразу человека до того, как агент начал работу. Но делает
 * работу не фраза, а инструменты: «разбери загрузки» — обычная просьба, а
 * `git push --force`, который агент выполнит посреди неё по подсказке с
 * прочитанной страницы, — уже нет. Поэтому красные линии проверяются ещё раз,
 * на каждом вызове, по тому, что агент собирается сделать на самом деле.
 *
 * Классификация — та же чистая политика из `policy.ts`. Здесь только перевод
 * вызова инструмента в действие, которое она умеет оценить.
 *
 * ## Чего здесь нет
 *
 * Клик по координатам и нажатие элемента окна по номеру (`click`,
 * `window_press`) не говорят, что именно нажимается, — оценить их нечем.
 * Кнопки веб-страниц (`browser_click`) называются текстом и проверяются.
 */

import path from 'node:path';

import { tr } from '../locale/language';
import { type RiskLevel } from '../types';
import { classifyAction, type JarvisAction } from './policy';

export interface GateContext {
  /** Рабочая папка задачи. */
  cwd: string;
  /** Папка результатов для человека. */
  outputDir?: string;
  /** Папка самого Джарвиса: данные, «характер», пусковые файлы. */
  homeDir?: string;
  /** Временная папка системы: туда агент пишет черновики. */
  tempDir?: string;
  /** Домашняя папка пользователя — там живут настройки Claude Code и Codex. */
  userHome?: string;
}

export interface ToolRisk {
  level: RiskLevel;
  /** Что сказать человеку, если нужно спросить. По-русски, одно предложение. */
  summary: string;
}

type Input = Record<string, unknown>;

const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

// `\b` после кириллицы НЕ РАБОТАЕТ, даже с флагом `u`.
//
// Для `\b` символ слова — только ASCII, поэтому `/перевод\b/iu` не находит
// «Перевод», `/написать\b/iu` — «Написать», а `/пин\b/iu` — «ПИН-код». Три
// красные линии из четырёх молча пропускали кнопку: клик получал класс
// «безопасно» и не спрашивал никого. Замер: `/перевод\b/iu.test('Перевод')`
// возвращает false.
//
// Вместо границы — «дальше не буква»: так «Перевод» и «ПИН-код» ловятся, а
// «Переводчик» остаётся в покое.
// Шаблоны собираются `String.raw`, а не обычной строкой.
//
// В обычном шаблоне граница слова превращается в символ забоя, и ветка
// перестаёт совпадать вовсе: «Buy now» получал класс «безопасно». Поймано
// проверкой сразу после правки — ровно тот случай, ради которого она есть.
const КОНЕЦ_СЛОВА = String.raw`(?![\p{L}\p{N}])`;

/** Надписи кнопок, за которыми деньги. */
const PAYMENT_LABEL = new RegExp(
  String.raw`оплат|купить|покупк|заказ|перевест|перевод${КОНЕЦ_СЛОВА}|pay\b|payment|buy\b|purchase|checkout|place order|subscribe`,
  'iu',
);
/** Надписи кнопок, за которыми сообщение другим людям. */
const SEND_LABEL = new RegExp(
  String.raw`отправ|опубликова|написать${КОНЕЦ_СЛОВА}|send\b|post\b|publish|tweet|reply\b`,
  'iu',
);
/** Поля, в которые вводят платёжные данные и пароли. */
const SECRET_FIELD = new RegExp(
  String.raw`карт|card|cvv|cvc|парол|password|пин${КОНЕЦ_СЛОВА}|pin\b`,
  'iu',
);

/** Файлы, открытие которых запускает программу. */
const EXECUTABLE = /\.(exe|bat|cmd|com|ps1|vbs|vbe|js|jse|wsf|msi|msix|scr|lnk|reg|hta|jar)$/iu;

export function classifyToolUse(tool: string, input: Input, context: GateContext): ToolRisk {
  const text = (key: string): string => (typeof input[key] === 'string' ? (input[key] as string) : '');

  if (SHELL_TOOLS.has(tool)) {
    const command = text('command');
    // «Внутри проекта» — только если команда не метит в защищённое.
    //
    // Раньше здесь стояло `insideProject: true` без всяких условий, и
    // `Set-Content` в папку моста разрешений проходил как обычная работа.
    // Этого хватало, чтобы подложить `ok-<id>.json` с `{"allow": true}` —
    // мост принял бы это за разрешение, данное голосом. Красная линия,
    // которую можно обойти изнутри, — не линия.
    const метитВЗащищённое = protectedRoots(context).some((root) => mentions(command, root));
    return {
      level: classifyAction({ kind: 'shell', command, insideProject: !метитВЗащищённое }),
      summary: tr(`Агент хочет выполнить команду: ${clip(command)}.`, `The agent wants to run: ${clip(command)}.`),
    };
  }

  if (WRITE_TOOLS.has(tool)) {
    const file = text('file_path') || text('notebook_path');
    return {
      level: classifyAction(writeAction(file, context)),
      summary: tr(`Агент хочет изменить файл ${file}.`, `The agent wants to change ${file}.`),
    };
  }

  switch (mcpName(tool)) {
    case 'browser_click': {
      const label = text('text');
      return labelRisk(label, tr(`Агент хочет нажать «${clip(label)}» в браузере.`, `The agent wants to press "${clip(label)}" in the browser.`));
    }
    case 'browser_fill': {
      const label = text('label');
      const summary = tr(`Агент хочет ввести данные в поле «${clip(label)}».`, `The agent wants to fill in "${clip(label)}".`);
      if (SECRET_FIELD.test(label)) return { level: 'sensitive', summary };
      return labelRisk(label, summary);
    }
    case 'write_skill':
      // Навык ложится в общие навыки Claude Code и действует во всех его
      // сессиях человека, не только в работе Джарвиса.
      return {
        level: 'sensitive',
        summary: tr(
          `Агент хочет записать навык «${clip(text('name'))}» в общие навыки Claude Code.`,
          `The agent wants to save the skill "${clip(text('name'))}" to your Claude Code skills.`,
        ),
      };
    case 'show_file': {
      const file = text('file');
      if (input.open === true && EXECUTABLE.test(file)) {
        return { level: 'sensitive', summary: tr(`Агент хочет запустить ${file}.`, `The agent wants to run ${file}.`) };
      }
      return { level: 'safe', summary: '' };
    }
    case 'move_to_output': {
      const file = text('file');
      return {
        level: within(file, workRoots(context)) ? 'normal' : 'sensitive',
        summary: tr(`Агент хочет перенести ${file} в папку результатов.`, `The agent wants to move ${file} to the results folder.`),
      };
    }
    default:
      return { level: 'safe', summary: '' };
  }
}

function labelRisk(label: string, summary: string): ToolRisk {
  if (PAYMENT_LABEL.test(label)) return { level: classifyAction({ kind: 'payment', detail: label }), summary };
  if (SEND_LABEL.test(label)) return { level: classifyAction({ kind: 'send-message', channel: label }), summary };
  return { level: 'safe', summary };
}

function writeAction(raw: string, context: GateContext): JarvisAction {
  const file = /^([a-z]:)?[\\/]/iu.test(raw) ? raw : path.join(context.cwd, raw);
  return {
    kind: 'write-file',
    path: file,
    system: isSystemPath(file),
    // Настройки самого агента и Джарвиса — не «внутри проекта», даже если
    // проект лежит рядом: правка там переживает задачу и меняет поведение
    // всех следующих.
    insideProject: within(file, workRoots(context)) && !within(file, protectedRoots(context)),
  };
}

function workRoots(context: GateContext): string[] {
  return [context.cwd, context.outputDir, context.tempDir].filter((root): root is string => Boolean(root));
}

function protectedRoots(context: GateContext): string[] {
  const roots: string[] = [];
  if (context.userHome) {
    roots.push(path.join(context.userHome, '.claude'), path.join(context.userHome, '.codex'));
  }
  // Папка Джарвиса защищена целиком, кроме рабочей папки задачи внутри неё:
  // при разработке самого Джарвиса задача идёт в его исходниках.
  if (context.homeDir && !within(context.cwd, [context.homeDir])) roots.push(context.homeDir);
  if (context.homeDir && within(context.cwd, [context.homeDir])) {
    roots.push(...['data', 'характер.md'].map((name) => path.join(context.homeDir as string, name)));
  }
  return roots;
}

const SYSTEM_ROOTS = [
  /^[a-z]:[\\/]windows([\\/]|$)/iu,
  /^[a-z]:[\\/]program files( \(x86\))?([\\/]|$)/iu,
  /^[a-z]:[\\/]programdata([\\/]|$)/iu,
  /^\/(etc|usr|bin|sbin|boot|lib|lib64|system|library)(\/|$)/iu,
];

export function isSystemPath(file: string): boolean {
  return SYSTEM_ROOTS.some((pattern) => pattern.test(file.trim()));
}

/**
 * Упоминает ли команда этот путь — в любом написании.
 *
 * Строка команды не разбирается на аргументы нарочно: цель не в том, чтобы
 * понять команду, а в том, чтобы не пропустить упоминание защищённой папки
 * ни с прямыми, ни с обратными слешами, ни в другом регистре.
 */
function mentions(command: string, root: string): boolean {
  if (!command || !root) return false;
  // Обратный слеш через код символа: в шаблонных строках и заменах он
  // схлопывается вдвое незаметно, и правка ломает разбор пути молча.
  const ОБРАТНЫЙ = String.fromCharCode(92);
  const вид = (текст: string): string => текст.toLowerCase().split(ОБРАТНЫЙ).join('/');
  return вид(command).includes(вид(root));
}

/** Лежит ли файл внутри одной из папок. Регистр и вид косой черты не важны. */
export function within(file: string, roots: readonly string[]): boolean {
  if (!file) return false;
  const target = normalise(file);
  return roots.some((root) => {
    const base = normalise(root);
    return target === base || target.startsWith(`${base}/`);
  });
}

function normalise(value: string): string {
  const parts: string[] = [];
  for (const part of value.split(/[\\/]+/u)) {
    if (!part || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part.toLowerCase());
  }
  return parts.join('/');
}

function mcpName(tool: string): string {
  const match = /^mcp__jarvis-desktop__(.+)$/u.exec(tool);
  return match?.[1] ?? '';
}

function clip(value: string): string {
  const flat = value.replace(/\s+/gu, ' ').trim();
  return flat.length > 120 ? `${flat.slice(0, 117)}…` : flat;
}
