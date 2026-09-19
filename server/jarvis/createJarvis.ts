/**
 * Composition root for the Jarvis layer.
 *
 * Everything in `jarvis/` takes its dependencies as arguments so it can be
 * tested without a desktop, a microphone or a subscription. That design needs
 * exactly one place that actually wires the real implementations together, and
 * this is it — the function the Electron app calls to get a working assistant.
 */

import { BackendManager } from '../../jarvis/backends/manager';
import { ClaudeCodeBackend } from '../../jarvis/backends/claudeCode';
import { CodexBackend } from '../../jarvis/backends/codex';
import { InterpreterBackend } from '../../jarvis/backends/interpreter';
import {
  OpenAiCompatibleBackend,
  createHttpChatClient,
} from '../../jarvis/backends/openAiCompatible';
import {
  createWorkstationClaudeProbe,
  createWorkstationCodexProbe,
} from '../../jarvis/backends/workstationProbes';
import { WorldStateStore, type DesktopObserver } from '../../jarvis/context/worldState';
import {
  DEFAULT_JARVIS_SETTINGS,
  JarvisCore,
  type ApprovalRequest,
  type JarvisSettings,
} from '../../jarvis/core';
import { createFileMemoryStorage } from '../../jarvis/memory/fileStorage';
import { JarvisMemory } from '../../jarvis/memory/store';
import { LocalRouterModel } from '../../jarvis/router/localModel';
import { TaskManager } from '../../jarvis/tasks/manager';
import { createInterpreterRuntimeDriver } from './interpreterRuntimeDriver';

export interface LocalRouterConfig {
  /** e.g. http://127.0.0.1:11434/v1 for Ollama. */
  baseUrl: string;
  model: string;
  apiKey?: string;
}

export interface CreateJarvisOptions {
  /** Workspace headless runtime tasks run in. */
  workspace?: string;
  /** Reads the current settings. Called per turn, so changes take effect live. */
  settings?: () => JarvisSettings;
  /** Supplies the foreground window and browser tab. */
  desktopObserver?: DesktopObserver;
  /** Speaks a line. Omitted means text-only. */
  speak?(text: string): void;
  /** Asks the user to approve sensitive work. Omitted means such work is refused. */
  approve?(request: ApprovalRequest): Promise<boolean>;
  /** Optional small local model that refines routing. */
  localRouter?: LocalRouterConfig;
  /** Optional last-resort reasoning backend. */
  fallbackModel?: LocalRouterConfig;
  /** Model override for the coding backends. */
  claudeModel?: string;
  codexModel?: string;
  /**
   * Permits the CLIs' unrestricted modes. Off unless the user turned it on,
   * and never inferred from anything a model said.
   */
  allowUnrestrictedCli?: boolean;
  /**
   * Path to an MCP config giving the coding backend the screen and the mouse.
   *
   * Passed per run rather than registered for the whole machine, so the tools
   * reach Jarvis's own agent and not every Claude Code session the user opens.
   */
  desktopMcpConfig?: string;
  /**
   * Папка, в которой Джарвис живёт: его код, настройки, журнал, навыки.
   *
   * Агент получает её на чтение всегда — чтобы на вопрос о себе отвечать по
   * своим файлам, а не по догадкам.
   */
  homeDir?: string;
  /** Папка на рабочем столе, куда агент складывает готовые файлы. */
  outputDir?: string;
  /**
   * Журнал собственных действий — пассивная память.
   *
   * Передаётся функцией, а не объектом: ядру нужны только готовые строки, и
   * оно не должно знать ни про диск, ни про то, как они устроены.
   */
  recentActions?(): string[];
  /** Постоянные указания человека, читаемые на каждую задачу. */
  instructions?(): string | undefined;
  /** На чём уже спотыкались — собирается из журнала на каждую задачу. */
  lessons?(): string | undefined;
}

export interface Jarvis {
  core: JarvisCore;
  backends: BackendManager;
  tasks: TaskManager;
  memory: JarvisMemory;
  world: WorldStateStore;
  /** Loads persisted memory. Call once before the first utterance. */
  ready(): Promise<void>;
}

export function createJarvis(options: CreateJarvisOptions = {}): Jarvis {
  const backends = new BackendManager();

  backends.register(
    new InterpreterBackend({
      driver: createInterpreterRuntimeDriver({ defaultWorkspace: options.workspace }),
    }),
  );

  backends.register(
    new ClaudeCodeBackend({
      probe: createWorkstationClaudeProbe(),
      model: options.claudeModel,
      allowBypassPermissions: options.allowUnrestrictedCli === true,
      desktopMcpConfig: options.desktopMcpConfig,
      homeDir: options.homeDir,
    }),
  );

  backends.register(
    new CodexBackend({
      probe: createWorkstationCodexProbe(),
      model: options.codexModel,
      allowFullAccess: options.allowUnrestrictedCli === true,
    }),
  );

  if (options.fallbackModel) {
    backends.register(
      new OpenAiCompatibleBackend({
        id: 'local',
        model: options.fallbackModel.model,
        client: createHttpChatClient({
          baseUrl: options.fallbackModel.baseUrl,
          apiKey: options.fallbackModel.apiKey,
        }),
      }),
    );
  }

  const memory = new JarvisMemory({ storage: createFileMemoryStorage() });
  const world = new WorldStateStore({ observer: options.desktopObserver });
  const tasks = new TaskManager({ backends });

  // Keep the world state's view of running work current, so «продолжай» and
  // «стоп» have something accurate to refer to.
  tasks.subscribe(() => {
    world.setRunningTasks(tasks.active().map((task) => task.id));
  });

  const localRouter = options.localRouter
    ? new LocalRouterModel({
        model: options.localRouter.model,
        client: createHttpChatClient({
          baseUrl: options.localRouter.baseUrl,
          apiKey: options.localRouter.apiKey,
          timeoutMs: 2_000,
        }),
      })
    : undefined;

  const core = new JarvisCore({
    backends,
    tasks,
    memory,
    world,
    localRouter,
    settings: options.settings ?? (() => DEFAULT_JARVIS_SETTINGS),
    speak: options.speak,
    approve: options.approve,
    outputDir: options.outputDir,
    recentActions: options.recentActions,
    instructions: options.instructions,
    lessons: options.lessons,
  });

  return {
    core,
    backends,
    tasks,
    memory,
    world,
    ready: async () => {
      await memory.load();
      if (options.workspace) {
        world.setProject(undefined, options.workspace);
      }
      await world.refresh();
    },
  };
}
