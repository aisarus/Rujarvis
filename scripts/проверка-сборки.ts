/**
 * Проверка собранного приложения, а не исходников.
 *
 * ## Зачем
 *
 * 20.09.2026 сутки правок драйвера рабочего стола не доезжали до работающего
 * приложения. esbuild собирает TypeScript, а драйвер — это PowerShell: он
 * читается с диска. Копия в dist-electron была суточной давности, и отладка
 * выглядела так: в исходнике починено, в работе нет.
 *
 * Хуже того, файл ищется среди нескольких мест: приложение берёт исходник,
 * MCP-сервер — собранную копию. Две правды об одном файле. Они разошлись, и
 * никто этого не заметил.
 *
 * Здесь проверяется ровно это: что артефакт полон, что копия совпадает с
 * исходником и что собранный MCP-сервер правда отвечает. Модульные тесты
 * такого не видят по устройству — они работают с исходниками.
 *
 *   npx tsx scripts/проверка-сборки.ts
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const NL = String.fromCharCode(10);
const корень = process.cwd();
const дом = path.join(os.homedir(), 'AppData', 'Local', 'Rujarvis');

/** Три исхода: прошло, не прошло, нечем проверить. */
type Исход = null | string | { нечем: string };

interface Проверка {
  что: string;
  как: () => Promise<Исход> | Исход;
}

export function хешФайла(файл: string): string {
  return createHash('sha256').update(readFileSync(файл)).digest('hex').slice(0, 12);
}

/** Есть ли файл и не пуст ли он. Пустой файл — тоже отсутствующий. */
function естьФайл(путь: string, least = 1): Исход {
  if (!existsSync(путь)) return `нет файла: ${путь}`;
  const размер = statSync(путь).size;
  if (размер < least) return `файл мал: ${путь} (${размер} байт, ждали от ${least})`;
  return null;
}

/**
 * Первый файл с таким окончанием где-то внутри.
 *
 * Именно «где-то»: голос лежит на два уровня вглубь и называется по себе —
 * `ru_RU-irina-medium.onnx`, а не `model.onnx`. Первая версия этой проверки
 * ждала точного имени и объявила пропажу там, где всё было на месте. Прибор,
 * кричащий по пустякам, хуже отсутствующего.
 */
function найтиВГлубину(корневая: string, окончание: string, глубина = 4): string | null {
  if (глубина < 0 || !existsSync(корневая)) return null;
  let записи: string[];
  try {
    записи = readdirSync(корневая);
  } catch {
    return null;
  }
  for (const запись of записи) {
    const путь = path.join(корневая, запись);
    let это;
    try {
      это = statSync(путь);
    } catch {
      continue;
    }
    if (это.isFile() && запись.toLowerCase().endsWith(окончание.toLowerCase())) return путь;
    if (это.isDirectory()) {
      const глубже = найтиВГлубину(путь, окончание, глубина - 1);
      if (глубже) return глубже;
    }
  }
  return null;
}

/**
 * Дым по собранному серверу: поднять, спросить инструменты, уйти.
 *
 * Проверяется артефакт, а не исходник, и заодно то, что сервер уходит вслед
 * за клиентом: за сутки без этого накопилось шесть осиротевших процессов.
 */
function дымМcp(): Promise<Исход> {
  return new Promise((готово) => {
    const сервер = path.join(корень, 'dist-electron', 'jarvis', 'desktop', 'mcp.cjs');
    if (!existsSync(сервер)) return готово('MCP-сервер не собран');

    const дитя = spawn(process.execPath, [сервер], { stdio: ['pipe', 'pipe', 'ignore'] });
    let буфер = '';
    let ушёл = false;
    дитя.on('exit', () => {
      ушёл = true;
    });

    const послать = (m: unknown): void => {
      дитя.stdin.write(JSON.stringify(m) + NL);
    };

    const сдаться = setTimeout(() => {
      дитя.kill();
      готово('сервер не ответил за сорок секунд');
    }, 40_000);

    дитя.stdout.on('data', (кусок: Buffer) => {
      буфер += кусок.toString('utf8');
      let край: number;
      while ((край = буфер.indexOf(NL)) >= 0) {
        const строка = буфер.slice(0, край).trim();
        буфер = буфер.slice(край + 1);
        if (!строка.startsWith('{')) continue;

        let м: { id?: number; result?: { tools?: unknown[] } };
        try {
          м = JSON.parse(строка);
        } catch {
          continue;
        }

        if (м.id === 1) {
          послать({ jsonrpc: '2.0', method: 'notifications/initialized' });
          послать({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
          continue;
        }

        if (м.id === 2) {
          const инструментов = м.result?.tools?.length ?? 0;
          дитя.stdin.end();
          setTimeout(() => {
            clearTimeout(сдаться);
            if (!ушёл) {
              дитя.kill();
              return готово('сервер остался жив после ухода клиента — это утечка');
            }
            готово(инструментов > 20 ? null : `инструментов всего ${инструментов}`);
          }, 5_000);
        }
      }
    });

    послать({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'проверка-сборки', version: '1' },
      },
    });
  });
}

