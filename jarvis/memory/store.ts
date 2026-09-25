/**
 * Jarvis memory.
 *
 * The Workstation already persists conversations, threads and sessions. This
 * is the small, structured layer on top that makes short Russian speech work:
 * once the user has said «Aegis → D:\Projects\aegis» one time, «аегис» is
 * enough forever after.
 *
 * The constraint that shapes it: memory must not become a giant prompt. It is
 * queried, not dumped — {@link JarvisMemory.selectRelevant} returns only the
 * entries an utterance actually touches.
 */

import type { KnownProject } from '../router/router';
import { tokenize } from '../router/text';

export interface TaskMemory {
  id: string;
  /** What the user said, verbatim. */
  utterance: string;
  /** One-line outcome, as it was reported back. */
  outcome: string;
  ok: boolean;
  backend: string;
  project?: string;
  finishedAt: number;
  /** Backend session id, so «продолжай» can resume the vendor's own thread. */
  sessionId?: string;
}

export interface AppAlias {
  /** What the user says: «спотифай». */
  spoken: string;
  /** What to launch: "Spotify" or a full path. */
  target: string;
}

export interface MemorySnapshot {
  projects: KnownProject[];
  apps: AppAlias[];
  recentTasks: TaskMemory[];
  /** Free-form user preferences, e.g. preferred browser. */
  preferences: Record<string, string>;
}

export interface MemoryStorage {
  load(): Promise<MemorySnapshot | null>;
  save(snapshot: MemorySnapshot): Promise<void>;
}

export const EMPTY_SNAPSHOT: MemorySnapshot = {
  projects: [],
  apps: [],
  recentTasks: [],
  preferences: {},
};

export interface JarvisMemoryOptions {
  storage?: MemoryStorage;
  /** How many finished tasks to keep. Older ones are dropped. */
  taskHistoryLimit?: number;
  now?: () => number;
}

function sameName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

export class JarvisMemory {
  private snapshot: MemorySnapshot = { ...EMPTY_SNAPSHOT };
  private loaded = false;
  /** Почему не прочиталась прошлая память. Пусто — прочиталась. */
  private загрузкаНеУдалась = '';
  private readonly now: () => number;

  constructor(private readonly options: JarvisMemoryOptions = {}) {
    this.now = options.now ?? Date.now;
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    if (!this.options.storage) return;
    try {
      const loaded = await this.options.storage.load();
      if (loaded) {
        this.snapshot = {
          projects: loaded.projects ?? [],
          apps: loaded.apps ?? [],
          recentTasks: loaded.recentTasks ?? [],
          preferences: loaded.preferences ?? {},
        };
      }
    } catch (error) {
      // Нечитаемая память не должна мешать Джарвису запуститься — но и писать
      // поверх неё пустой снимок нельзя.
      //
      // Раньше отказ чтения давал пустую память, и первая же запись сохраняла
      // её поверх файла: проекты, псевдонимы и предпочтения человека
      // пропадали молча. Файл мог всего лишь оказаться занят.
      this.загрузкаНеУдалась = error instanceof Error ? error.message : String(error);
      console.error(`[jarvis] память не прочиталась: ${this.загрузкаНеУдалась}`);
    }
  }

