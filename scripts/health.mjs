/**
 * Сквозная проверка Джарвиса: жива ли каждая часть.
 *
 * Не заменяет тесты — они проверяют логику. Здесь проверяется то, что тесты не
 * видят: настоящие процессы, настоящие файлы, настоящий MCP-сервер. Ровно тот
 * слой, на котором сегодня нашлись все тихие ошибки.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Дом Джарвиса — то же правило, что в jarvis/setup/paths.ts.
//
// Повторено здесь потому, что этот скрипт зовут обычным node, без сборки TS,
// и импортировать оттуда нечего. Чтобы правило не разошлось, за ним следит
// jarvis/setup/paths.coverage.vitest.test.ts: он сверяет ответы обоих.
const ROOT = jarvisHomeHere();

function jarvisHomeHere() {
  const explicit = process.env.JARVIS_HOME?.trim();
  if (explicit) return path.resolve(explicit);
  const home = os.homedir();
  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA?.trim() || path.join(home, 'AppData', 'Local'), 'Rujarvis');
  }
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Rujarvis');
  return path.join(process.env.XDG_DATA_HOME?.trim() || path.join(home, '.local', 'share'), 'rujarvis');
}
const results = [];

// Тот же выбор сервера, что в `jarvis/desktop/launch.ts`: явная подмена или
// собранный `mcp.cjs` из исходников рядом с данными.
const MCP = process.env.JARVIS_DESKTOP_MCP?.trim()
  ? { command: 'cmd.exe', args: ['/c', process.env.JARVIS_DESKTOP_MCP.trim()] }
  : { command: process.execPath, args: [path.join(ROOT, 'src', 'dist', 'jarvis', 'desktop', 'mcp.cjs')] };

const ok = (name, detail) => results.push({ good: true, name, detail });
const bad = (name, detail) => results.push({ good: false, name, detail });

function checkFile(name, file, minBytes = 1) {
  try {
    const size = statSync(file).size;
    if (size >= minBytes) ok(name, `${Math.round(size / 1024)} КБ`);
    else bad(name, `пустой: ${file}`);
  } catch {
    bad(name, `нет файла: ${file}`);
  }
}

function askMcp() {
  return new Promise((resolve) => {
    const started = Date.now();
    // Без `detached`, и это важно.
    //
    // С ним Windows не доносит до cmd.exe то, что пишут ему в stdin: сервер
    // молча ждёт запроса, которого не будет, и проверка объявляла мёртвым
    // совершенно живой сервер. Ровно так эта проверка и соврала — сервер в
    // тот момент отвечал за долю секунды.
    const child = spawn(MCP.command, MCP.args, {
      stdio: ['pipe', 'pipe', 'ignore'],
      windowsHide: true,
    });

    let buffer = '';
    const done = (value) => {
      killTree(child.pid);
      resolve(value);
    };

    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.id === 1) {
          child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
          child.stdin.write(
            `${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`,
          );
        }
        if (message.id === 2) {
          // Форму ответа проверяем, а не верим ей на слово.
          //
          // На ошибку JSON-RPC (`{ error: … }`) `message.result.tools.length`
          // бросал TypeError прямо в обработчике: процесс падал со стеком,
          // `done` не звали, дерево `cmd.exe → node` оставалось жить. Пустой
          // список при этом проходил как успех — а `проверка-сборки.ts` на том
          // же ответе считает сервер сломанным, и два прибора расходились.
          if (message.error) {
            done({ error: message.error.message ?? JSON.stringify(message.error) });
          } else if (!Array.isArray(message.result?.tools)) {
            done({ error: 'сервер ответил без списка инструментов' });
          } else if (message.result.tools.length === 0) {
            done({ error: 'сервер поднялся, но не отдал ни одного инструмента' });
          } else {
            done({ tools: message.result.tools.length, ms: Date.now() - started });
          }
        }
      }
    });

    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'health', version: '1' } },
      })}\n`,
    );

    setTimeout(() => done(null), 60_000);
  });
}

/**
 * Гасит дерево процессов по номеру, не трогая свою консоль.
 *
 * `child.kill()` здесь не годится дважды. Он оставляет живым внука — node,
 * который и есть сервер, — а в варианте с сигналом прерывания бьёт по всей
 * консольной группе и гасит запущенного Джарвиса заодно. Проверка, убивающая
 * то, что проверяет, — худший вид диагностики.
 */
function killTree(pid) {
  try {
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
  } catch {
    // Процесс мог уже закончиться сам — это не ошибка.
  }
}
async function main() {
  // Сборка приложения и сервера.
  checkFile('сборка приложения', 'dist/app/main.cjs', 100_000);
  checkFile('сборка MCP-сервера', 'dist/jarvis/desktop/mcp.cjs', 100_000);
  checkFile('драйвер мыши', 'dist/jarvis/desktop/win32-driver.ps1', 1_000);
  checkFile('окно настроек', 'app/ui/settings.html', 100);

  // Данные человека.
  checkFile('журнал действий', path.join(ROOT, 'data', 'journal.json'));
  checkFile('файл характера', path.join(ROOT, 'data', 'характер.md'), 100);
  checkFile('лог', path.join(ROOT, 'logs', 'jarvis.log'), 100);

  // Папка результатов с разделами.
  const output = path.join(os.homedir(), 'Desktop', 'Джарвис');
  const sections = ['Images', 'Video', 'Docs', 'Files', 'Apps'];
  const missing = sections.filter((s) => !existsSync(path.join(output, s)));
  if (missing.length === 0) ok('папка результатов', `${sections.length} разделов`);
  else bad('папка результатов', `нет разделов: ${missing.join(', ')}`);

  // Навыки.
  try {
    const skills = readdirSync(path.join(os.homedir(), '.claude', 'skills'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .filter((entry) => existsSync(path.join(os.homedir(), '.claude', 'skills', entry.name, 'SKILL.md')));
    ok('навыки', `${skills.length} штук`);
  } catch {
    bad('навыки', 'папка не читается');
  }

  // Голос и распознавание.
  checkFile(
    'голос',
    path.join(ROOT, 'models', 'voices', 'vits-piper-ru_RU-irina-medium', 'ru_RU-irina-medium.onnx'),
    1_000_000,
  );

  // MCP-сервер по-настоящему.
  const mcp = await askMcp();
  if (mcp?.error) bad('MCP-сервер', mcp.error);
  else if (mcp) ok('MCP-сервер', `${mcp.tools} инструментов за ${mcp.ms} мс`);
  else bad('MCP-сервер', 'не ответил');

  console.log('');
  for (const item of results) {
    console.log(`${item.good ? '  ok ' : ' НЕТ '} ${item.name} — ${item.detail}`);
  }
  const broken = results.filter((item) => !item.good).length;
  console.log('');
  console.log(broken === 0 ? 'всё на месте' : `сломано: ${broken}`);
  process.exit(broken === 0 ? 0 : 1);
}

main();
