import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { jarvisPaths } from '../jarvis/setup/paths';
import { SettingsStore } from '../jarvis/setup/settings';

/**
 * Сохранение настроек возвращает странице устаревшую половину состояния.
 *
 * Язык интерфейса страница переключает сама, а описания моделей распознавания
 * и путь к папке результатов считает главный процесс — и раньше в ответ на
 * сохранение он присылал одни настройки. Замер 25.09.2026 в живом окне:
 * переключаем язык на English на вкладке «Общие», идём на «Речь» — все пять
 * описаний моделей по-русски; на «Папках» путь показан как
 * `…\Desktop\Джарвис`, а кнопка «Открыть» открывает `…\Desktop\Jarvis`,
 * потому что главный процесс берёт язык заново. Надпись врала, пока окно не
 * закроют и не откроют снова.
 */

const стенд = vi.hoisted(() => ({
  обработчики: new Map<string, (событие: unknown, ...аргументы: never[]) => unknown>(),
}));

vi.mock('electron', () => {
  class BrowserWindow {
    webContents = { send: () => {} };
    once(): void {}
    on(): void {}
    isDestroyed(): boolean {
      return false;
    }
    show(): void {}
    focus(): void {}
    loadFile(): Promise<void> {
      return Promise.resolve();
    }
  }
  return {
    app: { getPath: () => path.join(os.tmpdir(), 'рабочий-стол') },
    BrowserWindow,
    dialog: { showOpenDialog: () => Promise.resolve({ canceled: true, filePaths: [] }) },
    ipcMain: {
      handle: (канал: string, обработчик: (событие: unknown, ...аргументы: never[]) => unknown) => {
        стенд.обработчики.set(канал, обработчик);
      },
    },
    session: { defaultSession: { setPermissionRequestHandler: () => {} } },
    shell: { openPath: () => Promise.resolve(''), openExternal: () => Promise.resolve() },
  };
});

// Пробы CLI запускают процессы: в этом тесте проверяется не они.
vi.mock('../jarvis/backends/cliProbes', () => ({
  cliStatus: async () => ({ installed: false, loggedIn: false }),
  createClaudeProbe: () => ({ status: async () => ({ installed: false, loggedIn: false }) }),
  createCodexProbe: () => ({ status: async () => ({ installed: false, loggedIn: false }) }),
}));

async function окно() {
  const дом = mkdtempSync(path.join(os.tmpdir(), 'jarvis-settings-test-'));
  const paths = jarvisPaths({ JARVIS_HOME: дом }, 'win32');
  const settings = new SettingsStore(paths.settings);
  settings.update({ onboarded: true, language: 'ru' });
  const { openSettingsWindow, SETTINGS_CHANNEL } = await import('./settingsWindow');
  openSettingsWindow({ settings, paths, onFinished: () => {}, onSettingsChanged: () => {} });
  const update = стенд.обработчики.get(`${SETTINGS_CHANNEL}:update`);
  const state = стенд.обработчики.get(`${SETTINGS_CHANNEL}:state`);
  if (!update || !state) throw new Error('обработчики не зарегистрированы');
  return { update, state, settings };
}

describe('окно настроек', () => {
  it('на сохранение отдаёт всё, что зависит от настроек, а не одни настройки', async () => {
    const { update } = await окно();
    const ответ = (await update(null, { language: 'en' } as never)) as Record<string, unknown>;
    expect(Object.keys(ответ).sort()).toEqual(['paths', 'settings', 'voices', 'whisper']);
  });

  it('после смены языка описания моделей и путь приходят на новом языке', async () => {
    const { update } = await окно();

    const поРусски = (await update(null, { language: 'ru' } as never)) as {
      whisper: Array<{ description: string }>;
      paths: { output: string };
    };
    expect(поРусски.whisper[0]?.description).toMatch(/[А-Яа-я]/u);
    expect(поРусски.paths.output.endsWith('Джарвис')).toBe(true);

    const поАнглийски = (await update(null, { language: 'en' } as never)) as {
      whisper: Array<{ description: string }>;
      paths: { output: string };
    };
    expect(поАнглийски.whisper[0]?.description).not.toMatch(/[А-Яа-я]/u);
    expect(поАнглийски.paths.output.endsWith('Jarvis')).toBe(true);
  });

  it('полное состояние по-прежнему несёт строки, пробы и площадку', async () => {
    const { state } = await окно();
    const ответ = (await state(null)) as Record<string, unknown>;
    expect(Object.keys(ответ).sort()).toEqual([
      'agents',
      'paths',
      'platform',
      'settings',
      'strings',
      'voices',
      'whisper',
    ]);
  });
});