  /**
   * Сохранить. Возвращает, дошло ли до диска.
   *
   * Раньше отказ записи глотался, и `rememberProject` отвечал обычным
   * успехом: Джарвис говорил «запомнил», а после перезапуска псевдонима не
   * было. Человек узнавал об этом, когда «аегис» переставал пониматься.
   */
  private async persist(): Promise<boolean> {
    if (!this.options.storage) return true;
    if (this.загрузкаНеУдалась) {
      // Пока не знаем, что было в файле, писать туда нечего: это стёрло бы
      // всё, чего мы не прочитали.
      console.error('[jarvis] память не сохранена: прошлое содержимое не прочиталось');
      return false;
    }
    try {
      await this.options.storage.save(this.snapshot);
      return true;
    } catch (error) {
      console.error(`[jarvis] память не сохранена: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  get projects(): readonly KnownProject[] {
    return this.snapshot.projects;
  }

  get apps(): readonly AppAlias[] {
    return this.snapshot.apps;
  }

  get preferences(): Readonly<Record<string, string>> {
    return this.snapshot.preferences;
  }

  get recentTasks(): readonly TaskMemory[] {
    return this.snapshot.recentTasks;
  }

  /** Records «Aegis → D:\Projects\aegis», merging aliases with what is known. */
  async rememberProject(project: KnownProject): Promise<void> {
    const existing = this.snapshot.projects.find((candidate) => sameName(candidate.name, project.name));
    if (existing) {
      existing.path = project.path;
      const aliases = new Set([...(existing.aliases ?? []), ...(project.aliases ?? [])]);
      existing.aliases = [...aliases];
    } else {
      this.snapshot.projects = [...this.snapshot.projects, { ...project }];
    }
    await this.persist();
  }

  async rememberApp(alias: AppAlias): Promise<void> {
    const existing = this.snapshot.apps.find((candidate) => sameName(candidate.spoken, alias.spoken));
    if (existing) {
      existing.target = alias.target;
    } else {
      this.snapshot.apps = [...this.snapshot.apps, { ...alias }];
    }
    await this.persist();
  }

  async rememberPreference(key: string, value: string): Promise<void> {
    this.snapshot.preferences = { ...this.snapshot.preferences, [key]: value };
    await this.persist();
  }

  async recordTask(task: Omit<TaskMemory, 'finishedAt'> & { finishedAt?: number }): Promise<void> {
    const limit = this.options.taskHistoryLimit ?? 30;
    const entry: TaskMemory = { ...task, finishedAt: task.finishedAt ?? this.now() };
    this.snapshot.recentTasks = [entry, ...this.snapshot.recentTasks].slice(0, limit);
    await this.persist();
  }

  /** The most recent task, which is what «продолжай» refers to. */
  lastTask(): TaskMemory | undefined {
    return this.snapshot.recentTasks[0];
  }

  findProject(name: string): KnownProject | undefined {
    const wanted = name.trim().toLowerCase();
    return this.snapshot.projects.find(
      (project) =>
        project.name.toLowerCase() === wanted ||
        (project.aliases ?? []).some((alias) => alias.toLowerCase() === wanted),
    );
  }

  findApp(spoken: string): AppAlias | undefined {
    const tokens = tokenize(spoken);
    return this.snapshot.apps.find((app) => {
      const aliasTokens = tokenize(app.spoken);
      return aliasTokens.length > 0 && aliasTokens.every((token) => tokens.includes(token));
    });
  }

  /**
   * The entries this utterance actually touches, as prompt-ready lines.
   *
   * Bounded on purpose: a handful of relevant lines beats the whole store, and
   * an assistant that pastes its entire memory into every request is slower,
   * more expensive and easier to confuse.
   */
  selectRelevant(utterance: string, limit = 6): string[] {
    const tokens = tokenize(utterance);
    const lines: string[] = [];

    for (const project of this.snapshot.projects) {
      const names = [project.name, ...(project.aliases ?? [])];
      const mentioned = names.some((name) => {
        const stem = tokenize(name)[0];
        if (!stem) return false;
        const probe = stem.length > 4 ? stem.slice(0, stem.length - 1) : stem;
        return tokens.some((token) => token.startsWith(probe));
      });
      if (mentioned) lines.push(`Проект ${project.name}: ${project.path}`);
    }

    for (const app of this.snapshot.apps) {
      const aliasTokens = tokenize(app.spoken);
      if (aliasTokens.length > 0 && aliasTokens.every((token) => tokens.includes(token))) {
        lines.push(`Приложение «${app.spoken}» — ${app.target}`);
      }
    }

    const last = this.lastTask();
    if (last) {
      lines.push(
        `Последняя задача: «${last.utterance}» — ${last.ok ? 'выполнена' : 'не выполнена'} (${last.outcome})`,
      );
    }

    return lines.slice(0, limit);
  }

  /** The projects the router should match against. */
  knownProjects(): KnownProject[] {
    return this.snapshot.projects.map((project) => ({ ...project }));
  }

  toJSON(): MemorySnapshot {
    return {
      projects: this.snapshot.projects.map((project) => ({ ...project })),
      apps: this.snapshot.apps.map((app) => ({ ...app })),
      recentTasks: [...this.snapshot.recentTasks],
      preferences: { ...this.snapshot.preferences },
    };
  }
}
