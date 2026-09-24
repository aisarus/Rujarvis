/**
 * Как запустить MCP-сервер рабочего стола.
 *
 * Раньше сервер запускался только через `desktop-mcp.cmd`, который лежал у
 * автора на машине и которого не создавал ни установщик, ни сборка. На свежей
 * установке управление экраном поэтому молча выключалось.
 *
 * Теперь по умолчанию запускается собранный `dist/jarvis/desktop/mcp.cjs`
 * тем же исполняемым файлом, что запустил приложение: у Electron это режим
 * `ELECTRON_RUN_AS_NODE`, у `tsx`/node — обычный node. Отдельный Node в PATH
 * не нужен. `JARVIS_DESKTOP_MCP` оставлен для явной подмены сервера.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';

export interface McpLaunch {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export type McpLaunchResult = { ok: true; launch: McpLaunch } | { ok: false; missing: string };

export interface McpLaunchOptions {
  /** Корень приложения: там лежит `dist`. */
  appRoot: string;
  env?: Record<string, string | undefined>;
  /** Исполняемый файл, которым запускать сборку. */
  runtime?: string;
  /** Запущены ли мы внутри Electron. */
  electron?: boolean;
  exists?: (file: string) => boolean;
}

export function desktopMcpBundle(appRoot: string): string {
  return path.join(appRoot, 'dist', 'jarvis', 'desktop', 'mcp.cjs');
}

export function resolveDesktopMcpLaunch(options: McpLaunchOptions): McpLaunchResult {
  const env = options.env ?? process.env;
  const exists = options.exists ?? existsSync;

  const override = env.JARVIS_DESKTOP_MCP?.trim();
  if (override) {
    return exists(override)
      ? { ok: true, launch: { command: override, args: [], env: {} } }
      : { ok: false, missing: override };
  }

  const bundle = desktopMcpBundle(options.appRoot);
  if (!exists(bundle)) return { ok: false, missing: bundle };

  const electron = options.electron ?? Boolean(process.versions.electron);
  return {
    ok: true,
    launch: {
      command: options.runtime ?? process.execPath,
      args: [bundle],
      env: electron ? { ELECTRON_RUN_AS_NODE: '1' } : {},
    },
  };
}
