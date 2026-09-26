/**
 * Клиент MCP для живых проверок: поднимает собранный сервер рабочего стола
 * (`dist/jarvis/desktop/mcp.cjs`) и зовёт его инструменты так же, как Claude
 * Code.
 *
 * Вынесен из hands-check, чтобы проверки не держали по копии: браузерной
 * цепочке (`browse-check`) нужен тот же клиент.
 */
import { spawn, type ChildProcess } from 'node:child_process';

export class Сервер {
  private child: ChildProcess | null = null;
  private buffer = '';
  private next = 10;
  private readonly ждут = new Map<number, { ok(v: unknown): void; bad(e: Error): void }>();

  /** `окружение` — добавка к окружению сервера: например, свой JARVIS_HOME. */
  constructor(private readonly окружение: Record<string, string> = {}) {}

  async поднять(): Promise<void> {
    const child = spawn(process.execPath, ['dist/jarvis/desktop/mcp.cjs'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, JARVIS_LANGUAGE: 'ru', ...this.окружение },
    });
    this.child = child;
    child.stdout?.on('data', (c: Buffer) => this.взять(c.toString('utf8')));
    // Ошибки сервера видеть надо: молчащий сервер и сервер, упавший с
    // объяснением, — разные новости.
    child.stderr?.on('data', (c: Buffer) => {
      const текст = c.toString('utf8').trim();
      if (текст) console.log(`    [сервер] ${текст.slice(0, 300)}`);
    });
    await this.спросить('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'hands-check', version: '1' },
    });
    child.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  }

  private взять(text: string): void {
    this.buffer += text;
    let end: number;
    while ((end = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, end).trim();
      this.buffer = this.buffer.slice(end + 1);
      if (!line.startsWith('{')) continue;
      let m: { id?: number; result?: unknown; error?: unknown };
      try {
        m = JSON.parse(line) as typeof m;
      } catch {
        continue;
      }
      if (m.id === undefined) continue;
      const место = this.ждут.get(m.id);
      if (!место) continue;
      this.ждут.delete(m.id);
      if (m.error) место.bad(new Error(JSON.stringify(m.error)));
      else место.ok(m.result);
    }
  }

  private спросить(method: string, params: unknown, ждатьМс = 120_000): Promise<unknown> {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.ждут.delete(id);
        reject(new Error(`сервер молчит дольше ${Math.round(ждатьМс / 1000)} с на ${method}`));
      }, ждатьМс);
      this.ждут.set(id, {
        ok: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        bad: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.child?.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  /** Позвать инструмент. Отказ инструмента приходит полем isError, не ошибкой. */
  async инструмент(name: string, args: Record<string, unknown>, ждатьМс = 120_000): Promise<string> {
    const r = (await this.спросить('tools/call', { name, arguments: args }, ждатьМс)) as {
      content?: { text?: string }[];
      isError?: boolean;
    };
    const текст = (r.content ?? []).map((c) => c.text ?? '').join('');
    if (r.isError === true) throw new Error(текст || 'инструмент отказал без объяснения');
    return текст;
  }

  async список(): Promise<string[]> {
    const r = (await this.спросить('tools/list', {})) as { tools?: { name: string }[] };
    return (r.tools ?? []).map((t) => t.name);
  }

  закрыть(): void {
    const child = this.child;
    this.child = null;
    child?.kill();
  }
}
