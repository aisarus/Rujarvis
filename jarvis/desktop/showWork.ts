/**
 * На виду или в фоне — так, чтобы об этом знал и MCP-сервер.
 *
 * Режим человек переключает голосом: «работай в фоне», «показывай всё». До
 * сих пор это доезжало только до промта — то есть было СОВЕТОМ модели, а не
 * правилом для рук. Браузер выводил окно вперёд всегда, чем бы человек ни
 * просил: сказал «работай тихо», а ему под руки всё равно выскакивала вкладка.
 *
 * MCP-сервер — отдельный процесс, и переменной окружения тут не хватит: режим
 * меняется посреди работы, а окружение у запущенного процесса уже не поменять.
 * Поэтому файл, тем же приёмом, что план и ящик правок: мост пишет, сервер
 * читает перед действием.
 *
 * Файл может не существовать, быть пустым или битым — и всё это значит «на
 * виду». Это не лень: человек просил показывать по умолчанию, и молчаливый
 * уход в фон из-за битого файла он воспримет как поломку.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { jarvisDataRoot } from '../setup/paths';

/** Где лежит режим. Переопределяется, как и всё остальное общее. */
export function showWorkFile(env: Record<string, string | undefined> = process.env): string {
  const явно = env.JARVIS_SHOW_WORK_FILE?.trim();
  if (явно) return явно;
  return path.join(jarvisDataRoot(env), 'show-work.json');
}

/** Прочитать режим. Что угодно непонятное — «на виду». */
export function readShowWork(file = showWorkFile()): boolean {
  try {
    const прочитано = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    if (typeof прочитано === 'object' && прочитано !== null && 'showWork' in прочитано) {
      return (прочитано as { showWork: unknown }).showWork !== false;
    }
    return true;
  } catch {
    // Нет файла, пустой, битый — всё это «на виду». Уйти в фон молча из-за
    // битого файла хуже, чем показать лишнее окно.
    return true;
  }
}

/**
 * Записать режим. `false` — не записалось, и врать об этом нельзя.
 *
 * Если запись не удалась, сервер продолжит работать по-старому, и человек
 * должен это услышать: он сказал «работай тихо», а окна будут открываться.
 */
export function writeShowWork(показывать: boolean, file = showWorkFile()): boolean {
  try {
    writeFileSync(file, JSON.stringify({ showWork: показывать }), 'utf8');
    return true;
  } catch (беда) {
    console.error(
      `[jarvis] режим работы не записался: ${беда instanceof Error ? беда.message : String(беда)}`,
    );
    return false;
  }
}
