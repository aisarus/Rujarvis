/**
 * Распознавание на видеокарте: whisper.cpp с CUDA и свой сервер на этом
 * компьютере.
 *
 * ## Зачем
 *
 * Живой журнал 28.09.2026: Whisper base на процессоре — в один поток, иначе
 * сборка sherpa-onnx не грузится — слышал фразу 1,7–3,9 с и превращал «открой
 * блендер» в «от кольбландр». Владелец: «распознавание на локальной модели
 * ужасное». Клиент к серверу whisper.cpp в мосте был давно
 * (`app/gpuTranscriber.ts`), а самого сервера не было: его поднимал старый
 * лаунчер, которого больше нет.
 *
 * Здесь — установка (программа whisper.cpp с CUDA и модель) и запуск своего
 * сервера с записанным pid. Модель — small (решение владельца 28.09.2026): на
 * его голосе заметно точнее base и лёгкая для видеокарты на 4 ГБ.
 *
 * ## Чего здесь нет
 *
 * Сам ничего не качает: установка — отдельной командой (`pnpm jarvis:gpu-stt`).
 *
 * ## Windows и мак
 *
 * На Windows — готовая сборка whisper.cpp с CUDA (видеокарта NVIDIA). На маке
 * whisper.cpp считает на видеокарте через Metal, и ставится он Homebrew
 * (`brew install whisper-cpp`), который установка Джарвиса на маке и так
 * использует. Сервер, его протокол и модель одни и те же — отличается только
 * способ поставить программу. Без установки мост остаётся на процессоре.
 */

import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { downloadFile, type ModelInstallProgress } from './modelArchive';

/**
 * Сборка whisper.cpp с CUDA 12.4.
 *
 * Не 11.8, хотя та вдвое меньше: в её архиве нет cuBLAS (cublas64_11.dll), без
 * которой ggml-cuda.dll не грузится, и сервер молча считает на процессоре.
 * Замер на машине владельца 28.09.2026: «no GPU found», 14–20 с на фразу. В
 * сборке под 12.4 cuBLAS лежит рядом; драйвер нужен 525 или новее.
 */
export const GPU_WHISPER_RUNTIME = {
  url: 'https://github.com/ggml-org/whisper.cpp/releases/download/v1.9.2/whisper-cublas-12.4.0-bin-x64.zip',
  bytes: 670_611_449,
  sha256: '443110ddaad70d4290ab2e77179e31cf712035bbc4fad56bb4519a90c917b39c',
} as const;

/** small, квантованная в 8 бит: по качеству почти полная, а видеопамяти берёт меньше. */
export const GPU_WHISPER_MODEL = {
  name: 'small',
  file: 'ggml-small-q8_0.bin',
  url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small-q8_0.bin',
  bytes: 264_464_607,
  sha256: '49c8fb02b65e6049d5fa6c04f81f53b867b5ec9540406812c643f177317f779f',
} as const;

const SERVER_EXE = 'whisper-server.exe';

/** Куда Homebrew кладёт программы: Apple Silicon и Intel. */
const BREW_BIN = ['/opt/homebrew/bin', '/usr/local/bin'];

async function серверHomebrew(): Promise<string | null> {
  for (const папка of BREW_BIN) {
    const путь = path.join(папка, 'whisper-server');
    if ((await размер(путь)) >= 0) return путь;
  }
  return null;
}

export interface GpuWhisperFiles {
  server: string;
  model: string;
}

/** Папка распознавания на видеокарте внутри папки Джарвиса. */
export function gpuWhisperDir(jarvisHome: string): string {
  return path.join(jarvisHome, 'models', 'whisper-gpu');
}

async function размер(файл: string): Promise<number> {
  try {
    const о = await stat(файл);
    return о.isFile() ? о.size : -1;
  } catch {
    return -1;
  }
}

