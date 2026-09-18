/**
 * World state.
 *
 * «Закрой это окно», «нажми вторую кнопку», «нет, другой файл» — none of these
 * mean anything without knowing what is on screen and what just happened. This
 * module keeps that picture and turns it into the few lines of context a
 * backend actually needs.
 *
 * The platform query itself is injected. On Windows the Workstation's
 * computer-use driver already knows the foreground window; Jarvis does not
 * open a second way of asking.
 */

export interface WindowInfo {
  id?: string;
  title: string;
  app: string;
  /** Milliseconds since epoch when this window was last in the foreground. */
  lastActiveAt?: number;
}

export interface BrowserTabInfo {
  title: string;
  url: string;
}

export interface SpawnedProcessInfo {
  pid: number;
  command: string;
  startedAt: number;
}

export interface WorldState {
  foregroundApp?: string;
  activeWindow?: WindowInfo;
  /** Most recently used first, active window excluded. */
  recentWindows: WindowInfo[];
  currentBrowserTab?: BrowserTabInfo;
  currentProject?: string;
  currentProjectPath?: string;
  runningTaskIds: string[];
  previousUtterance?: string;
  previousResult?: { text: string; ok: boolean; backend: string };
  recentFiles: string[];
  spawnedProcesses: SpawnedProcessInfo[];
  updatedAt: number;
}

export const EMPTY_WORLD_STATE: WorldState = {
  recentWindows: [],
  runningTaskIds: [],
  recentFiles: [],
  spawnedProcesses: [],
  updatedAt: 0,
};

/** Supplies the parts of the world only the desktop can see. */
export interface DesktopObserver {
  activeWindow(): Promise<WindowInfo | null>;
  recentWindows?(): Promise<WindowInfo[]>;
  currentBrowserTab?(): Promise<BrowserTabInfo | null>;
}

export interface WorldStateStoreOptions {
  observer?: DesktopObserver;
  /** How many recent windows and files to keep. */
  historyLimit?: number;
  now?: () => number;
}

export class WorldStateStore {
  private state: WorldState = { ...EMPTY_WORLD_STATE };
  private readonly now: () => number;

  constructor(private readonly options: WorldStateStoreOptions = {}) {
    this.now = options.now ?? Date.now;
  }

  snapshot(): WorldState {
    return {
      ...this.state,
      recentWindows: [...this.state.recentWindows],
      runningTaskIds: [...this.state.runningTaskIds],
      recentFiles: [...this.state.recentFiles],
      spawnedProcesses: [...this.state.spawnedProcesses],
    };
  }

  /** Pulls the desktop-visible parts. Never throws: a stale picture beats none. */
  async refresh(): Promise<WorldState> {
    const observer = this.options.observer;
    if (observer) {
      try {
        const active = await observer.activeWindow();
        if (active) this.setActiveWindow(active);
      } catch {
        // Keep the previous window; the platform query can fail transiently.
      }
      try {
        const tab = await observer.currentBrowserTab?.();
        if (tab) this.state.currentBrowserTab = tab;
      } catch {
        // Same.
      }
      try {
        const windows = await observer.recentWindows?.();
        if (windows && windows.length > 0) {
          this.state.recentWindows = windows
            .filter((window) => window.title !== this.state.activeWindow?.title)
            .slice(0, this.options.historyLimit ?? 8);
        }
      } catch {
        // Same.
      }
    }
    this.state.updatedAt = this.now();
    return this.snapshot();
  }

  setActiveWindow(window: WindowInfo): void {
    const previous = this.state.activeWindow;
    if (previous && previous.title !== window.title) {
      this.state.recentWindows = [
        { ...previous, lastActiveAt: this.now() },
        ...this.state.recentWindows.filter((entry) => entry.title !== previous.title),
      ].slice(0, this.options.historyLimit ?? 8);
    }
    this.state.activeWindow = { ...window, lastActiveAt: this.now() };
    this.state.foregroundApp = window.app;
    this.state.updatedAt = this.now();
  }

  setProject(name: string | undefined, path?: string): void {
    this.state.currentProject = name;
    this.state.currentProjectPath = path;
    this.state.updatedAt = this.now();
  }

  setBrowserTab(tab: BrowserTabInfo | undefined): void {
    this.state.currentBrowserTab = tab;
    this.state.updatedAt = this.now();
  }

  noteUtterance(utterance: string): void {
    this.state.previousUtterance = utterance;
    this.state.updatedAt = this.now();
  }

  noteResult(result: { text: string; ok: boolean; backend: string }): void {
    this.state.previousResult = {
      text: result.text.slice(0, 2000),
      ok: result.ok,
      backend: result.backend,
    };
    this.state.updatedAt = this.now();
  }

  noteFile(filePath: string): void {
    this.state.recentFiles = [
      filePath,
      ...this.state.recentFiles.filter((entry) => entry !== filePath),
    ].slice(0, this.options.historyLimit ?? 8);
    this.state.updatedAt = this.now();
  }

  noteProcess(info: SpawnedProcessInfo): void {
    this.state.spawnedProcesses = [
      info,
      ...this.state.spawnedProcesses.filter((entry) => entry.pid !== info.pid),
    ].slice(0, this.options.historyLimit ?? 8);
  }

  forgetProcess(pid: number): void {
    this.state.spawnedProcesses = this.state.spawnedProcesses.filter((entry) => entry.pid !== pid);
  }

  setRunningTasks(ids: readonly string[]): void {
    this.state.runningTaskIds = [...ids];
    this.state.updatedAt = this.now();
  }
}

/**
 * Turns the world state into the lines a backend should see.
 *
 * Only what the request needs: an utterance full of «это» and «продолжай» gets
 * the window and the last result; a fully specified request gets almost
 * nothing, because repeating the desktop into every prompt is noise.
 */
export function selectWorldStateLines(
  state: WorldState,
  options: { needsWorldState: boolean; limit?: number } = { needsWorldState: true },
): string[] {
  const lines: string[] = [];

  if (state.activeWindow) {
    lines.push(`Активное окно: ${state.activeWindow.title} (${state.activeWindow.app})`);
  }
  if (state.currentBrowserTab) {
    lines.push(`Вкладка браузера: ${state.currentBrowserTab.title} — ${state.currentBrowserTab.url}`);
  }
  if (state.currentProject) {
    lines.push(
      `Текущий проект: ${state.currentProject}${state.currentProjectPath ? ` (${state.currentProjectPath})` : ''}`,
    );
  }

  if (options.needsWorldState) {
    if (state.previousUtterance) {
      lines.push(`Предыдущая реплика пользователя: «${state.previousUtterance}»`);
    }
    if (state.previousResult) {
      lines.push(`Предыдущий результат (${state.previousResult.backend}): ${firstLine(state.previousResult.text)}`);
    }
    if (state.recentWindows.length > 0) {
      lines.push(`Недавние окна: ${state.recentWindows.slice(0, 3).map((window) => window.title).join('; ')}`);
    }
    if (state.recentFiles.length > 0) {
      lines.push(`Недавние файлы: ${state.recentFiles.slice(0, 3).join('; ')}`);
    }
  }

  return lines.slice(0, options.limit ?? 8);
}

function firstLine(text: string): string {
  const line = text.split(/\r?\n/).find((candidate) => candidate.trim().length > 0) ?? '';
  return line.trim().slice(0, 200);
}
