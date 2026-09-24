import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'win32-driver.ps1');
const onWindows = process.platform === 'win32';

/**
 * Свёрнутое окно — тоже окно.
 *
 * Windows отдаёт свёрнутое окно огрызком: 159×27 в точке (−25600, −25600).
 * Проверка размера выбрасывала его из перечисления, и «переключись на Edge»
 * не находило Edge **именно тогда, когда это нужнее всего** — когда окно
 * свёрнуто. Замерено на машине человека 24.09.2026: два раза подряд ответ
 * «не получилось» при живом свёрнутом окне Edge.
 *
 * Поднимать свёрнутое драйвер умел и раньше (`ShowWindow(h, 9)` — это
 * SW_RESTORE). Терялось оно на шаг раньше, в поиске.
 */
describe('перечисление окон', () => {
  it('размер спрашивают только у несвёрнутых', () => {
    const text = readFileSync(script, 'utf8');
    // Условие должно пускать свёрнутое вперёд проверки размера.
    expect(text).toMatch(/\$minimized\s+-or\s+\(\$width\s+-gt\s+80\s+-and\s+\$height\s+-gt\s+40\)/u);
  });

  it('у каждого окна сказано, свёрнуто ли оно', () => {
    expect(readFileSync(script, 'utf8')).toContain('minimized = [bool]$minimized');
  });
});

/**
 * «Ё» не должна прятать окно.
 *
 * Разбор фразы приводит речь к одному виду и меняет «ё» на «е»: человек
 * говорит одинаково, а пишет по-разному. Но в ЗАГОЛОВКЕ окна «ё» остаётся, и
 * поиск по дословному совпадению промахивается.
 *
 * Поймано приёмкой 25.09.2026: окно «Проба приёмки Rujarvis» не нашлось по
 * фразе, пришедшей в драйвер как «проба приемки rujarvis». Любое русское окно
 * с «ё» в имени — «Счёт», «Приём», «Ещё одна задача» — так же не нашлось бы.
 */
describe('поиск окна', () => {
  it('сравнение идёт без «ё» с обеих сторон', () => {
    const text = readFileSync(script, 'utf8');
    expect(text).toContain('function Simplify-Text');
    // Обе стороны сравнения обязаны пройти через приведение.
    expect(text).toMatch(/\(Simplify-Text \$_\.title\)\.Contains\(\$simple\)/u);
    expect(text).toMatch(/\$simple = Simplify-Text \$needle/u);
  });

  it('приведение трогает и строчную, и прописную «ё»', () => {
    const text = readFileSync(script, 'utf8');
    expect(text).toContain('0x0451');
    expect(text).toContain('0x0401');
  });
});

/**
 * Отказ должен говорить, что есть, а не просто «нет».
 *
 * «Не получилось» не сообщает человеку ничего: ни что искали, ни что рядом.
 */
describe('отказ найти окно', () => {
  it.skipIf(!onWindows)('называет то, что на экране', async () => {
    const answer = await ask({ id: 1, cmd: 'focus', title: 'окна-с-таким-именем-нет-12345' });
    expect(answer).toContain('Okno ne naydeno');
    expect(answer).toContain('Na ekrane:');
  }, 90_000);
});

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
      // Первая строка — «ready», ответ приходит второй.
      if (buffer.split('\n').filter((line) => line.trim()).length >= 2) {
        clearTimeout(timer);
        child.kill();
        resolve(buffer);
      }
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });

    child.stdin.write(`${JSON.stringify(message)}\n`);
  });
}
