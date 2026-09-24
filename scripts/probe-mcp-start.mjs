// Сколько времени проходит от запуска MCP-сервера до его первого ответа.
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';

const bundle = path.join(process.cwd(), 'dist-electron', 'jarvis', 'desktop', 'mcp.cjs');
const started = Date.now();

// Без `detached`: с ним Windows не доносит до cmd.exe написанное в stdin, и
// замер показывал «не ответил» на живом сервере. Гасим потом по номеру —
// сигналом прерывания задело бы и запущенного Джарвиса.
const child = spawn(process.execPath, [bundle], {
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true,
});

function killTree(pid) {
  try {
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
  } catch {
    // Процесс мог уже закончиться сам.
  }
}

let buffer = '';
child.stdout.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  let index;
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    const message = JSON.parse(line);
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
