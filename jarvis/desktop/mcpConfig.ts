/**
 * Конфиг MCP, который даёт агенту экран, мышь и файлы.
 *
 * Вынесен из `app/voiceBridge.ts`, чтобы его звали и приложение, и живая
 * проверка агента. Проверке нельзя держать свою копию: 26.09.2026 выяснилось,
 * что `jarvis:try` создаёт Джарвиса вовсе без этого конфига и без хука красных
 * линий — то есть путь «агент → инструменты окон → хук», на котором у человека
 * «управление окнами отказывало», не проверяла ни одна проверка.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { Language } from '../locale/language';
import { resolveDesktopMcpLaunch } from './launch';

export interface DesktopMcpConfigOptions {
  /** Корень приложения: от него ищется собранный MCP-сервер. */
  appRoot: string;
  /** Папка данных Джарвиса: там журнал, ящик правок и план. */
  dataDir: string;
  /** Куда агент складывает результаты. */
  outputDir?: string;
  language: Language;
}

export type DesktopMcpConfig =
  | { ok: true; file: string; server: string }
  | { ok: false; missing: string }
  | { ok: false; error: unknown };

/**
 * Записать конфиг во временную папку и вернуть путь к нему.
 *
 * Генерируется, а не лежит в поставке: в нём абсолютный путь к серверу. Нет
 * сервера — `missing`, и управление экраном просто отсутствует, а не падает
 * посреди задачи.
 */
export function writeDesktopMcpConfig(options: DesktopMcpConfigOptions): DesktopMcpConfig {
  const server = resolveDesktopMcpLaunch({ appRoot: options.appRoot });
  if (!server.ok) return { ok: false, missing: server.missing };

  try {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'jarvis-mcp-'));
    const file = path.join(dir, 'desktop.json');
    writeFileSync(
      file,
      JSON.stringify({
        mcpServers: {
          'jarvis-desktop': {
            type: 'stdio',
            command: server.launch.command,
            args: server.launch.args,
            // Сервер — отдельный процесс и сам рабочего стола не знает. Без
            // этой переменной его файловые инструменты складывали бы результат
            // не туда, где человек его ищет.
            env: {
              ...server.launch.env,
              ...(options.outputDir ? { JARVIS_OUTPUT_DIR: options.outputDir } : {}),
              JARVIS_LANGUAGE: options.language,
              // Движок браузера — явно, а не «авось доедет».
              //
              // Промт собирает это приложение, а выбирает движок MCP-сервер:
              // два процесса, и если переменная до второго не дойдёт, промт
              // расскажет модели про Safari, а руки поведут Chromium. Правило
              // то же, что у языка и журнала: общее передаётся, а не
              // угадывается.
              ...(process.env.JARVIS_BROWSER ? { JARVIS_BROWSER: process.env.JARVIS_BROWSER } : {}),
              // Журнал тот же самый: агент должен видеть ровно то, что помнит
              // сам Джарвис, а не собственную отдельную.
              JARVIS_JOURNAL: path.join(options.dataDir, 'journal.json'),
              // Ящик правок: сюда мост кладёт сказанное во время работы, отсюда
              // агент забирает его инструментом check_notes.
              JARVIS_NOTES: path.join(options.dataDir, 'notes.json'),
              // План работы: агент его пишет, окно его показывает.
              JARVIS_PLAN: path.join(options.dataDir, 'plan.json'),
              // Заметки агента между запусками — там же, где всё остальное.
              JARVIS_AGENT_NOTES: path.join(options.dataDir, 'agent-notes.json'),
            },
          },
        },
      }),
      'utf8',
    );
    return { ok: true, file, server: server.launch.args[0] ?? server.launch.command };
  } catch (error) {
    return { ok: false, error };
  }
}
