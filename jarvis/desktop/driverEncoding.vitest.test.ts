import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'win32-driver.ps1');
const onWindows = process.platform === 'win32';

/**
 * Гоняет настоящий драйвер и возвращает его ответ.
 *
 * Именно настоящий: ошибка была не в логике, а в том, как PowerShell читает
 * стандартный ввод, и никакой разбор в памяти её бы не поймал.
 */
function ask(message: Record<string, unknown>, timeoutMs = 60_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script],
      { windowsHide: true },
    );

    let buffer = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('драйвер не ответил'));
    }, timeoutMs);

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      let index = buffer.indexOf('\n');
      while (index >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf('\n');
        if (!line) continue;

        const parsed = JSON.parse(line) as { type?: string; id?: number; error?: string };
        if (parsed.type === 'ready') {
          child.stdin.write(`${JSON.stringify({ id: 1, ...message })}\n`);
          continue;
        }
        if (parsed.id === 1) {
          clearTimeout(timer);
          child.kill();
          resolve(parsed.error ?? '');
        }
      }
    });

    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

describe.runIf(onWindows)('кодировка ввода драйвера', () => {
  it(
    'принимает кириллицу так, как её отправили',
    async () => {
      // Драйвер задавал кодировку вывода, но не ввода, и всё нелатинское
      // приезжало мусором: «ПроверкаКириллицы» превращалась в псевдографику.
      // Последствия были тихими — диктовка по-русски печатала бы бессмыслицу,
      // а переключение на окно с русским заголовком не находило его никогда.
      const answer = await ask({ cmd: 'focus', title: 'ЗаведомоНесуществующееОкно' });
      expect(answer).toContain('ЗаведомоНесуществующееОкно');
    },
    90_000,
  );

  it(
    'принимает иврит — интерфейс Windows здесь на нём',
    async () => {
      const answer = await ask({ cmd: 'focus', title: 'פנקס־נסיון' });
      expect(answer).toContain('פנקס־נסיון');
    },
    90_000,
  );
});