const ПРОВЕРКИ: Проверка[] = [
  {
    что: 'собран главный процесс',
    как: () => естьФайл(path.join(корень, 'dist-electron', 'electron', 'main.cjs'), 1_000_000),
  },
  {
    что: 'собран мост в окно',
    как: () => естьФайл(path.join(корень, 'dist-electron', 'electron', 'preload.cjs'), 1_000),
  },
  {
    что: 'собран MCP-сервер',
    как: () => естьФайл(path.join(корень, 'dist-electron', 'jarvis', 'desktop', 'mcp.cjs'), 100_000),
  },
  {
    что: 'драйвер рабочего стола есть в сборке',
    как: () =>
      естьФайл(path.join(корень, 'dist-electron', 'jarvis', 'desktop', 'win32-driver.ps1'), 1_000),
  },

  // Главная проверка этого файла. Ради неё он и написан.
  {
    что: 'копия драйвера совпадает с исходником',
    как: () => {
      const исходник = path.join(корень, 'jarvis', 'desktop', 'win32-driver.ps1');
      const копия = path.join(корень, 'dist-electron', 'jarvis', 'desktop', 'win32-driver.ps1');
      if (!existsSync(исходник) || !existsSync(копия)) return 'нечего сравнивать';
      const a = хешФайла(исходник);
      const b = хешФайла(копия);
      if (a === b) return null;
      return `РАЗОШЛИСЬ: исходник ${a}, сборка ${b} — правки не доедут до работающего приложения`;
    },
  },

  {
    что: 'модель распознавания на месте',
    как: () => {
      const модель = path.join(дом, 'whisper-cuda', 'ggml-large-v3-turbo-q5_0.bin');
      if (!existsSync(модель)) return { нечем: 'модель Whisper не установлена' };
      return естьФайл(модель, 100_000_000);
    },
  },
  {
    что: 'голос на месте',
    как: () => {
      const корневая = path.join(дом, 'data', 'tts-models');
      if (!existsSync(корневая)) return { нечем: 'голоса не установлены' };
      const голос = найтиВГлубину(корневая, '.onnx');
      if (!голос) return 'папка голосов есть, а модели в ней нет';
      return естьФайл(голос, 1_000_000);
    },
  },
  {
    что: 'драйвер компьютер-юза на месте',
    как: () => {
      const exe = найтиВГлубину(path.join(дом, 'cua-driver', 'unpacked'), 'cua-driver.exe', 2);
      if (!exe) return { нечем: 'cua-driver не установлен' };
      return естьФайл(exe, 1_000_000);
    },
  },
  {
    что: 'запускалка на месте',
    как: () => естьФайл(path.join(дом, 'Jarvis.cmd'), 100),
  },

  {
    что: 'собранный сервер отвечает и уходит за клиентом',
    как: () => дымМcp(),
  },
];

async function main(): Promise<void> {
  console.log(`Проверка собранного приложения: ${ПРОВЕРКИ.length} пунктов` + NL);
  let плохо = 0;
  let нечем = 0;

  for (const пункт of ПРОВЕРКИ) {
    let исход: Исход;
    try {
      исход = await пункт.как();
    } catch (беда) {
      исход = беда instanceof Error ? беда.message : String(беда);
    }

    if (исход === null) {
      console.log('  ок   ' + пункт.что);
    } else if (typeof исход === 'object') {
      нечем += 1;
      console.log('нечем  ' + пункт.что.padEnd(48) + исход.нечем);
    } else {
      плохо += 1;
      console.log('ПЛОХО  ' + пункт.что.padEnd(48) + исход);
    }
  }

  console.log('');
  const хвост = нечем > 0 ? `, нечем проверить: ${нечем}` : '';
  console.log(плохо === 0 ? `Сборка полна${хвост}.` : `Не прошло: ${плохо}${хвост}.`);
  process.exit(плохо === 0 ? 0 : 1);
}

void main();
