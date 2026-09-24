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

/** Надписи кнопок, за которыми деньги. */
const PAYMENT_LABEL = /оплат|купить|покупк|заказ|перевест|перевод\b|pay\b|payment|buy\b|purchase|checkout|place order|subscribe/iu;
/** Надписи кнопок, за которыми сообщение другим людям. */
const SEND_LABEL = /отправ|опубликова|написать\b|send\b|post\b|publish|tweet|reply\b/iu;
/** Поля, в которые вводят платёжные данные и пароли. */
const SECRET_FIELD = /карт|card|cvv|cvc|парол|password|пин|pin\b/iu;

/** Файлы, открытие которых запускает программу. */
const EXECUTABLE = /\.(exe|bat|cmd|com|ps1|vbs|vbe|js|jse|wsf|msi|msix|scr|lnk|reg|hta|jar)$/iu;

export function classifyToolUse(tool: string, input: Input, context: GateContext): ToolRisk {
  const text = (key: string): string => (typeof input[key] === 'string' ? (input[key] as string) : '');

  if (SHELL_TOOLS.has(tool)) {
    const command = text('command');
    return {
      level: classifyAction({ kind: 'shell', command, insideProject: true }),
      summary: `Агент хочет выполнить команду: ${clip(command)}.`,
    };
  }

  if (WRITE_TOOLS.has(tool)) {
    const file = text('file_path') || text('notebook_path');
    return {
      level: classifyAction(writeAction(file, context)),
      summary: `Агент хочет изменить файл ${file}.`,
    };
  }

  switch (mcpName(tool)) {
    case 'browser_click': {
      const label = text('text');
      return labelRisk(label, `Агент хочет нажать «${clip(label)}» в браузере.`);
    }
    case 'browser_fill': {
      const label = text('label');
      const summary = `Агент хочет ввести данные в поле «${clip(label)}».`;
      if (SECRET_FIELD.test(label)) return { level: 'sensitive', summary };
      return labelRisk(label, summary);
    }
    case 'write_skill':
      // Навык ложится в общие навыки Claude Code и действует во всех его
      // сессиях человека, не только в работе Джарвиса.
      return {
        level: 'sensitive',
        summary: `Агент хочет записать навык «${clip(text('name'))}» в общие навыки Claude Code.`,
      };
    case 'show_file': {
      const file = text('file');
      if (input.open === true && EXECUTABLE.test(file)) {
        return { level: 'sensitive', summary: `Агент хочет запустить ${file}.` };
      }
      return { level: 'safe', summary: '' };
    }
    case 'move_to_output': {
      const file = text('file');
      return {
        level: within(file, workRoots(context)) ? 'normal' : 'sensitive',
        summary: `Агент хочет перенести ${file} в папку результатов.`,
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
