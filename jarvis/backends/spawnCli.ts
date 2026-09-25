/**
 * Запуск CLI так, чтобы он правда запустился.
 *
 * ## Почему это отдельный модуль
 *
 * На Windows `claude` и `codex`, поставленные через npm, pnpm или yarn, — это
 * `claude.cmd`. С исправления CVE-2024-27980 (Node 18.20.2 и 20.12.2) Node
 * ОТКАЗЫВАЕТСЯ запускать `.cmd` и `.bat` без оболочки: `spawn EINVAL`. Проекту
 * нужен Node 22, то есть отказ гарантирован. Проба версии оболочку включала, а
 * настоящие запуски — нет: человек видел «Claude Code готов», а каждая задача
 * кончалась «Не удалось запустить».
 *
 * ## Почему кавычки вручную
 *
 * При `shell: true` Node склеивает команду и аргументы в одну строку и ничего
 * не экранирует. Путь `C:\Users\Иван Петров\AppData\Roaming\npm\claude.cmd`
 * доезжал до cmd.exe как команда `C:\Users\Иван`. Пути с пробелами и
 * кириллицей здесь норма, а не редкость.
 *
 * Поэтому под оболочку уходит одна готовая строка, а список аргументов пуст.
 * Это не только честнее — иначе Node печатает DEP0190 на каждый запуск:
 * «args with shell option are not escaped, only concatenated». Предупреждение
 * ровно про то, что здесь уже сделано руками, но отличить сделанное от
 * несделанного оно не умеет и просто шумит в журнале.
 */

/** Нужна ли оболочка, чтобы запустить этот файл. */
export function needsShell(command: string): boolean {
  return process.platform === 'win32' && /\.(cmd|bat)$/iu.test(command);
}

/** Обернуть в кавычки то, что без них развалится на пробеле. */
function quote(value: string): string {
  if (!/[\s&|<>^]/u.test(value)) return value;
  // Внутренние кавычки удваиваются — так их понимает cmd.exe.
  return `"${value.split('"').join('""')}"`;
}

/**
 * Команда и аргументы, пригодные для `spawn`.
 *
 * Для обычного файла возвращает их как есть: оболочка не нужна, и лишнее
 * экранирование только навредит.
 */
export function cliLaunch(
  command: string,
  args: readonly string[],
): { command: string; args: string[]; shell: boolean } {
  if (!needsShell(command)) return { command, args: [...args], shell: false };
  return { command: [command, ...args].map(quote).join(' '), args: [], shell: true };
}
