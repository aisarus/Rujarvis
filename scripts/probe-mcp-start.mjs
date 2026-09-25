// Сколько времени проходит от запуска MCP-сервера до его первого ответа.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

const bundle = path.join(process.cwd(), 'dist', 'jarvis', 'desktop', 'mcp.cjs');

// Нечего замерять — так и говорим, отдельным кодом.
//
// Без сборки `node` умирал сразу, обработчика выхода не было, и замер честно
// ждал полторы минуты, чтобы сообщить «сервер медленный». Сервер при этом не
// запускался вовсе.
if (!existsSync(bundle)) {
  console.log(`НЕЧЕМ МЕРИТЬ: сборки нет — ${bundle}. Сначала pnpm build.`);
  process.exit(2);
}
const started = Date.now();

// Без `detached`: с ним Windows не доносит до cmd.exe написанное в stdin, и
// замер показывал «не ответил» на живом сервере. Гасим потом по номеру —
// сигналом прерывания задело бы и запущенного Джарвиса.
const child = spawn(process.execPath, [bundle], {
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true,
});

function killTree(pid) {
  if (pid === undefined) return;
  // `taskkill` есть только на Windows, и `spawnSync` его отсутствие не
  // бросает, а кладёт в `error` — `catch` тут не ловил ничего, и на маке с
  // линуксом сервер оставался жить.
  if (process.platform === 'win32') {
    const итог = spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
    if (!итог.error) return;
  }
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    // Процесс мог уже закончиться сам.
  }
}

// Сервер умер, не ответив, — это ответ, и ждать девяносто секунд незачем.
child.on('exit', (code, signal) => {
  console.log(`НЕЧЕМ МЕРИТЬ: сервер вышел до ответа (код ${code}, сигнал ${signal ?? 'нет'}).`);
  process.exit(2);
});
child.on('error', (error) => {
  console.log(`НЕЧЕМ МЕРИТЬ: сервер не запустился — ${error.message}`);
  process.exit(2);
});

let buffer = '';
child.stdout.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  let index;
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    // Не-JSON в stdout — это поломка сервера, а не повод упасть с трассой.
    //
    // `JSON.parse` бросал прямо в обработчике: замер падал, `killTree` не
    // звался, сервер оставался жить. И главное — не говорил, в чём дело: у
    // MCP через stdio stdout занят ТОЛЬКО протоколом, и баннер в нём ломает
    // любого клиента на `initialize`.
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      console.log(`ПЛОХО: сервер пишет в stdout не протокол: ${line.slice(0, 200)}`);
      killTree(child.pid);
      process.exit(1);
    }
    if (message.id === 1) {
      console.log(`MCP-сервер ответил за ${Date.now() - started} мс`);
      killTree(child.pid);
      process.exit(0);
    }
  }
});

child.stderr.on('data', (chunk) => process.stderr.write(chunk.toString().slice(0, 300)));

child.stdin.write(
  `${JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'probe', version: '1' } },
  })}\n`,
);

setTimeout(() => {
  console.log('не ответил за 90 секунд');
  killTree(child.pid);
  process.exit(1);
}, 90_000);
