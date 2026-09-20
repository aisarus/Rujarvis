/**
 * Talking to the desktop: mouse, keyboard, screen, windows.
 *
 * The work itself is done by a PowerShell process that stays alive and takes
 * commands as JSON lines. Starting PowerShell and compiling its P/Invoke types
 * costs several hundred milliseconds — fine once, absurd per click — so the
 * process is started on first use and kept.
 *
 * Everything here returns a result rather than throwing into the caller's lap:
 * an agent that is told "the click failed" can try something else, while an
 * agent that is told nothing repeats itself forever.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import type { UiElement } from '../control/elements';

export type { UiElement };

export interface ScreenBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DesktopWindow {
  title: string;
  x: number;
  y: number;
  width: number;
  height: number;
  pid: number;
  focused: boolean;
}

type Command = Record<string, unknown> & { cmd: string };

/**
 * Где лежит скрипт драйвера.
 *
 * Этот модуль живёт в двух мирах сразу. В MCP-сервере он запускается через
 * tsx как ESM, и `import.meta.url` работает. В приложении он попадает в сборку
 * Electron, которая собирается в CJS, и там `import.meta.url` **пустой** —
 * `fileURLToPath` падает прямо при загрузке модуля, унося с собой весь
 * голосовой слой. Ровно это здесь и случилось: Джарвис переставал
 * запускаться целиком из-за одной строки поиска файла.
 *
 * Поэтому путь не вычисляется, а ищется среди известных мест: первое
 * существующее и берётся.
 */
function findDriverScript(): string {
  const explicit = process.env.JARVIS_DESKTOP_DRIVER?.trim();
  if (explicit) return explicit;

  const candidates: string[] = [];

  // Рядом с собой — так это выглядит из исходников (MCP-сервер, tsx).
  if (typeof __dirname === 'string') {
    candidates.push(path.join(__dirname, 'win32-driver.ps1'));
    // Из собранного приложения: dist-electron/electron -> исходники проекта.
    candidates.push(path.join(__dirname, '..', '..', 'jarvis', 'desktop', 'win32-driver.ps1'));
  }

  // От рабочего каталога — запасной путь для запуска из корня проекта.
  candidates.push(path.join(process.cwd(), 'jarvis', 'desktop', 'win32-driver.ps1'));

  for (const candidate of candidates) {
    if (existsSync(candidate)) return path.resolve(candidate);
  }

  // Ничего не нашли — возвращаем самый вероятный, чтобы ошибка была понятной
  // («файл не найден по такому пути»), а не «path must be a string».
  return path.resolve(candidates[candidates.length - 1] as string);
}

const DRIVER_SCRIPT = findDriverScript();

/**
 * Какой драйвер взят и какой он версии.
 *
 * Скрипт ищется среди нескольких мест: приложение берёт исходник, MCP-сервер —
 * собранную копию. Две правды об одном файле однажды разошлись на сутки, и
 * отладка выглядела как «в исходнике починено, в работе нет». Путь и хеш в
 * первой строке журнала прогона делают расхождение видимым сразу.
 */
export function driverStamp(): { path: string; hash: string } {
  try {
    const hash = createHash('sha256').update(readFileSync(DRIVER_SCRIPT)).digest('hex').slice(0, 12);
    return { path: DRIVER_SCRIPT, hash };
  } catch {
    return { path: DRIVER_SCRIPT, hash: 'нет файла' };
  }
}

export class DesktopDriver {
  private child: ChildProcessWithoutNullStreams | null = null;
  private ready: Promise<void> | null = null;
  private buffer = '';
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve(value: unknown): void; reject(error: Error): void }
  >();

  constructor(private readonly scriptPath: string = DRIVER_SCRIPT) {}

  private start(): Promise<void> {
    if (this.ready) return this.ready;

    this.ready = new Promise<void>((resolve, reject) => {
      const child = spawn(
        'powershell',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', this.scriptPath],
        { windowsHide: true },
      );
      this.child = child;

      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (text: string) => {
        const trimmed = text.trim();
        if (trimmed) console.error(`[jarvis:desktop] ${trimmed}`);
      });

      child.stdout.on('data', (text: string) => {
        this.buffer += text;
        let index = this.buffer.indexOf('\n');
        while (index >= 0) {
          const line = this.buffer.slice(0, index).trim();
          this.buffer = this.buffer.slice(index + 1);
          index = this.buffer.indexOf('\n');
          if (!line) continue;

          let message: { type?: string; id?: number; result?: unknown; error?: string };
          try {
            message = JSON.parse(line);
          } catch {
            continue;
          }
          if (message.type === 'ready') {
            resolve();
            continue;
          }
          if (typeof message.id !== 'number') continue;
          const entry = this.pending.get(message.id);
          if (!entry) continue;
          this.pending.delete(message.id);
          if (message.error) entry.reject(new Error(message.error));
          else entry.resolve(message.result);
        }
      });

      child.once('exit', (code) => {
        const error = new Error(`Драйвер рабочего стола завершился с кодом ${code}`);
        for (const entry of this.pending.values()) entry.reject(error);
        this.pending.clear();
        this.child = null;
        this.ready = null;
        reject(error);
      });
    });

    return this.ready;
  }

  private async send<T>(command: Command): Promise<T> {
    await this.start();
    const child = this.child;
    if (!child) throw new Error('Драйвер рабочего стола не запущен');

    const id = this.nextId++;
    const answer = new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
    });
    child.stdin.write(`${JSON.stringify({ id, ...command })}\n`);

    return Promise.race([
      answer,
      new Promise<never>((_, reject) => {
        const timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`Команда «${command.cmd}» не ответила за 20 секунд`));
        }, 20_000);
        timer.unref?.();
      }),
    ]);
  }

  screen(): Promise<ScreenBounds> {
    return this.send<ScreenBounds>({ cmd: 'screen' });
  }

  windows(): Promise<DesktopWindow[]> {
    return this.send<{ windows: DesktopWindow[] }>({ cmd: 'windows' }).then((r) => r.windows ?? []);
  }

  cursor(): Promise<{ x: number; y: number }> {
    return this.send({ cmd: 'cursor' });
  }

  screenshot(filePath: string, region?: ScreenBounds): Promise<ScreenBounds & { path: string }> {
    return this.send({ cmd: 'screenshot', path: filePath, region });
  }

  move(x: number, y: number): Promise<void> {
    return this.send({ cmd: 'move', x, y });
  }

  click(options: { x?: number; y?: number; button?: 'left' | 'right' | 'middle'; double?: boolean }): Promise<void> {
    return this.send({ cmd: 'click', ...options });
  }

  scroll(amount: number, at?: { x: number; y: number }): Promise<void> {
    return this.send({ cmd: 'scroll', amount, ...(at ?? {}) });
  }

  type(text: string): Promise<void> {
    return this.send({ cmd: 'type', text });
  }

  key(keys: string): Promise<void> {
    return this.send({ cmd: 'key', keys });
  }

  /**
   * Элементы активного окна из дерева доступности.
   *
   * Быстрее снимка экрана и точнее: имена и координаты приходят готовыми, а не
   * угадываются по пикселям. Замер на этой машине — около 60 мс на окно.
   */
  elements(): Promise<{ title: string; elements: UiElement[] }> {
    return this.send({ cmd: 'elements' });
  }

  focus(title: string): Promise<{ title: string }> {
    return this.send({ cmd: 'focus', title });
  }

  dispose(): void {
    this.child?.kill();
    this.child = null;
    this.ready = null;
  }
}
