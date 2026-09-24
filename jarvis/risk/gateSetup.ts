/**
 * Подготовка хука красных линий к запуску агента.
 *
 * Хук — роль `gate` той же сборки, что MCP-сервер рабочего стола
 * (`desktop/serve.ts`). Его запускает Claude Code, поэтому команда — строка
 * для оболочки: обычный `node` и пути с прямыми косыми, которые одинаково
 * понимают cmd, PowerShell и bash из Git for Windows.
 *
 * `node` нужен в PATH. Для установки из исходников он есть всегда — на нём
 * собирается и запускается само приложение. Если его нет, хук не ставится, и
 * агент работает без инструментов, которыми линию можно перейти молча.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { desktopMcpBundle } from '../desktop/launch';
import type { Language } from '../locale/language';
import { gateSettings, type GateConfig } from './gateHook';

export interface GateSetupOptions {
  appRoot: string;
  /** Папка данных Джарвиса: там лежит папка моста вопросов. */
  dataDir: string;
  outputDir?: string;
  homeDir?: string;
  language?: Language;
  exists?: (file: string) => boolean;
  nodeAvailable?: () => boolean;
  tempRoot?: string;
}

export type GateSetup = { ok: true; settings: string; bridgeDir: string } | { ok: false; reason: string };

export function prepareGate(options: GateSetupOptions): GateSetup {
  const exists = options.exists ?? existsSync;
  const bundle = desktopMcpBundle(options.appRoot);
  if (!exists(bundle)) return { ok: false, reason: `нет сборки ${bundle}` };
  if (!(options.nodeAvailable ?? hasNode)()) return { ok: false, reason: 'node не найден в PATH' };

  const bridgeDir = path.join(options.dataDir, 'gate');
  mkdirSync(bridgeDir, { recursive: true });

  const dir = mkdtempSync(path.join(options.tempRoot ?? os.tmpdir(), 'jarvis-gate-'));
  const configFile = path.join(dir, 'gate.json');
  const config: GateConfig = {
    bridgeDir,
    outputDir: options.outputDir,
    homeDir: options.homeDir,
    language: options.language,
  };
  writeFileSync(configFile, JSON.stringify(config), 'utf8');

  const settings = path.join(dir, 'settings.json');
  const command = `node "${forward(bundle)}" gate "${forward(configFile)}"`;
  writeFileSync(settings, JSON.stringify(gateSettings(command)), 'utf8');
  return { ok: true, settings, bridgeDir };
}

function forward(file: string): string {
  return file.replace(/\\/gu, '/');
}

function hasNode(): boolean {
  try {
    return spawnSync('node', ['--version'], { windowsHide: true, timeout: 10_000 }).status === 0;
  } catch {
    return false;
  }
}