/** Где лежит сервер: архив кладёт его во вложенную папку (Release/), и не всегда в одну и ту же. */
async function найтиСервер(корень: string, глубина = 3): Promise<string | null> {
  let записи;
  try {
    записи = await readdir(корень, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const запись of записи) {
    if (запись.isFile() && запись.name.toLowerCase() === SERVER_EXE) return path.join(корень, запись.name);
  }
  if (глубина === 0) return null;
  for (const запись of записи) {
    if (!запись.isDirectory()) continue;
    const найдено = await найтиСервер(path.join(корень, запись.name), глубина - 1);
    if (найдено) return найдено;
  }
  return null;
}

/**
 * Стоит ли сборка, с которой видеокарта правда заработает: сервер и cuBLAS
 * рядом с ним. Сборка 11.8 без cuBLAS — не стоит: её заменяем.
 */
async function сборкаСCublas(runtime: string): Promise<boolean> {
  const server = await найтиСервер(runtime);
  if (!server) return false;
  try {
    return (await readdir(path.dirname(server))).some((имя) => /^cublas64_\d+\.dll$/iu.test(имя));
  } catch {
    return false;
  }
}

/** Что уже стоит: сервер и модель нужного размера — или null. */
export async function findGpuWhisper(
  dir: string,
  model: { file: string; bytes: number } = GPU_WHISPER_MODEL,
  platform: NodeJS.Platform = process.platform,
): Promise<GpuWhisperFiles | null> {
  const server = platform === 'darwin' ? await серверHomebrew() : await найтиСервер(path.join(dir, 'runtime'));
  const модель = path.join(dir, model.file);
  if (!server || (await размер(модель)) !== model.bytes) return null;
  return { server, model: модель };
}

export async function sha256(файл: string): Promise<string> {
  const хеш = createHash('sha256');
  for await (const кусок of createReadStream(файл)) хеш.update(кусок as Buffer);
  return хеш.digest('hex');
}

/** Скачанное — то самое, а не подменённое или битое. Не то — стираем, чтобы не докачивать к порче. */
async function сверитьСумму(файл: string, ждём: string, что: string): Promise<void> {
  const есть = await sha256(файл);
  if (есть !== ждём) {
    await rm(файл, { force: true });
    throw new Error(`${что}: контрольная сумма не сошлась (${есть.slice(0, 12)}… вместо ${ждём.slice(0, 12)}…), файл стёрт`);
  }
}

/**
 * Распаковать zip встроенным tar Windows.
 *
 * Именно System32: в PATH рядом часто стоит tar из Git, а он zip не
 * понимает. Встроенный — bsdtar, он есть в Windows 10 с 2018 года.
 */
async function распаковатьZip(zip: string, куда: string): Promise<void> {
  const tar = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
  await promisify(execFile)(tar, ['-xf', zip, '-C', куда], { windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
}

export interface InstallGpuWhisperOptions {
  dir: string;
  onProgress?(что: 'программа' | 'модель', progress: ModelInstallProgress): void;
  fetchImpl?: typeof fetch;
}

/** Поставить программу и модель; уже стоящее не качается заново. */
export async function installGpuWhisper(options: InstallGpuWhisperOptions): Promise<GpuWhisperFiles> {
  if (process.platform !== 'win32' && process.platform !== 'darwin') {
    throw new Error('Распознавание на видеокарте ставится на Windows (CUDA) и на маке (Metal); на этой системе — нет.');
  }
  const { dir } = options;
  await mkdir(dir, { recursive: true });

  if (process.platform === 'darwin' && !(await серверHomebrew())) {
    const brew = BREW_BIN.map((папка) => path.join(папка, 'brew'));
    let поставлено = false;
    for (const команда of brew) {
      if ((await размер(команда)) < 0) continue;
      options.onProgress?.('программа', { stage: 'downloading', message: 'brew install whisper-cpp' });
      await promisify(execFile)(команда, ['install', 'whisper-cpp'], { maxBuffer: 64 * 1024 * 1024 });
      поставлено = true;
      break;
    }
    if (!поставлено) throw new Error('нет Homebrew: whisper.cpp на маке ставится командой brew install whisper-cpp');
    if (!(await серверHomebrew())) throw new Error('brew поставил whisper-cpp, но whisper-server не нашёлся');
  }

  const runtime = path.join(dir, 'runtime');
  if (process.platform === 'win32' && !(await сборкаСCublas(runtime))) {
    const zip = path.join(dir, 'whisper-runtime.zip.partial');
    await downloadFile(
      {
        url: GPU_WHISPER_RUNTIME.url,
        expectedBytes: GPU_WHISPER_RUNTIME.bytes,
        onProgress: (p) => options.onProgress?.('программа', p),
        fetchImpl: options.fetchImpl,
      },
      zip,
    );
    await сверитьСумму(zip, GPU_WHISPER_RUNTIME.sha256, 'программа whisper.cpp');
    // Распаковка в сторону и переименование: оборванная распаковка не должна
    // выглядеть установленной (так уже было с моделями процессора).
    const перевалка = path.join(dir, 'runtime.unpacking');
    await rm(перевалка, { recursive: true, force: true });
    await mkdir(перевалка, { recursive: true });
    await распаковатьZip(zip, перевалка);
    if (!(await найтиСервер(перевалка))) throw new Error(`в архиве whisper.cpp нет ${SERVER_EXE}`);
    await rm(runtime, { recursive: true, force: true });
    await rename(перевалка, runtime);
    await rm(zip, { force: true });
  }

  const модель = path.join(dir, GPU_WHISPER_MODEL.file);
  if ((await размер(модель)) !== GPU_WHISPER_MODEL.bytes) {
    const partial = `${модель}.partial`;
    await downloadFile(
      {
        url: GPU_WHISPER_MODEL.url,
        expectedBytes: GPU_WHISPER_MODEL.bytes,
        onProgress: (p) => options.onProgress?.('модель', p),
        fetchImpl: options.fetchImpl,
      },
      partial,
    );
    await сверитьСумму(partial, GPU_WHISPER_MODEL.sha256, `модель ${GPU_WHISPER_MODEL.file}`);
    await rename(partial, модель);
  }

  const files = await findGpuWhisper(dir);
  if (!files) throw new Error(`после установки не нашёл ${SERVER_EXE} или модель в ${dir}`);
  return files;
}

/** Аргументы сервера: только этот компьютер, язык — в каждом запросе. */
export function serverArgs(files: GpuWhisperFiles, port: number): string[] {
  return ['-m', files.model, '--host', '127.0.0.1', '--port', String(port), '-t', '4'];
}

export interface GpuWhisperServer {
  endpoint: string;
  pid: number;
  /** Погасить ровно свой процесс — по pid, записанному при запуске. */
  stop(): void;
}

export interface StartGpuWhisperOptions {
  port: number;
  isReady(endpoint: string): Promise<boolean>;
  readyMs?: number;
  log?(line: string): void;
  /** Подмена команды — только для проверок, где настоящего сервера нет. */
  command?: { file: string; args: string[] };
}

/**
 * Поднять сервер и дождаться, пока он ответит.
 *
 * Вышел до готовности — ошибка с хвостом его вывода, а не молчаливое «нет
 * видеокарты»: причина (нет CUDA, занят порт, битая модель) должна дойти до
 * журнала.
 */
export async function startGpuWhisper(files: GpuWhisperFiles, options: StartGpuWhisperOptions): Promise<GpuWhisperServer> {
  const команда = options.command ?? { file: files.server, args: serverArgs(files, options.port) };
  const child = spawn(команда.file, команда.args, {
    cwd: path.dirname(команда.file),
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const хвост: string[] = [];
  // Сервер печатает system_info на каждый запрос, и в нём есть «CUDA»: живой
  // журнал 29.09.2026 — строка на каждую фразу. Что с видеокартой, важно при
  // запуске; дальше — только хвост на случай падения.
  let готов = false;
  const читать = (кусок: Buffer): void => {
    for (const строка of кусок.toString('utf8').split(/\r?\n/u)) {
      const чистая = строка.trim();
      if (!чистая) continue;
      хвост.push(чистая);
      if (хвост.length > 8) хвост.shift();
      // Видеокарта найдена или нет — первое, что нужно знать о таком сервере.
      if (!готов && /cuda|gpu|metal/iu.test(чистая)) options.log?.(чистая);
    }
  };
  child.stdout?.on('data', читать);
  child.stderr?.on('data', читать);

  let вышел: number | null = null;
  let ошибкаЗапуска: Error | null = null;
  child.on('exit', (code) => {
    вышел = code ?? -1;
  });
  child.on('error', (error) => {
    ошибкаЗапуска = error;
  });

  const endpoint = `http://127.0.0.1:${options.port}`;
  const stop = (): void => {
    if (вышел === null) child.kill();
  };
  const срок = Date.now() + (options.readyMs ?? 60_000);
  while (Date.now() < срок) {
    if (ошибкаЗапуска) throw new Error(`сервер распознавания не запустился: ${(ошибкаЗапуска as Error).message}`);
    if (вышел !== null) throw new Error(`сервер распознавания вышел с кодом ${вышел}: ${хвост.join(' | ')}`);
    if (await options.isReady(endpoint)) {
      if (child.pid === undefined) throw new Error('сервер распознавания запущен без pid');
      готов = true;
      return { endpoint, pid: child.pid, stop };
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  stop();
  throw new Error(`сервер распознавания не ответил за ${Math.round((options.readyMs ?? 60_000) / 1000)} с: ${хвост.join(' | ')}`);
}
