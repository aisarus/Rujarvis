import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { CliProcess } from './process';

const папки: string[] = [];
const pids: number[] = [];
afterEach(async () => {
  for (const pid of pids.splice(0)) {
    try {
      process.kill(pid);
    } catch {
      // Уже мёртв — так и должно быть.
    }
  }
  for (const папка of папки.splice(0)) await rm(папка, { recursive: true, force: true });
});

function жив(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function ждать(условие: () => Promise<boolean> | boolean, мс: number): Promise<boolean> {
  const до = Date.now() + мс;
  while (Date.now() < до) {
    if (await условие()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return условие();
}

/**
 * «Стоп» гасит агента, даже когда CLI поставлен через npm.
 *
 * `codex.cmd` запускается через оболочку, и настоящий агент — её ребёнок.
 * `child.kill()` убивал только оболочку, а агент работал дальше. Здесь —
 * настоящий `.cmd`, настоящий node внутри и настоящая отмена.
 */
describe.runIf(process.platform === 'win32')('стоп на Windows', () => {
  it('агент за оболочкой .cmd умирает вместе с ней', async () => {
    const папка = await mkdtemp(path.join(tmpdir(), 'jarvis-kill-'));
    папки.push(папка);
    const pidФайл = path.join(папка, 'agent.pid');
    await writeFile(
      path.join(папка, 'agent.js'),
      `require('fs').writeFileSync(${JSON.stringify(pidФайл)}, String(process.pid)); setTimeout(() => {}, 120000);`,
    );
    const cmd = path.join(папка, 'fake agent.cmd');
    await writeFile(cmd, `@"${process.execPath}" "%~dp0agent.js" %*\r\n`);

    const cli = new CliProcess({ command: cmd, args: ['--work'], onStdoutLine: () => {} });
    const итог = cli.wait();
    expect(await ждать(async () => (await readFile(pidФайл, 'utf8').catch(() => '')).length > 0, 10_000)).toBe(true);
    const агент = Number(await readFile(pidФайл, 'utf8'));
    pids.push(агент);
    expect(жив(агент)).toBe(true);

    cli.cancel();
    await итог;
    expect(await ждать(() => !жив(агент), 5_000), 'агент пережил «стоп»').toBe(true);
  }, 30_000);
});
