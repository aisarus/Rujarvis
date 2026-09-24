/**
 * The missing link between the Jarvis core and the desktop.
 *
 * Everything under `jarvis/` was written to be driven by arguments, and
 * `createJarvis()` wires the real implementations together. What neither of
 * them can do is reach a microphone, a hotkey or a speaker — that needs
 * Electron, and this is the only file that touches all four.
 *
 * Responsibilities, and nothing beyond them:
 *   - own the hidden page that holds the microphone
 *   - turn recorded samples into text with the Russian recogniser
 *   - turn Jarvis's replies into Russian speech
 *   - put a global hotkey in front of the whole thing
 */

import { app, BrowserWindow, globalShortcut, ipcMain } from 'electron';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, type Dirent } from 'node:fs';
import { access, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  VoiceSession,
  type AudioCapture,
  type SpeechPlayback,
  type Transcriber,
  type VoiceStatus,
} from '../../jarvis/voice/session';
import { listInstalledPrograms } from '../../jarvis/apps/installed';
import { aliasTarget, matchAppLaunch, spokenCloseTarget, spokenTarget, windowAlias } from '../../jarvis/apps/launch';
import { readConfirmation } from '../../jarvis/voice/confirm';
import { chooseShortcut } from '../../jarvis/apps/startMenu';
import { OUTPUT_SECTIONS, revealPath } from '../../jarvis/desktop/files';
import { describeArtifacts } from '../../jarvis/files/artifacts';
import { JournalStore } from '../../jarvis/memory/journalStore';
import type { EventKind } from '../../jarvis/memory/journal';
import { matchVoiceControl } from '../../jarvis/voice/interrupts';
import { fixMishearings } from '../../jarvis/voice/mishearing';
import { isPleasantry, isSilenceRequest, looksLikeChatter, meaningfulSpeech } from '../../jarvis/voice/noise';
import { endsDictation, parseDirectCommand, type DirectCommand } from '../../jarvis/control/commands';
import { reapAll } from '../../jarvis/tasks/reaper';
import { parseDictationEdit, type DictationEdit } from '../../jarvis/control/dictationEdits';
import { chooseElement } from '../../jarvis/control/elements';
import { cellCenter, subCellCenter } from '../../jarvis/control/grid';
import { DesktopDriver, driverStamp } from '../../jarvis/desktop/driver';
import { resolveDesktopMcpLaunch } from '../../jarvis/desktop/launch';
import { GateBridge } from '../../jarvis/risk/gateBridge';
import { prepareGate } from '../../jarvis/risk/gateSetup';
import { EchoGuard } from '../../jarvis/voice/echo';
import { StandingInstructions } from '../../jarvis/backends/standingInstructions';
import { ProgressVoice } from '../../jarvis/voice/progress';
import { UtteranceBuffer } from '../../jarvis/voice/turn';
import { findWakeWord } from '../../jarvis/voice/wakeWord';
import { spokenFailure, toSpokenResponse } from '../../jarvis/voice/spokenResponse';
import { createJarvis, type Jarvis } from '../../server/jarvis/createJarvis';
import { getCurrentWorkspace } from '../../server/utils/workspace';
import {
  getTtsInstallRoot,
  isTtsModelInstalled,
  synthesizeSpeech,
  toPlaybackBase64,
} from '../../server/services/ttsService';
import { DEFAULT_TTS_MODEL_ID } from '../../shared/types/tts';
import { AUDIO_BRIDGE_CHANNELS, buildAudioBridgeHtml } from './audioBridgePage';
import { createElevenLabsTranscriber } from './cloudTranscriber';
import { createGpuTranscriber, waitForWhisperServer } from './gpuTranscriber';
import { createSttProcess } from './sttProcess';
import { startLogFile } from './logFile';
import { createGridOverlay, type GridOverlay } from './gridOverlay';
import { createHelpOverlay, type HelpOverlay } from './helpOverlay';
import { createLogWindow, type LogWindow } from './logWindow';
import { obviousAside } from '../../jarvis/dialogue/aside';
import { TalkBridge } from '../../jarvis/dialogue/talkBridge';
import { TalkSession } from '../../jarvis/dialogue/talkSession';
import { ЭХО_РАЗГОВОРА } from '../../jarvis/dialogue/workDelta';
import { RunLogStore } from '../../jarvis/observe/runLogStore';
import { Storyline } from '../../jarvis/observe/storyline';
import { StartupTiming } from '../../jarvis/observe/timing';
import { parseLiveEdit } from '../../jarvis/live/edits';
import { isLive, sendLive } from '../../jarvis/desktop/blenderLive';
import { NoteStore } from '../../jarvis/dialogue/noteStore';
import { describeLessons, lessonsFrom } from '../../jarvis/memory/lessons';
import { PlanStore } from '../../jarvis/agent/planStore';
import { planSummary, renderPlan } from '../../jarvis/agent/plan';
import { SpeechQueue } from '../../jarvis/voice/speechQueue';
import { createStatusOverlay, type StatusOverlay } from './statusOverlay';

/** Ctrl+Space is what `jarvis:setup` tells the user to press. */
const PUSH_TO_TALK_ACCELERATOR = 'Control+Space';

/**
 * Заткнуть Джарвиса и выключить микрофон одной кнопкой.
 *
 * С модификатором, а не голая «M». Голая заняла бы букву во всей системе:
 * человек не смог бы написать «мама» ни в одном окне. Клавиша та самая, о
 * которой просили, — просто с Ctrl, как и кнопка разговора рядом.
 */
const MUTE_ACCELERATOR = 'Control+M';


/** How long the assistant keeps listening after its name. */
const AWAKE_WINDOW_MS = 60_000;

interface RecordedAudio {
  samples: Float32Array;
  sampleRate: number;
  /**
   * Почему запись закончилась: человек замолчал или упёрлись в потолок длины.
   * Во втором случае он ещё говорил, и мысль обрывается на полуслове.
   */
  closedBy?: 'silence' | 'length';
  /**
   * Какая доля куска была речью, а не тишиной.
   *
   * Whisper выдумывает субтитры именно на тишине. Кусок, в котором речи почти
   * не было, — не фраза, что бы распознаватель ни написал.
   */
  speechShare?: number;
}

function whisperInstallRoot(): string {
  // Deliberately the same rule as `scripts/jarvis-setup.ts`, so the models the
  // installer downloaded are the models this finds.
  if (process.env.JARVIS_DATA_ROOT) return path.join(path.resolve(process.env.JARVIS_DATA_ROOT), 'whisper-models');
  const roaming = process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming');
  const root =
    process.platform === 'win32'
      ? path.join(roaming, 'Interpreter')
      : process.platform === 'darwin'
        ? path.join(os.homedir(), 'Library', 'Application Support', 'Interpreter')
        : path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), 'Interpreter');
  return path.join(root, 'whisper-models');
}

export interface JarvisVoiceBridge {
  jarvis: Jarvis;
  session: VoiceSession;
  dispose(): void;
}

let active: JarvisVoiceBridge | null = null;

/**
 * Пассивная память: что Джарвис делал.
 *
 * Пишется здесь, а не агентом, и в этом весь смысл. Модель запоминает только
 * то, о чём подумала; журнал помнит всё, что случилось, — включая действия,
 * которые Джарвис выполнил сам, без всякого агента.
 */
let journal: JournalStore | null = null;

/**
 * Что Джарвис только что сказал вслух.
 *
 * Микрофон слышит колонки, и без этого ассистент выполнял собственные реплики
 * как команды — в журнале осталась запись «сделал: Открываю блендер».
 */
const echoGuard = new EchoGuard();

/**
 * Мышь и клавиатура для прямых команд.
 *
 * Тот же драйвер, что у агента, но вызывается напрямую: постоянный процесс
 * PowerShell с построчным протоколом, поэтому после первой команды нажатие
 * стоит миллисекунды, а не полминуты похода к модели.
 */
const desktop = new DesktopDriver();

/**
 * Идёт ли диктовка.
 *
 * Пока идёт, услышанное печатается буква в букву и командами не считается:
 * продиктованное слово «вниз» должно попасть в текст, а не прокрутить
 * страницу. Состояние на уровне модуля, потому что переключают его прямые
 * команды, а читает обработчик речи.
 */
let dictating = false;

/**
 * Сетка с номерами и последняя названная клетка.
 *
 * Клетку надо помнить, чтобы «точнее пять» знало, что уточнять: уточнение —
 * отдельная фраза, потому что «клик сорок пять пять» на слух складывается в
 * пятьдесят.
 */
let gridOverlay: GridOverlay | null = null;
let helpOverlay: HelpOverlay | null = null;
let logWindow: LogWindow | null = null;
let notes: NoteStore | null = null;
let plans: PlanStore | null = null;
/**
 * Разбор прогонов. Заводится всегда, даже если писать не выйдет.
 *
 * Пустышка вместо `null` не из лени: иначе каждое место записи обрастает
 * проверкой, а забытая проверка роняет работу ради журнала — то есть ровно
 * наоборот тому, ради чего он заведён.
 */
const runLogs = new Map<string, RunLogStore>();
/**
 * Показывать ли работу.
 *
 * По умолчанию да: человек просил видеть, что происходит. «Работай в фоне»
 * выключает это до следующего «показывай всё».
 */
let showWork = true;
/**
 * Немой режим: Ctrl+M.
 *
 * Не только останавливает захват, но и глушит уже записанное. Между нажатием
 * и остановкой микрофона успевает уехать последняя фраза — без этой проверки
 * она была бы разобрана и выполнена уже после того, как человек попросил
 * тишины.
 */
let muted = false;
let story: Storyline | null = null;
/** Джарвис целиком — чтобы закрыть его живые процессы при выходе. */
let jarvisRef: Jarvis | null = null;
/** Сколько времени агент тратит на разгон, прежде чем начать дело. */
let timing: StartupTiming | null = null;
let lastCell: number | null = null;
/**
 * Буфер мысли и накладка состояния — видимые из функций уровня модуля.
 *
 * Обе живут внутри start(), но нужны и прямым командам, которые разбираются
 * снаружи. Ссылки здесь — единственный способ дотянуться, не таща их через
 * каждый вызов; присваиваются один раз при запуске.
 */
let thoughtRef: UtteranceBuffer | null = null;
let overlayRef: StatusOverlay | null = null;
let talkRef: TalkSession | null = null;
/** Как остановить мост разговора при выходе. */
let stopTalkBridge: (() => void) | null = null;
/** Как остановить мост вопросов хука красных линий. */
let stopGateBridge: (() => void) | null = null;

/**
 * Убрать обращение в начале — и только в начале.
 *
 * Имя внутри фразы это содержание, а не обращение. Сквозная проверка поймала
 * два случая разом: «переключись на джарвис» превращалось в пустоту, а
 * «напечатай джарвис молодец» — в «молодец». Оба потому, что имя вырезалось
 * откуда угодно и бралось то, что после него.
 */
function withoutLeadingName(text: string): string {
  const found = findWakeWord(text);
  if (!found || found.index !== 0) return text;
  return found.command || text;
}

function setDictation(on: boolean): void {
  dictating = on;
  console.log(on ? '[jarvis] диктовка началась' : '[jarvis] диктовка окончена');
}

/** Выполняет прямую команду. Молча: речь после каждого нажатия невыносима. */
async function runDirectCommand(command: DirectCommand, session: VoiceSession): Promise<void> {
  try {
    switch (command.kind) {
      case 'key':
        await desktop.key(command.keys);
        break;
      case 'scroll':
        await desktop.scroll(command.amount);
        break;
      case 'click':
        await desktop.click({ button: command.button, double: command.double });
        break;
      case 'type':
        await desktop.type(command.text);
        break;
      case 'focus': {
        // Псевдоним нужен по той же причине, что и при закрытии: «хром» в
        // заголовке окна не встречается, а "Chrome" встречается.
        // Оконное имя вперёд пускового: «блендер» как окно это Blender, а
        // запустить его надо ярлыком из меню «Пуск» — это разные строки.
        const alias = windowAlias(command.title) ?? aliasTarget(command.title);
        // Сначала по псевдониму, потом по сказанному вслух. Псевдоним знает
        // имя программы, но окно может называться иначе — «Riot Client» в
        // таблице нет, а сказать про него человек может.
        let found: { title: string } | null = null;
        for (const candidate of [alias, command.title]) {
          if (!candidate) continue;
          try {
            found = await desktop.focus(candidate);
            break;
          } catch {
            // Пробуем следующее написание.
          }
        }
        if (!found) throw new Error(`не нашёл окно «${command.title}»`);
        console.log(`[jarvis] переключился на «${found.title}»`);
        break;
      }
      case 'clickNamed': {
        // Не нашли — не кликаем. Промах мимо названной кнопки хуже отказа:
        // он срабатывает, человек его не ждал, и заметит не сразу.
        const found = await findNamedElement(command.query);
        if (!found) throw new Error(`не нашёл «${command.query}» в активном окне`);
        await desktop.click({ x: found.x, y: found.y });
        console.log(`[jarvis] кликнул «${found.name || found.id}» в (${found.x}, ${found.y})`);
        break;
      }
      case 'dictation':
        // Смена режима — единственное, о чём тут стоит сказать вслух: человек
        // должен знать, что дальше его слова пойдут в текст, а не в команды.
        setDictation(command.on);
        await session.speak(command.on ? 'Диктуйте.' : 'Записал.');
        break;
      case 'grid':
        if (command.on) gridOverlay?.show();
        else gridOverlay?.hide();
        break;
      case 'repeat':
        // Пауза между повторами: без неё приложение не успевает обработать
        // поток нажатий и часть из них теряется.
        for (let index = 0; index < command.times; index += 1) {
          await runDirectCommand(command.command, session);
          if (index + 1 < command.times) await delay(40);
        }
        break;
      case 'help':
        // Команд около восьмидесяти, и та, о которой человек не знает, для
        // него не существует. Список строится из самих таблиц команд.
        if (command.on) {
          helpOverlay?.show();
          await session.speak('Показал, что умею.');
        } else {
          helpOverlay?.hide();
        }
        break;
      case 'longSpeech':
        // Слушатель ждёт дольше и не рвёт мысль на глаголе просьбы. Держится
        // до конца одного сообщения — человек сказал «диктую» про него, а не
        // про весь вечер.
        if (thoughtRef) thoughtRef.listenLong = true;
        console.log('[jarvis] слушаю длинную мысль: пауза до пяти секунд');
        overlayRef?.note(session.status, 'Слушаю длинно — пауза до 5 секунд');
        await session.speak('Слушаю. Говорите.');
        break;
      case 'mode':
        // Режим работы держится до следующего переключения: человек сказал
        // «в фоне» не на одну задачу, а потому что сейчас занят.
        showWork = command.show;
        console.log(`[jarvis] режим: ${showWork ? 'на виду' : 'в фоне'}`);
        overlayRef?.note(session.status, showWork ? 'Работаю на виду' : 'Работаю в фоне');
        await session.speak(showWork ? 'Буду показывать.' : 'Ухожу в фон.');
        break;
      case 'where': {
        // План уже записан на диск. Спрашивать о нём агента значило бы ждать
        // полминуты ради строки, которая лежит в файле.
        await session.speak(planSummary(plans?.read() ?? null));
        break;
      }
      case 'log':
        // Отвечать голосом на «что ты делаешь» бессмысленно: рассказ о работе
        // — это десятки строк, и они уже написаны в окне.
        if (command.on) {
          logWindow?.open();
          await session.speak('Показал.');
        } else {
          logWindow?.close();
        }
        break;
      case 'selfDestruct': {
        // Аварийный выключатель. «Стоп» — вежливая просьба, и зависший агент
        // её не слышит; здесь не спрашивают. Бьём только по своим детям: их
        // pid отмечены при запуске, и ничего чужого в списке быть не может.
        const итог = await reapAll();
        const сколько = итог.killed.length;
        console.log(`[jarvis] убейся: убито ${сколько}, не далось ${итог.failed.length}`);
        note('close', сколько > 0 ? `убил процессов: ${сколько}` : 'убивать было некого');
        await session.speak(сколько > 0 ? `Убил ${сколько}.` : 'Некого убивать.');
        break;
      }
      case 'forgetTalk':
        // Нить рвётся здесь, а не в самой сессии: просьба закрыть разговор не
        // должна зависеть от разговора, который закрывают.
        talkRef?.forget('Человек попросил начать заново');
        note('command', 'забыл нить разговора', ЭХО_РАЗГОВОРА);
        await session.speak('Забыл. Начинаем заново.');
        break;
      case 'dotaOverlay':
        // Окна ещё нет, и делать вид, что есть, нельзя: «показал» без
        // показанного — та самая болезнь, от которой лечится весь этот код.
        await session.speak('Оверлей ещё не готов.');
        break;
      case 'gridClick': {
        const layout = gridOverlay?.layout();
        const point = layout ? cellCenter(command.cell, layout) : null;
        if (!point) throw new Error(`клетки ${command.cell} нет в сетке`);
        lastCell = command.cell;
        await desktop.click({ x: Math.round(point.x), y: Math.round(point.y) });
        break;
      }
      case 'gridRefine': {
        // Уточнять нечего, пока не названа клетка.
        const layout = gridOverlay?.layout();
        if (lastCell === null || !layout) throw new Error('сначала назовите клетку');
        const point = subCellCenter(lastCell, command.sub, layout);
        if (!point) throw new Error(`доли ${command.sub} нет`);
        await desktop.click({ x: Math.round(point.x), y: Math.round(point.y) });
        break;
      }
    }
    note('command', describeDirect(command));
  } catch (error) {
    // Молчание уместно при успехе, но не при отказе: иначе человек думает,
    // что команда прошла, и продолжает говорить в пустоту.
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[jarvis] прямая команда не прошла: ${message}`);
    note('error', `не смог: ${describeDirect(command)}`);
    await session.speak('Не получилось.');
  }
}

/** Ищет названный элемент в активном окне. */
async function findNamedElement(query: string) {
  const window = await desktop.elements();
  const found = chooseElement(query, window.elements);
  console.log(
    `[jarvis] «${query}» среди ${window.elements.length} элементов «${window.title}»: ` +
      (found ? `${found.name || found.id}` : 'не найдено'),
  );
  return found;
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Короткий вид фразы для узкой строки индикатора. */
/**
 * Фраза для плашки состояния.
 *
 * Раньше резалась на 34 знака, и человек не мог понять, что именно Джарвис
 * расслышал: «Начни с того чтобы создать 3D-модель чебураш…» — а дальше могло
 * стоять что угодно. Он сказал прямо: «должна показывать полный, а не
 * обрезанный текст».
 *
 * Теперь режется только то, что не влезет никуда: плашка растёт под текст до
 * восьми строк, и предел здесь — страховка от выдумки распознавателя на
 * полстраницы, а не форматирование.
 */
function short(text: string, limit = 400): string {
  const clean = text.trim().replace(/\s+/gu, ' ');
  return clean.length > limit ? `${clean.slice(0, limit - 1)}…` : clean;
}

/** Выполняет правку продиктованного. */
async function applyDictationEdit(edit: DictationEdit): Promise<void> {
  switch (edit.kind) {
    case 'key':
      await desktop.key(edit.keys);
      return;
    case 'keys':
      for (const key of edit.keys) await desktop.key(key);
      return;
    case 'replace':
      // Стереть последнее слово и напечатать новое: пробел перед словом
      // ctrl+backspace съедает вместе с ним, поэтому возвращаем его сами.
      await desktop.key('ctrl+backspace');
      await desktop.type(`${edit.text} `);
  }
}

function describeDirect(command: DirectCommand): string {
  switch (command.kind) {
    case 'key':
      return `нажал ${command.keys}`;
    case 'scroll':
      return command.amount < 0 ? 'прокрутил вниз' : 'прокрутил вверх';
    case 'click':
      return `кликнул ${command.button === 'right' ? 'правой' : 'левой'}${command.double ? ' дважды' : ''}`;
    case 'type':
      return `напечатал: ${command.text}`;
    case 'focus':
      return `переключился на ${command.title}`;
    case 'dictation':
      return command.on ? 'начал диктовку' : 'закончил диктовку';
    case 'clickNamed':
      return `кликнул по «${command.query}»`;
    case 'grid':
      return command.on ? 'показал сетку' : 'убрал сетку';
    case 'gridClick':
      return `кликнул в клетку ${command.cell}`;
    case 'gridRefine':
      return `уточнил до доли ${command.sub}`;
    case 'help':
      return command.on ? 'показал список команд' : 'убрал список команд';
    case 'log':
      return command.on ? 'показал окно работы' : 'убрал окно работы';
    case 'where':
      return 'сказал, на каком шаге';
    case 'mode':
      return command.show ? 'работаю на виду' : 'работаю в фоне';
    case 'selfDestruct':
      return 'убил процессы агента';
    case 'forgetTalk':
      return 'начал разговор заново';
    case 'dotaOverlay':
      return `оверлей: ${command.mode}`;
    case 'longSpeech':
      return 'слушаю длинно';
    case 'repeat':
      return `${describeDirect(command.command)} ${command.times} раз`;
  }
}

/** Записать событие. Журнал не та вещь, ради которой стоит уронить ответ. */
function note(kind: EventKind, text: string, subject?: string): void {
  try {
    journal?.record({ kind, text, ...(subject ? { subject } : {}) });
  } catch (error) {
    console.error('[jarvis] не записал в журнал:', error);
  }
}

/**
 * Starts the assistant. Safe to call once the app is ready; calling it twice
 * returns the first bridge rather than fighting over the hotkey.
 */
export async function startJarvisVoiceBridge(options: {
  workspace?: string;
  onStatus?(status: VoiceStatus): void;
} = {}): Promise<JarvisVoiceBridge> {
  if (active) return active;

  // Раньше всего остального: если что-то не поднимется, причина должна
  // остаться на диске, а не в закрытом окне консоли.
  const logPath = startLogFile(path.join(path.dirname(journalFile()), 'jarvis.log'));
  if (logPath) console.log(`[jarvis] логи пишутся в ${logPath}`);

  const audioWindow = await createAudioWindow();
  const recogniser = await createSttProcess({
    installRoot: whisperInstallRoot(),
    language: 'ru',
  });
  // Three recognisers, in order of preference, each falling back to the next.
  //
  // The graphics card first: measured at 425 ms per phrase here, which matches
  // the hosted service and costs nothing. The cloud second, for when the local
  // server is not up. The bundled CPU recogniser last, so the assistant is
  // never simply deaf — it is slow there, around ten seconds, but it answers.
  const cloudKey = process.env.ELEVENLABS_API_KEY?.trim();
  const cloud: Transcriber | null = cloudKey
    ? createElevenLabsTranscriber({ apiKey: cloudKey, language: 'ru', fallback: recogniser })
    : null;

  const gpuEndpoint = await waitForWhisperServer();
  const gpuReady = gpuEndpoint !== null;
  const engine: Transcriber = gpuEndpoint
    ? createGpuTranscriber({ endpoint: gpuEndpoint, language: 'ru', fallback: cloud ?? recogniser })
    : cloud ?? recogniser;

  console.log(
    `[jarvis:stt] распознавание: ${
      gpuReady
        ? 'видеокарта (large-v3-turbo)'
        : cloud
          ? 'ElevenLabs Scribe'
          : 'локальный Whisper на процессоре'
    }`,
  );

  // Every path into the session goes through here, so the room's noises are
  // filtered once rather than at each caller.
  const transcriber: Transcriber = {
    async transcribe(samples, sampleRate) {
      const { text } = await engine.transcribe(samples, sampleRate);

      // Исправление систематических ослышек — до любых разборов.
      //
      // Замерено прогоном синтезированных команд через настоящий
      // распознаватель: «блендер» он слышит как «блиндер», «громче» как
      // «Уромче», «хватит» как «Ватя». Ниже по течению это выглядело как
      // «Джарвис не понял команду».
      const corrected = fixMishearings(text);
      if (corrected !== text) console.log(`[jarvis] расслышал точнее: ${text} → ${corrected}`);

      const speech = meaningfulSpeech(corrected);
      if (!speech && text.trim()) console.log(`[jarvis] шум, пропускаю: ${text}`);
      return { text: speech ?? '' };
    },
  };

  const playback = createPlayback(audioWindow);
  const capture = createPushToTalkCapture(audioWindow);

  // Without a workspace the interpreter runtime reports itself unready and
  // steps aside, and since the other backends cannot drive the desktop, every
  // «открой хром» came back as "ни один backend не смог". The app already has
  // a workspace open; Jarvis just has to be told which one.
  const workspace = options.workspace ?? getCurrentWorkspace() ?? undefined;
  console.log(`[jarvis] рабочая папка: ${workspace ?? 'не выбрана'}`);

  // Кого сейчас спрашивают. Пока здесь кто-то есть, следующая фраза — ответ,
  // а не команда.
  let awaitingAnswer: ((answer: 'yes' | 'no') => void) | null = null;

  // Незаконченная мысль человека. Пауза после фразы — часть фразы, пока он
  // может её продолжить.
  const thought = new UtteranceBuffer();
  thoughtRef = thought;
  let thoughtTimer: NodeJS.Timeout | null = null;

  function scheduleThought(): void {
    if (thoughtTimer) clearTimeout(thoughtTimer);

    thoughtTimer = setTimeout(() => {
      thoughtTimer = null;
      // Пока ждали, человек мог заговорить снова — тогда ждём дальше.
      if (!thought.isComplete()) {
        scheduleThought();
        return;
      }

      const whole = thought.take();
      if (!whole) return;

      console.log(`[jarvis] мысль целиком: ${whole}`);

      // Дальше решает разговор, а не таблица слов-примет.
      //
      // Здесь стояла угадайка: «а пока» значило вторую задачу, «туда же» —
      // поправку, вопрос отличался от не-вопроса знаком, а всё непонятое
      // падало в ящик правок с ответом «Учту». Человек спросил «ты понял что
      // надо делать?», получил «Учту» и тишину — и был прав, что возмутился.
      //
      // Слова остановки, «тишина» и прямые команды сюда не доходят: они
      // разобраны выше и обязаны срабатывать мгновенно. Всё остальное —
      // разговор, и он же решает, отвечать, поправлять, заводить работу или
      // гасить её.
      //
      // Цена названа заранее: ответ стоит три-пять секунд против мгновенного
      // «Учту». Человек выбрал это сам.

      // Вежливость и обрывки распознавателя в разговор не идут: три секунды
      // модели за «ага» — плохая сделка, и отвечать там нечего.
      const пустое = obviousAside(whole);
      if (пустое?.kind === 'ignore') {
        console.log(`[jarvis] мимо (${пустое.why}): ${whole}`);
        return;
      }

      note('command', `сказал: ${whole}`, ЭХО_РАЗГОВОРА);
      story?.heard(whole, Date.now());
      overlay.note(session.status, `Слушаю: ${short(whole)}`);
      void talk.hear(whole).catch((error: unknown) => {
        console.error('[jarvis] разговор не справился:', error);
      });
    }, Math.max(50, thought.msUntilComplete()));

    thoughtTimer.unref?.();
  }

  // Папка нужна и агенту внутри MCP-сервера, и нам здесь, когда придёт пора
  // сказать человеку, где лежит результат.
  const outputDir = ensureOutputDir();

  // Журнал открывается до ядра: первые же действия должны попасть в него, а
  // не пропасть, пока всё поднимается.
  journal = openJournal();

  // Ящик правок: сюда ложится сказанное во время работы, оттуда агент забирает
  // это инструментом check_notes. Старое чистим на старте — правка, сказанная
  // в прошлый запуск, к нынешней работе не относится.
  notes = new NoteStore(notesFile());
  notes.clear();
  console.log(`[jarvis] ящик правок: ${notesFile()}`);

  // Разбор прогонов: полный ход каждой задачи, по файлу на задачу. Ради
  // случая, когда работа сорвалась и нужно узнать, на чём именно — а не
  // услышать последнюю по счёту ошибку от того, кто взялся уже после срыва.
  console.log(`[jarvis] разбор прогонов: ${runsDir()}`);

  // План работы — тот же файл, что пишет агент. Старый не стираем: работа
  // могла прерваться перезапуском, и её надо продолжить, а не забыть.
  plans = new PlanStore(planFile());
  console.log(`[jarvis] план работы: ${planFile()}`);

  // Характер: постоянные указания человека, которые он правит сам. Файл
  // перечитывается на каждую задачу, поэтому правка действует сразу.
  const instructions = new StandingInstructions(
    path.join(path.dirname(journalFile()), 'характер.md'),
  );
  console.log(`[jarvis] характер: ${instructions.ensure()}`);

  // Красные линии на каждом инструменте агента, а не только на фразе: хук
  // спрашивает человека голосом о чувствительном действии прямо перед ним.
  const gate = prepareGate({
    appRoot: app.getAppPath(),
    dataDir: path.dirname(journalFile()),
    outputDir,
    homeDir: jarvisHome(),
  });
  if (gate.ok) {
    const gateBridge = new GateBridge(gate.bridgeDir);
    gateBridge.clear();
    stopGateBridge = gateBridge.serve((question) => {
      note('command', `спрашиваю: ${question.summary}`);
      return askForApproval(question.summary, session, (waiter) => {
        awaitingAnswer = waiter;
      });
    });
    console.log(`[jarvis] красные линии на инструментах: ${gate.settings}`);
  } else {
    console.log(`[jarvis] красные линии только на фразах, без оболочки у агента: ${gate.reason}`);
  }

  const jarvis = createJarvis({
    workspace,
    desktopMcpConfig: writeDesktopMcpConfig(outputDir),
    gateSettings: gate.ok ? gate.settings : undefined,
    homeDir: jarvisHome(),
    outputDir,
    recentActions: () => journal?.context() ?? [],
    // Чем занята работа прямо сейчас. Нужно, чтобы ответить на вопрос,
    // заданный во время работы: план лежит в файле, который пишет другой
    // процесс, и в состоянии мира его нет.
    // Составленный план сразу ложится в файл, который читает окно: человек
    // должен увидеть замысел, а не только услышать сводку.
    savePlan: (план) => { plans?.write(план); },
    workNow: () => {
      const план = plans?.read();
      if (!план) return [];
      return [
        'Прямо сейчас идёт работа. Вот её план и ход:',
        renderPlan(план),
      ];
    },
    instructions: () => instructions.read(),
    // Самонаращивающийся кусок промпта: неудача, записанная в журнал, сама
    // становится строкой следующего поручения. Ни обучения, ни денег.
    showWork: () => showWork,
    lessons: () =>
      describeLessons(
        lessonsFrom({ events: journal?.recent() ?? [], plans: [plans?.read() ?? null] }),
      ) ?? undefined,
    speak: (text) => { void playback.speak(text); },
    // Настоящая остановка, а не пустая реплика: см. stopSpeaking в ядре.
    stopSpeaking: () => { session.stopSpeaking(); },
    // Жёлтый — разговор. Человек попросил видеть разницу с одного взгляда.
    showIndicator: (what) => { session.showIndicator(what); },
    approve: (request) =>
      askForApproval(request.summary, session, (waiter) => {
        awaitingAnswer = waiter;
      }),
  });
  // Ссылка наружу: при выходе надо закрыть живые процессы агента.
  jarvisRef = jarvis;
  await jarvis.ready();

  // Speech has failed twice now for want of a file in a place nobody printed.
  const voiceReady = await isTtsModelInstalled(DEFAULT_TTS_MODEL_ID);
  const voiceRoot = path.join(
    getTtsInstallRoot(),
    DEFAULT_TTS_MODEL_ID,
    'vits-piper-ru_RU-irina-medium',
  );
  console.log(`[jarvis] голос ${voiceReady ? 'готов' : 'НЕ НАЙДЕН'}: ${voiceRoot}`);
  if (!voiceReady) {
    // Name the file that is missing. The same check passes outside Electron
    // against the same folder, so the disagreement is worth pinning down
    // rather than guessing at.
    for (const file of ['', 'ru_RU-irina-medium.onnx', 'tokens.txt', 'espeak-ng-data']) {
      const full = file ? path.join(voiceRoot, file) : voiceRoot;
      try {
        await access(full);
        console.log(`[jarvis]   есть: ${file || '(каталог)'}`);
      } catch (error) {
        console.log(`[jarvis]   НЕТ: ${file || '(каталог)'} — ${String(error)}`);
      }
    }
  }

  const overlay = createStatusOverlay();
  overlayRef = overlay;
  gridOverlay = createGridOverlay();
  helpOverlay = createHelpOverlay();
  logWindow = createLogWindow();

  const session = new VoiceSession({
    core: jarvis.core,
    capture,
    transcriber,
    playback,
    mode: 'always-listening',
    // A minute of open conversation after the name. Long enough to work
    // without repeating it, short enough that a mention on a video call does
    // not leave the microphone armed indefinitely.
    wakeWord: { awakeWindowMs: AWAKE_WINDOW_MS },
    onStatus: (status) => {
      console.log(`[jarvis] ${status.label}`);
      overlay.update(status);
      options.onStatus?.(status);
    },
    onTranscript: (text) => console.log(`[jarvis] услышал: ${text}`),
    onError: (message) => console.error(`[jarvis] ошибка: ${message}`),
  });

  // Ambient speech: the page decides where an utterance ends, the recogniser
  // turns it into text, and the session decides whether the wake word or a
  // control word makes it worth acting on.
  // Actions must not pile up either. Closing used to take fifteen seconds, so
  // repeated «закрой ...» stacked and each answer arrived attached to whatever
  // the user had said since. One at a time, and a repeat while it runs is the
  // same request said twice, not two requests.
  let actionInFlight: string | null = null;
  const runAction = async (label: string, action: () => Promise<void>): Promise<void> => {
    if (actionInFlight) {
      console.log(`[jarvis] уже выполняю «${actionInFlight}», пропускаю «${label}»`);
      return;
    }
    actionInFlight = label;
    try {
      await action();
    } finally {
      actionInFlight = null;
    }
  };

  /**
   * Разговор, идущий вторым потоком рядом с работой.
   *
   * Всё, что не разобрано выше как прямая команда, попадает сюда — и решает
   * человек в разговоре, а не таблица слов-примет. До 22.09.2026 решала
   * таблица: «а пока» значило вторую задачу, «туда же» — поправку, а вопрос
   * отличался от не-вопроса знаком. Человек сказал про это прямо, когда на
   * «ты понял что надо делать?» получил «Учту» и тишину.
   *
   * Руки у разговора чужие: пять глаголов, и каждый из них идёт через
   * рабочий поток со всеми разрешениями человека.
   */
  const talkBridgeDir = path.join(path.dirname(journalFile()), 'talk-bridge');
  const talk = new TalkSession({
    cliPath: async () => {
      const все = await jarvis.backends.availability();
      const клод = все.find((b) => b.id === 'claude-code');
      return клод?.ready && клод.path ? клод.path : null;
    },
    // Дом Джарвиса, а не рабочая папка: разговору нечего делать в коде.
    cwd: jarvisHome(),
    mcpConfig: writeTalkMcpConfig(talkBridgeDir),
    delta: { journalFile: journalFile(), planFile: planFile() },
    state: () => {
      const план = plans?.read() ?? null;
      return {
        work: план ? renderPlan(план).split('\n') : [],
        recent: journal?.context() ?? [],
        instructions: instructions.read(),
      };
    },
    // Через сессию, а не мимо неё: у ответа должен быть свой значок, а окно
    // слушания обязано открыться заново от конца фразы.
    speak: (text) => session.speak(text),
    log: (line) => console.log(`[jarvis] ${line}`),
  });
  talkRef = talk;

  // Подъём сессии — в момент запуска, когда никто не ждёт.
  //
  // Замер живой проверки: первая фраза за вечер 12,7 с, третья 5,8 с. Большая
  // часть разницы — не размышление, а подъём процесса CLI и его MCP-сервера.
  // Ход при этом не тратится: молчащий процесс стоит памяти, но не подписки.
  void talk.warm().catch((error: unknown) => {
    console.error('[jarvis] не удалось прогреть разговор:', error);
  });

  // Два глагола из пяти живут здесь: менеджер задач — в этом процессе, а
  // рычаги разговора — в чужом.
  const talkBridge = new TalkBridge(talkBridgeDir);
  // Просьба, пережившая перезапуск, — не память, а неожиданность.
  talkBridge.clear();
  stopTalkBridge = talkBridge.serve((request) => {
    if (request.kind === 'stop') {
      const работа = jarvis.tasks.foreground();
      if (!работа) return { ok: false, text: 'Сейчас ничего не идёт.' };
      jarvis.tasks.cancel(работа.id);
      note('command', `разговор остановил: ${работа.title}`);
      console.log(`[jarvis] разговор остановил работу: ${работа.title}`);
      return { ok: true, text: `Остановил: ${работа.title}` };
    }

    if (request.kind === 'pause') {
      // Отложить — не то же, что погасить: сессия агента остаётся, и он
      // продолжит с того места, а не начнёт заново.
      const работа = jarvis.tasks.foreground();
      if (!работа) return { ok: false, text: 'Сейчас ничего не идёт.' };
      if (!jarvis.tasks.pause(работа.id)) {
        return { ok: false, text: `«${работа.title}» отложить не вышло.` };
      }
      note('command', `разговор отложил: ${работа.title}`);
      console.log(`[jarvis] разговор отложил работу: ${работа.title}`);
      return { ok: true, text: `Отложил: ${работа.title}` };
    }

    if (request.kind === 'resume') {
      const отложенная = jarvis.tasks.resumableTask();
      if (!отложенная) return { ok: false, text: 'Продолжать нечего.' };
      if (!jarvis.tasks.resume(отложенная.id)) {
        // Законченную работу продолжить нечем: она не отложена, а прожита.
        return { ok: false, text: `«${отложенная.title}» уже не продолжить.` };
      }
      note('command', `разговор продолжил: ${отложенная.title}`);
      console.log(`[jarvis] разговор продолжил работу: ${отложенная.title}`);
      return { ok: true, text: `Продолжаю: ${отложенная.title}` };
    }

    const задача = request.text?.trim();
    if (!задача) return { ok: false, text: 'Не сказано, что делать.' };

    // Обычным путём, а не своим запуском: иначе потеряется маршрутизация,
    // имя задачи, перевод идущей работы в фон и — главное — разрешения.
    //
    // Но не через `acceptAmbientTranscript`: там фраза снова проходит проверку
    // «а работа ли это», и низкая уверенность разбора вернула бы «Не понял,
    // что именно сделать» на то, о чём разговор с человеком уже договорился.
    note('command', `разговор поручил: ${задача}`);
    console.log(`[jarvis] разговор поручил: ${задача}`);
    void session.work(задача).catch((error: unknown) => {
      console.error('[jarvis] не удалось завести работу по просьбе разговора:', error);
    });
    return { ok: true, text: `Запускаю: ${short(задача)}` };
  });

  // Recognition is slower than speech arrives, so utterances must not queue.
  // Observed before this guard: a phrase waited 45 seconds behind a backlog of
  // room noise, by which time the user had given up and said it again. A
  // dropped noise costs nothing; a late answer costs the whole interaction.
  let recognising = false;

  /**
   * Очередь речи, а не замок на ней.
   *
   * Замок стоил дорого: пока распознавалась одна фраза, следующая
   * выбрасывалась. В журнале одной сессии — тридцать семь потерянных фраз, и
   * среди них середина «отправь привет в чатгпт», от которой осталось два
   * «отправь». Человек говорит слитно, а распознавание идёт секунду-две, и
   * ровно в этот промежуток попадает продолжение мысли.
   *
   * Очередь ограничена: если отстали на десяток фраз, старые уже не про то,
   * что происходит сейчас.
   */
  const pending: RecordedAudio[] = [];
  // Коротко нарочно: слово остановки не должно ждать за спиной старых фраз.
  const MAX_PENDING = 3;

  const drainSpeech = (): void => {
    if (recognising) return;
    const next = pending.shift();
    if (!next) return;
    recognising = true;
    void handleUtterance(next).finally(() => {
      recognising = false;
      // Следующая фраза ждала своей очереди, а не пропала.
      if (pending.length > 0) drainSpeech();
    });
  };

  ipcMain.on(AUDIO_BRIDGE_CHANNELS.utterance, (_event, payload: RecordedAudio | null) => {
    if (!payload) return;

    pending.push(payload);
    if (pending.length > MAX_PENDING) {
      // Выбрасываем самое старое: оно уже не про текущий разговор.
      pending.shift();
      console.log('[jarvis] очередь речи переполнена, отбросил самую старую фразу');
    }
    drainSpeech();
  });

  async function handleUtterance(payload: RecordedAudio): Promise<void> {
    // Немой режим — раньше всего, даже раньше распознавания: тратить на
    // выключенный микрофон секунду работы видеокарты незачем.
    if (muted) return;
    {
      try {
        const samples = toFloat32(payload.samples);
        const started = Date.now();
        const { text } = await transcriber.transcribe(samples, payload.sampleRate);
        const seconds = (samples.length / payload.sampleRate).toFixed(1);

        if (!text) return;
        // Ещё раз, уже после распознавания. Между входом сюда и готовым
        // текстом проходит полсекунды, и человек успевает нажать Ctrl+M —
        // замечено в логе: фраза, сказанная до нажатия, доезжала после него.
        if (muted) return;
        const cut = payload.closedBy === 'length' ? ', обрезано' : '';
        const share =
          typeof payload.speechShare === 'number'
            ? `, речи ${Math.round(payload.speechShare * 100)}%`
            : '';
        console.log(
          `[jarvis] услышал за ${Date.now() - started} мс (${seconds} с речи${cut}${share}): ${text}`,
        );
        overlay.note(session.status, `Услышал: ${short(text)}`);

        // Свой же голос из колонок. Слова перебивания сюда не попадают — они
        // должны доходить всегда.
        if (echoGuard.isOwnVoice(text)) {
          console.log(`[jarvis] это моя собственная фраза, пропускаю: ${text}`);
          overlay.note(session.status, 'Это был мой голос');
          return;
        }

        // «Открой хром» is answered here rather than by the agent: a second
        // instead of minutes, and it either happens or says why.
        // Диктовка перехватывает раньше любых разборов: в режиме записи текста
        // нет команд, есть только слова человека.
        if (dictating) {
          if (endsDictation(text) || isSilenceRequest(text)) {
            dictating = false;
            console.log('[jarvis] диктовка окончена');
            note('command', 'закончил диктовку');
            await session.speak('Записал.');
            return;
          }
          // Правка на ходу: диктовка без неё нерабочая. Список точных фраз
          // крошечный нарочно — всё остальное печатается буквами.
          const edit = parseDictationEdit(text);
          if (edit) {
            console.log(`[jarvis] правка диктовки: ${text}`);
            try {
              await applyDictationEdit(edit);
            } catch (error) {
              console.error('[jarvis] правка не прошла:', error);
              await session.speak('Не получилось.');
            }
            session.keepAwake();
            return;
          }

          console.log(`[jarvis] диктую: ${text}`);
          try {
            await desktop.type(text);
          } catch (error) {
            console.error('[jarvis] не удалось напечатать:', error);
            await session.speak('Не получилось напечатать.');
          }
          session.keepAwake();
          return;
        }

        // Если задан вопрос — это ответ на него, а не новая команда.
        if (awaitingAnswer) {
          const answer = readConfirmation(text);
          if (answer === 'unclear') {
            console.log(`[jarvis] ответ не понят: ${text}`);
            await session.speak('Не понял. Скажите «да» или «нет».');
            return;
          }
          console.log(`[jarvis] ответ: ${answer === 'yes' ? 'да' : 'нет'}`);
          const waiter = awaitingAnswer;
          awaitingAnswer = null;
          waiter(answer);
          return;
        }

        const awake = session.status.awake;
        // Имя убирается всегда, даже когда его можно было не говорить.
        //
        // Разбуженный Джарвис слушает и без имени — но человек всё равно
        // говорит «Джарвис, переключись на Riot Client», так естественнее. До
        // 20.09.2026 в разбуженном состоянии имя оставалось в тексте, и мимо
        // проходило всё сразу: прямые команды, запуск программы, закрытие
        // окна. Каждая такая фраза уходила агенту — тридцать секунд вместо
        // трёхсот миллисекунд, а во время работы и вовсе становилась заметкой.
        // В журнале это выглядело как «не переключает вкладки, не работает
        // ничего», и так оно и было.
        const command = awake ? withoutLeadingName(text) : findWakeWord(text)?.command;

        // Разбуженный Джарвис слушает без имени и принимает за команду всё
        // подряд — включая разговор в комнате. Там, где имя прозвучало,
        // фильтровать нечего: человек обратился к нему намеренно.
        //
        // И нечего фильтровать, пока идёт разговор. Фильтр отсекает всё, что
        // начинается с «а», «нет», «это», — то есть ровно то, чем человек
        // продолжает начатое: «а теперь синюю», «нет, другую». Внутри
        // открытого разговора это не болтовня, а следующая реплика, и терять
        // её нельзя: человек сказал прямо — «просто говорить с ним нельзя, а
        // надо».
        // Пока разговор жив, «не команда» — неверный ответ.
        //
        // Этот фильтр отсекал всё, что начинается со «слушай», «а», «короче»,
        // — то есть ровно то, чем человек заговаривает. Раньше это спасало:
        // отвечать было некому, и такая фраза ушла бы агенту задачей. Теперь
        // есть разговор, и у него есть право промолчать; решать, была ли это
        // речь к нему, должен он, а не список первых слов.
        //
        // Запасной путь остаётся: если Claude Code не найден, сессия разговора
        // не поднимется, и фильтр снова станет нужен.
        const talking = talk.isAlive() || jarvis.core.hasOpenConversation();
        if (awake && command && !talking && looksLikeChatter(text)) {
          console.log(`[jarvis] разговор не со мной, пропускаю: ${text}`);
          // Человек должен видеть, что услышано и почему ничего не произошло —
          // иначе молчание выглядит поломкой.
          overlay.note(session.status, `«${short(text)}» — не команда`);
          return;
        }
        console.log(
          `[jarvis] разбор: awake=${awake} command=${JSON.stringify(command ?? null)}` +
            ` close=${JSON.stringify(command ? spokenCloseTarget(command) : null)}` +
            ` open=${JSON.stringify(command ? spokenTarget(command) : null)}`,
        );
        // «Тишина» closes the listening window at once. It is handled before
        // the wake gate on purpose: telling an assistant to be quiet has to
        // work while it is awake, which is exactly when it is not listening
        // for its own name.
        if (isSilenceRequest(text)) {
          console.log('[jarvis] тишина — закрываю окно слушателя');
          session.sleep();
          return;
        }

        // Остановка идёт первой и без задержки.
        //
        // «Отмена» разбиралась как клавиша Escape и до отмены задачи не
        // доходила вовсе. А буфер склейки задержал бы «стоп» на две с
        // половиной секунды — ровно тогда, когда человек хочет прекратить
        // происходящее немедленно.
        if (command && matchVoiceControl(command)) {
          console.log(`[jarvis] слово остановки: ${command}`);
          thought.take();
          if (thoughtTimer) {
            clearTimeout(thoughtTimer);
            thoughtTimer = null;
          }
          await session.acceptAmbientTranscript(text);
          return;
        }

        // Прямые команды — раньше всего остального, что делает работу.
        //
        // «Прокрути вниз», «нажми Enter», «скопируй» не требуют размышления, а
        // через агента стоят полминуты каждая: он читает запрос, думает, зовёт
        // инструменты, отвечает. К моменту ответа человек сделал бы сам.
        // Совпадение с таблицей точное, поэтому «найди отчёт за март» сюда не
        // попадает и уходит агенту, как и должно.
        const direct = command ? parseDirectCommand(command) : null;

        if (direct?.kind === 'clickNamed') {
          // Клик по названию — единственная прямая команда, которая может
          // честно не найтись. Тогда она не ошибка, а повод посмотреть на
          // экран: задача уходит агенту, а не упирается в «не получилось».
          const found = await findNamedElement(direct.query);
          if (found) {
            await runAction(`клик по «${direct.query}»`, async () => {
              await desktop.click({ x: found.x, y: found.y });
              note('command', `кликнул «${found.name || found.id}»`);
            });
            session.keepAwake();
            return;
          }
          console.log('[jarvis] названное не найдено — отдаю агенту');
        }

        // Мелкая правка в открытом блендере — мимо агента.
        //
        // Идёт до прямых команд: «подними повыше» в живом окне значит движение
        // объекта, а не прокрутку страницы.
        const edit = parseLiveEdit(command ?? '');
        if (edit) {
          if (!isLive()) {
            // Молчаливый уход к агенту здесь — худший исход: он откроет новое
            // окно и сделает не то. Секунда честного отказа лучше двух минут
            // не туда.
            await session.speak('Блендер не открыт.');
            session.keepAwake();
            return;
          }

          await runAction(edit.said, async () => {
            const answer = await sendLive(edit.code);
            if (!answer.ok) throw new Error(answer.error ?? 'не вышло');
            note('command', `правка: ${edit.said}`);
          });
          session.keepAwake();
          return;
        }

        if (direct) {
          await runAction(describeDirect(direct), () => runDirectCommand(direct, session));
          session.keepAwake();
          return;
        }

        // Closing is asked for as often as opening, and going through the
        // agent costs the same minutes for the same trivial action.
        const toClose = command ? spokenCloseTarget(command) : null;
        if (toClose) {
          // Принудительное закрытие теряет несохранённое, а имя процесса
          // подобрано по расслышанному слову — поэтому только с согласия.
          const confirm = (summary: string) =>
            askForApproval(summary, session, (waiter) => {
              awaitingAnswer = waiter;
            });
          // Не ждём здесь: фразы разбираются по одной, и ответ «да» встал бы
          // в очередь за этим же вопросом.
          void runAction(`закрыть ${toClose}`, () =>
            closeApplication(toClose, /убей/u.test(command ?? ''), session, confirm),
          ).catch((error: unknown) => {
            console.error('[jarvis] закрытие не удалось:', error);
          });
          session.keepAwake();
          return;
        }

        const launch = command ? matchAppLaunch(command) : null;
        if (launch) {
          await runAction(`открыть ${launch.spokenName}`, () =>
            launchApplication(launch.target, launch.spokenName, session));
          session.keepAwake();
          return;
        }

        // Not a known alias — but the Start menu lists everything installed,
        // so «открой лигу» can still be answered without a model.
        const wanted = command ? spokenTarget(command) : null;
        if (wanted) {
          // Search under the English name too when one is known. «Хром» on its
          // own sounds as close to "Dev Home" as to "Chrome", and the tie went
          // to whichever came first in the list.
          const searchable = [aliasTarget(wanted), wanted].filter(Boolean).join(' ');
          const found = chooseShortcut(searchable, await listStartMenuShortcuts(), (s) => s.name);
          if (!found) {
            // Saying so beats sending a two-word request to the agent, which
            // costs minutes and, on this runtime, tends to report success for
            // something it never did.
            console.log(`[jarvis] «${wanted}» не нашёл среди установленных`);
            await session.speak(`Не нашёл ${wanted}.`);
            session.keepAwake();
            return;
          }
          {
            console.log(`[jarvis] «${wanted}» -> ${found.item.name}`);
            await launchApplication(found.item.target, wanted, session, found.item.kind);
            session.keepAwake();
          return;
          }
        }

        // Мысль целиком, а не первая её фраза. Человек говорит «у тебя в
        // картинках лежит красная сфера», потом «сделай её 3d модель» — это
        // одна задача, и вторая половина без первой бессмысленна.
        //
        // Копится только обращённое к Джарвису. Речь мимо него уходит дальше
        // как есть: там свой разбор имени, и складывать в журнал «окей, good
        // luck» как просьбу — значит засорять память тем, чего не просили.
        if (command) {
          // Запись, закрытая по потолку, а не по тишине, — это человек,
          // которого прервали на середине фразы. Сборщик дождётся хвоста.
          thought.push(text, { unfinished: payload.closedBy === 'length' });
          scheduleThought();
          return;
        }

        await session.acceptAmbientTranscript(text);
      } catch (error) {
        console.error('[jarvis] не удалось распознать:', error);
      }
    }
  }

  // Barge-in: the moment the user speaks over the assistant, it stops talking.
  ipcMain.on(AUDIO_BRIDGE_CHANNELS.speechStarted, () => {
    if (playback.isSpeaking()) {
      console.log('[jarvis] перебили — замолкаю');
      session.stopSpeaking();
    }
  });

  ipcMain.on(AUDIO_BRIDGE_CHANNELS.error, (_event, message: string) => {
    console.error(`[jarvis] аудио: ${message}`);
  });

  if (process.env.JARVIS_STT_SELFTEST === '1') {
    await runRecogniserSelfTest(transcriber);
  }

  // Nothing else tells the session that work ended, so without this the
  // indicator stays on «Работаю» forever and the answer is never spoken —
  // the assistant does the job and then says nothing about it.
  // Голос во время работы.
  //
  // Задача про блендер честно отрабатывает за две минуты, и всё это время
  // Джарвис молчал. Человек, прождав пятьдесят секунд, решил, что он сломался,
  // и сказал «спасибо» и «пока» — каждая фраза запустила новую задачу, а
  // готовый ответ пришёл в пустоту. Молчание длиннее полуминуты неотличимо от
  // поломки.
  const progress = new ProgressVoice();

  // Рассказ о работе — то же самое глазами, и без скупости голоса: строка на
  // каждый шаг, с именем файла и текстом команды.
  story = new Storyline({ onLine: (line) => logWindow?.append(line) });

  /**
   * Показывать работу, не дожидаясь вопроса.
   *
   * Двадцать секунд — граница, за которой задача перестаёт быть «секунду
   * подожди». Ровно с этого мгновения начинает говорить и голос; глазам
   * рассказ нужен не меньше, а спрашивать «что ты делаешь» каждый раз —
   * лишняя работа для человека.
   *
   * Один раз на задачу. Закрыл — значит не хотел: снова открывать посреди той
   * же работы было бы навязчивостью.
   */
  const AUTO_OPEN_AFTER_MS = 20_000;
  let autoOpenedFor: string | null = null;

  /**
   * Состояния шагов, которые уже показаны.
   *
   * План пишет другой процесс, и узнать о правке можно только заглянув в файл.
   * Пять секунд задержки здесь незаметны: шаг живёт минуты.
   */
  let shownSteps: string[] = [];

  function showPlanChanges(): void {
    const plan = plans?.read();
    if (!plan) {
      shownSteps = [];
      return;
    }

    const states = plan.steps.map((step) => step.state);
    for (let index = 0; index < states.length; index += 1) {
      const state = states[index] as string;
      // «Ждёт» — не событие, а исходное положение вещей.
      if (state === 'ждёт' || shownSteps[index] === state) continue;
      const step = plan.steps[index];
      if (!step) continue;
      story?.planStep(
        index,
        states.length,
        step.note ? `${step.text} — ${step.note}` : step.text,
        state,
        Date.now(),
      );
    }
    shownSteps = states;
  }

  const progressTimer = setInterval(() => {
    showPlanChanges();

    const running = jarvis.tasks.foreground();
    if (!running) return;

    const since = running.startedAt ?? running.createdAt;
    if (autoOpenedFor !== running.id && Date.now() - since >= AUTO_OPEN_AFTER_MS) {
      autoOpenedFor = running.id;
      logWindow?.open();
    }

    // Перебивать себя и человека нельзя: доклад подождёт.
    if (playback.isSpeaking()) return;

    const line = progress.due();
    if (line) void session.speak(line);
  }, 5_000);
  progressTimer.unref?.();

  jarvis.tasks.subscribe((event) => {
    if (event.type === 'task-event') {
      runLogs.get(event.task.id)?.saw(event.event);
      progress.saw(event.event);
      story?.saw(event.event, Date.now());
      timing?.saw(event.event, Date.now());

      // Кто взялся за работу — в лог, а не только в окно.
      //
      // Этого не было, и цена оказалась высокой: когда блендер не открылся,
      // выяснить, что задачу вёл интерпретер со своим заблокированным
      // драйвером, а не Claude Code с инструментами Джарвиса, удалось только
      // по косвенным следам чужих подсистем. Одна строка избавляет от получаса
      // догадок.
      if (event.event.type === 'started') {
        console.log(
          `[jarvis] задачу ведёт ${event.event.backend}` +
            (event.event.sessionId ? ` (сессия ${event.event.sessionId.slice(0, 8)})` : ''),
        );
      }
      if (event.event.type === 'error') {
        console.log(`[jarvis] бэкенд ${event.event.backend} сорвался: ${event.event.message}`);
      }
      return;
    }
    if (event.type === 'task-created') {
      const log = new RunLogStore(runsDir());
      log.begin({
        title: event.task.title,
        prompt: event.task.request.utterance,
        cwd: event.task.request.cwd ?? '(папка не задана)',
        capabilities: event.task.request.capabilities,
        driver: driverStamp(),
      });
      runLogs.set(event.task.id, log);
      progress.reset();
      // Новая глава: без неё лента сливается в один нечитаемый поток.
      story?.begin(event.task.title, Date.now());
      timing = new StartupTiming(Date.now());
      return;
    }
    if (event.type !== 'task-finished') return;
    progress.reset();

    session.taskFinished();

    const result = event.task.result;
    const answer = result?.ok
      ? toSpokenResponse(result.text, { fallback: 'Готово.' }).spoken
      : spokenFailure(result?.error ?? 'Не получилось.');

    // Где лежит результат, знает не ответ модели, а диск. Модель однажды
    // сообщила, что картинка «в чате с Джарвисом», — такого места нет, и
    // человек остался без файла, который был уже сделан.
    const made = result?.ok
      ? describeArtifacts(result.filesChanged ?? [], { outputDir, workspace })
      : null;

    const spokenLocation =
      made && !answer.includes(path.basename(made.paths[0])) ? made.spoken : undefined;
    const full = [answer, spokenLocation].filter(Boolean).join(' ');

    // Итог — в журнал прогона, и только потом закрываем файл. Событие
    // завершения до подписчиков не доходит: менеджер обрывает поток на нём.
    const log = runLogs.get(event.task.id);
    if (result) log?.saw({ type: 'completed', backend: result.backend, result });
    const runFile = log?.current() ?? null;
    log?.end();
    runLogs.delete(event.task.id);

    const spent = timing?.report();
    if (spent) console.log(`[jarvis] разгон: ${spent}`);
    // Путь к разбору — рядом с итогом, чтобы не искать его потом по папке.
    if (runFile && !result?.ok) console.log(`[jarvis] разбор прогона: ${runFile}`);
    console.log(`[jarvis] задача «${event.task.title}» — ${event.task.state}: ${full}`);
    if (made) console.log(`[jarvis] файлы: ${made.paths.join(', ')}`);

    // Событие завершения до подписчиков не доходит — менеджер задач обрывает
    // поток на нём. А это ровно та строка, ради которой окно и открывали.
    if (result) {
      story?.saw({ type: 'completed', backend: result.backend, result }, Date.now());
    }
    for (const file of made?.paths ?? []) {
      story?.saw(
        { type: 'file-changed', backend: result?.backend ?? 'claude-code',
          change: { path: file, action: 'created' } },
        Date.now(),
      );
    }

    // В журнал — итог задачи и каждый файл отдельно. Именно про файл человек
    // спросит позже: «а где картинка», «покажи тот отчёт».
    // Причина неудачи, а не только её факт.
    //
    // Раньше в журнал уходило «не смог: <название>» — из такой записи не
    // следует ни одного действия. Уроки строятся именно из причины: «блендер не
    // отвечает на скрипт» меняет поведение, «не смог сделать сферу» — нет.
    const why = result?.ok ? '' : ` — ${result?.error ?? 'без объяснения'}`;
    note(
      result?.ok ? 'result' : 'error',
      `${result?.ok ? 'сделал' : 'не смог'}: ${event.task.title}${why}`,
    );
    for (const file of made?.paths ?? []) {
      note('file', `сделал ${path.basename(file)} — ${file}`);
    }
    if (full) void session.speak(full);

    // Правка, которую никто не забрал, — это не правка, а потерянная просьба.
    //
    // Живой случай: пока шла одна работа, человек сказал «сгенерируй картинку
    // ракеты». Фраза легла в ящик, агент за ней не пришёл — он был занят
    // другим, — и просьба исчезла совсем. В логе осталось только «правка на
    // ходу», а человек решил, что Джарвис не умеет делать картинки.
    //
    // Поэтому всё, что осталось в ящике к концу работы, становится следующей
    // задачей. Это может оказаться и правкой к только что сделанному — тогда
    // она продолжит ту же сессию и ляжет поверх сделанного, что и требовалось.
    // Берём ПОСЛЕДНЮЮ отложенную реплику, а не все разом.
    //
    // Склейка обернулась бедой в первый же вечер: «Джарвис» + «открой блендер и
    // сделай ракету» + «Джервис останови все» слиплись в одну задачу, и агент
    // получил приказ сделать и тут же остановить. Человек смотрел на пустой
    // экран и был прав, когда сказал, что всё это не работает.
    //
    // Последняя реплика — это то, чего человек хочет сейчас. Всё, что он
    // сказал раньше и что никто не забрал, он повторит, если оно ему нужно.
    const leftover = notes?.take() ?? [];
    // Индексом, а не .at(-1): библиотека типов этой сборки до ES2022 не дотягивает.
    const last = leftover[leftover.length - 1];
    if (last) {
      const whole = last.text;
      console.log(`[jarvis] беру отложенное: ${whole}`);
      note('command', `отложенное: ${whole}`);
      void session.acceptAmbientTranscript(whole).catch((error: unknown) => {
        console.error('[jarvis] не удалось передать отложенное:', error);
      });
    }

    // Сказать мало: человек просил показать. Проводник открывается на самом
    // файле и выделяет его, так что искать глазами ничего не нужно.
    if (made) void revealPath(made.paths[0]).catch(() => {});
  });

  audioWindow.webContents.send(AUDIO_BRIDGE_CHANNELS.startAmbient);

  registerPushToTalk(session);
  registerSelfMute(session, audioWindow, overlay, (value) => {
    muted = value;
  });

  // Warmed now, in the background, so «открой лигу» never pays for the scan.
  void listStartMenuShortcuts();

  // The wake window closes on a timer, and a timer fires no event — so the
  // pill went on saying «Слушаю без имени» long after Jarvis had fallen
  // asleep, and the user spoke to something that was no longer listening.
  // A second's heartbeat keeps what is shown true.
  const heartbeat = setInterval(() => {
    // Немой режим показывается постоянно, а не разовой подписью.
    //
    // Он и показывался — ровно одну секунду, после чего это же обновление
    // индикатора его затирало. Человек нажал Ctrl+M одиннадцать раз за вечер,
    // а потом написал «перестал регать вейк ворд»: помощник, который не
    // слышит, выглядел в точности как слушающий. Хуже этого в голосовом
    // помощнике нет ничего — человек говорит в пустоту и думает, что его
    // игнорируют.
    if (muted) {
      overlay.note(session.status, 'Микрофон выключен — Ctrl+M');
      return;
    }
    overlay.update(session.status);
  }, 1_000);
  heartbeat.unref?.();

  active = {
    jarvis,
    session,
    dispose: () => {
      globalShortcut.unregister(PUSH_TO_TALK_ACCELERATOR);
      globalShortcut.unregister(MUTE_ACCELERATOR);
      ipcMain.removeAllListeners(AUDIO_BRIDGE_CHANNELS.utterance);
      ipcMain.removeAllListeners(AUDIO_BRIDGE_CHANNELS.speechStarted);
      ipcMain.removeAllListeners(AUDIO_BRIDGE_CHANNELS.error);
      clearInterval(heartbeat);
      clearInterval(progressTimer);
      if (thoughtTimer) clearTimeout(thoughtTimer);
      overlay.dispose();
      gridOverlay?.dispose();
      gridOverlay = null;
      helpOverlay?.dispose();
      helpOverlay = null;
      logWindow?.dispose();
      logWindow = null;
      notes = null;
      plans = null;
      story = null;
      // Сессия разговора — это процесс CLI со своим MCP-сервером. Не закрыть
      // его значит оставить его жить до перезагрузки.
      talkRef?.dispose();
      talkRef = null;
      stopTalkBridge?.();
      stopTalkBridge = null;
      stopGateBridge?.();
      stopGateBridge = null;
      recogniser.dispose();
      if (!audioWindow.isDestroyed()) audioWindow.destroy();
      active = null;
    },
  };
  return active;
}

/**
 * Runs the recogniser against the speech the model ships with.
 *
 * It answers one question a microphone cannot: whether recognition works at
 * all inside Electron. If this passes and live speech still fails, the fault
 * is in the samples, not the engine.
 */
async function runRecogniserSelfTest(transcriber: Transcriber): Promise<void> {
  const wav = path.join(
    whisperInstallRoot(),
    'sherpa-onnx-whisper-small',
    'test_wavs',
    '0.wav',
  );
  try {
    const buffer = readFileSync(wav);
    let offset = 12;
    while (offset < buffer.length - 8) {
      const id = buffer.toString('ascii', offset, offset + 4);
      const size = buffer.readUInt32LE(offset + 4);
      if (id === 'data') {
        const count = Math.floor(size / 2);
        const samples = new Float32Array(count);
        for (let i = 0; i < count; i += 1) {
          samples[i] = buffer.readInt16LE(offset + 8 + i * 2) / 32768;
        }
        const started = Date.now();
        const { text } = await transcriber.transcribe(samples, 16_000);
        console.log(
          `[jarvis] самопроверка распознавания за ${Date.now() - started} мс: ${JSON.stringify(text)}`,
        );
        return;
      }
      offset += 8 + size + (size % 2);
    }
    console.error('[jarvis] самопроверка: в файле нет звуковых данных');
  } catch (error) {
    console.error('[jarvis] самопроверка распознавания не прошла:', error);
  }
}

/**
 * Programs that must never be closed by voice.
 *
 * A misheard word should not be able to take down the shell, the assistant
 * itself, or anything Windows needs to keep running.
 */
const PROTECTED_PROCESSES = new Set([
  'system', 'idle', 'csrss', 'wininit', 'winlogon', 'services', 'lsass',
  'smss', 'svchost', 'dwm', 'explorer', 'electron', 'interpreter', 'fontdrvhost',
  'ctfmon', 'registry', 'memory compression',
]);

interface RunningProcess {
  name: string;
  pid: number;
}

/** Running programs, with window titles, as the shell reports them. */
async function listRunningProcesses(): Promise<RunningProcess[]> {
  let output: string;
  try {
    // Without /v, and that is not a detail: measured on this machine,
    // `tasklist /v` takes 44 seconds against 0.55 without it. Window titles
    // helped matching a little and cost eighty times the time, so close
    // commands piled up and answers arrived attached to the wrong question.
    ({ stdout: output } = await run('tasklist', ['/fo', 'csv', '/nh'], {
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
    }));
  } catch {
    return [];
  }

  const rows: RunningProcess[] = [];
  for (const line of output.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    const fields = [...line.matchAll(/"([^"]*)"/gu)].map((match) => match[1] ?? '');
    if (fields.length < 2) continue;
    const name = (fields[0] ?? '').replace(/\.exe$/iu, '');
    const pid = Number.parseInt(fields[1] ?? '', 10);
    if (!name || !Number.isFinite(pid)) continue;
    if (PROTECTED_PROCESSES.has(name.toLowerCase())) continue;
    rows.push({ name, pid });
  }
  return rows;
}

async function closeApplication(
  spoken: string,
  force: boolean,
  session: VoiceSession,
  confirm: (summary: string) => Promise<boolean>,
): Promise<void> {
  // The alias is what bridges «хром» to the process called chrome: the
  // transliteration of the spoken word is "hrom", which matches nothing.
  const searchable = [windowAlias(spoken), aliasTarget(spoken), spoken]
    .filter(Boolean)
    .join(' ');

  const running = await listRunningProcesses();
  const describe = (process: RunningProcess) => process.name;

  let found = chooseShortcut(searchable, running, describe);

  if (!found) {
    // The name a person uses is the game; the process belongs to its
    // launcher. «Закрой лигу» found nothing because what actually runs is
    // "Riot Client.exe" — but the shortcut for League lives in a folder called
    // "Riot Games", and that folder name is the missing link between the two.
    const shortcut = chooseShortcut(searchable, await listStartMenuShortcuts(), (item) => item.name);
    if (shortcut) {
      const vendor = shortcut.item.folder ?? '';
      console.log(`[jarvis] «${spoken}» -> ярлык «${shortcut.item.name}» в «${vendor}»`);
      found = chooseShortcut(`${shortcut.item.name} ${vendor}`, running, describe);
    }
  }

  if (!found) {
    console.log(`[jarvis] «${spoken}» среди запущенных не найдено`);
    await session.speak(`Не вижу запущенного ${spoken}.`);
    return;
  }

  // Every window of that program, not just the one that matched: a browser is
  // several processes and closing one of them achieves nothing.
  const target = found.item.name;
  const image = `${target}.exe`;

  const kill = async (hard: boolean): Promise<boolean> => {
    const args = ['/IM', image, '/T'];
    if (hard) args.push('/F');
    try {
      await run('taskkill', args, { windowsHide: true });
      return true;
    } catch {
      return false;
    }
  };

  const forceAllowed = () =>
    confirm(`Закрою ${target} принудительно, несохранённое в нём пропадёт.`);

  if (force) {
    if (!(await forceAllowed())) {
      note('close', `не стал закрывать ${spoken}`);
      await session.speak('Не закрываю.');
      return;
    }
    const killed = await kill(true);
    console.log(`[jarvis] ${killed ? 'убил' : 'не смог убить'} ${target}`);
    note(killed ? 'close' : 'error', `${killed ? 'закрыл' : 'не смог закрыть'} ${spoken}`);
    await session.speak(killed ? `Закрыл ${spoken}.` : `Не смог закрыть ${spoken}.`);
    return;
  }

  await kill(false);
  if (!(await isRunning(image))) {
    console.log(`[jarvis] закрыл ${target}`);
    note('close', `закрыл ${spoken}`);
    await session.speak(`Закрыл ${spoken}.`);
    return;
  }

  // Asking politely does not work on games and launchers — Steam ignores the
  // close request entirely. Making the user say a second, harsher sentence for
  // something they already asked for is not an assistant. So offer to
  // escalate, except where forcing would throw away unsaved work.
  if (HOLDS_UNSAVED_WORK.has(target.toLowerCase())) {
    console.log(`[jarvis] ${target} не закрылся; там может быть несохранённое`);
    note('error', `не закрыл ${spoken}: там несохранённое`);
    await session.speak(`${spoken} не закрывается — там несохранённое. Скажите «убей ${spoken}».`);
    return;
  }

  if (!(await forceAllowed())) {
    note('close', `${spoken} не закрылся, принудительно не стал`);
    await session.speak(`${spoken} не закрылся. Оставляю как есть.`);
    return;
  }
  const killed = await kill(true);
  console.log(`[jarvis] ${killed ? 'закрыл принудительно' : 'не смог закрыть'} ${target}`);
  note(killed ? 'close' : 'error', `${killed ? 'закрыл' : 'не смог закрыть'} ${spoken}`);
  await session.speak(killed ? `Закрыл ${spoken}.` : `Не смог закрыть ${spoken}.`);
}

/** Programs where a forced close can lose work the user has not saved. */
const HOLDS_UNSAVED_WORK = new Set([
  'winword', 'excel', 'powerpnt', 'notepad', 'notepad++', 'code', 'devenv',
  'photoshop', 'illustrator', 'blender', 'obs64',
]);

/** A cheap check, without the window titles the slow listing gathers. */
async function isRunning(image: string): Promise<boolean> {
  try {
    const { stdout } = await run('tasklist', ['/fi', `IMAGENAME eq ${image}`, '/fo', 'csv', '/nh'], {
      windowsHide: true,
    });
    return stdout.toLowerCase().includes(image.toLowerCase());
  } catch {
    return false;
  }
}

interface Shortcut {
  name: string;
  /** A file to start, or a Store/PWA identifier to hand to the shell. */
  target: string;
  kind: 'path' | 'aumid' | 'url';
  /** Present for shortcuts: the publisher folder, which links a game to its launcher. */
  folder?: string;
}

/**
 * Every program the Start menu knows about.
 *
 * Read once and kept, because the list changes only when something is
 * installed and scanning hundreds of files on each utterance would add a delay
 * to the one path that is supposed to be instant.
 */
let shortcutCache: Shortcut[] | null = null;

async function listStartMenuShortcuts(): Promise<Shortcut[]> {
  if (shortcutCache) return shortcutCache;
  // Один обход на всех: у моста была своя копия, и когда она расходилась
  // с той, по которой идёт проверка, проверка тихо проверяла не то.
  shortcutCache = await listInstalledPrograms();
  return shortcutCache;
}

/**
 * Starts a program and says what happened.
 *
 * `start` is a cmd builtin, so it is invoked through cmd deliberately — and
 * with the arguments passed as an array, never interpolated into a string, so
 * nothing the user said can become part of the command.
 */
async function launchApplication(
  target: string,
  spokenName: string,
  session: VoiceSession,
  kind: 'path' | 'aumid' | 'url' = 'path',
): Promise<void> {
  const started = Date.now();
  try {
    await new Promise<void>((resolve, reject) => {
      // A Store app is not a file: it is started through the shell's apps
      // folder by its identifier.
      // Three shapes, three ways in: a Store app by its identifier, a game or
      // deep link by its URL, a plain program by its file.
      // A Store app is started by its identifier through the shell's apps
      // folder. Everything else — a file, or a deep link like
      // "steam://rungameid/570" — is what `start` already knows how to open.
      const [command, args] =
        kind === 'aumid'
          ? ['explorer.exe', [`shell:AppsFolder\\${target}`]]
          : ['cmd.exe', ['/c', 'start', '', target]];
      const child = spawn(command as string, args as string[], {
        detached: true,
        stdio: 'ignore',
        windowsVerbatimArguments: false,
      });
      child.once('error', reject);
      child.once('spawn', () => {
        child.unref();
        resolve();
      });
    });
    console.log(`[jarvis] запустил ${target} за ${Date.now() - started} мс`);
    note('launch', `открыл ${spokenName}`);
    await session.speak(`Открываю ${spokenName}.`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[jarvis] не удалось запустить ${target}: ${message}`);
    note('error', `не смог открыть ${spokenName}`);
    await session.speak(`Не смог открыть ${spokenName}.`);
  }
}

/**
 * Writes the MCP config that gives the agent the screen and the mouse.
 *
 * Generated rather than shipped because it has to name an absolute path, and
 * returned as undefined when the launcher did not provide a server — computer
 * use is then simply absent instead of failing halfway through a task.
 */
function writeDesktopMcpConfig(outputDir?: string): string | undefined {
  const server = resolveDesktopMcpLaunch({ appRoot: app.getAppPath() });
  if (!server.ok) {
    console.log(`[jarvis] управление экраном выключено: не найден ${server.missing}`);
    return undefined;
  }

  try {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'jarvis-mcp-'));
    const file = path.join(dir, 'desktop.json');
    writeFileSync(
      file,
      JSON.stringify({
        mcpServers: {
          'jarvis-desktop': {
            type: 'stdio',
            command: server.launch.command,
            args: server.launch.args,
            // Сервер — отдельный процесс и сам рабочего стола не знает. Без
            // этой переменной его файловые инструменты складывали бы результат
            // не туда, где человек его ищет.
            env: {
              ...server.launch.env,
              ...(outputDir ? { JARVIS_OUTPUT_DIR: outputDir } : {}),
              // Журнал тот же самый: агент должен видеть ровно то, что помнит
              // сам Джарвис, а не собственную отдельную.
              JARVIS_JOURNAL: journalFile(),
              // Ящик правок: сюда мост кладёт сказанное во время работы, отсюда
              // агент забирает его инструментом check_notes.
              JARVIS_NOTES: notesFile(),
              // План работы: агент его пишет, окно его показывает.
              JARVIS_PLAN: planFile(),
            },
          },
        },
      }),
      'utf8',
    );
    console.log(`[jarvis] управление экраном включено: ${server.launch.args[0] ?? server.launch.command}`);
    return file;
  } catch (error) {
    console.error('[jarvis] не удалось подготовить управление экраном:', error);
    return undefined;
  }
}

/**
 * Конфиг MCP для разговора: тот же сервер, другая роль.
 *
 * Отдельной сборки нет нарочно: сервер тот же, что у рабочего стола, и
 * обновляется вместе со сборкой приложения. Роль читается из окружения, и сервер в
 * ней регистрирует только пять глаголов разговора — рабочих инструментов в
 * этом процессе нет вовсе, а не «есть, но запрещены».
 */
function writeTalkMcpConfig(bridgeDir: string): string | undefined {
  const server = resolveDesktopMcpLaunch({ appRoot: app.getAppPath() });
  if (!server.ok) {
    console.log(`[jarvis] разговор без рычагов: не найден ${server.missing}`);
    return undefined;
  }

  try {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'jarvis-talk-'));
    const file = path.join(dir, 'talk.json');
    writeFileSync(
      file,
      JSON.stringify({
        mcpServers: {
          'jarvis-talk': {
            type: 'stdio',
            command: server.launch.command,
            args: server.launch.args,
            env: {
              ...server.launch.env,
              JARVIS_MCP_ROLE: 'talk',
              JARVIS_TALK_BRIDGE: bridgeDir,
              JARVIS_JOURNAL: journalFile(),
              JARVIS_NOTES: notesFile(),
              JARVIS_PLAN: planFile(),
            },
          },
        },
      }),
      'utf8',
    );
    console.log(`[jarvis] рычаги разговора: ${file}`);
    return file;
  } catch (error) {
    console.error('[jarvis] не удалось подготовить рычаги разговора:', error);
    return undefined;
  }
}

/**
 * Папка ассистента на рабочем столе.
 *
 * Одна известная папка вместо временных каталогов: человек находит результат
 * сам, без объяснений, где искать. Путь вычисляется здесь, а не в файле
 * запуска, потому что имя папки кириллическое, а `.cmd` читается в кодировке
 * консоли и русский текст в нём превращается в мусор.
 */
/**
 * Где живёт журнал действий.
 *
 * Рядом с остальными данными и под тем же корнем: контейнер приложения
 * перенаправляет запись в Roaming, и файл, положенный «куда привычно», молча
 * уезжает в другое место — на этом здесь уже один раз потеряли голос.
 */
function journalFile(): string {
  const root =
    process.env.JARVIS_DATA_ROOT?.trim() ||
    path.join(process.env.LOCALAPPDATA ?? app.getPath('userData'), 'Rujarvis', 'data');
  return path.join(root, 'journal.json');
}

/**
 * Папка, в которой Джарвис живёт целиком.
 *
 * На уровень выше данных: там же его исходники, сборка и пусковые скрипты.
 * Агент получает её на чтение, чтобы на вопрос о себе отвечать по своим
 * файлам, а не по догадкам.
 */
/** Ящик правок: общий файл голосового моста и MCP-сервера. */
function notesFile(): string {
  return path.join(path.dirname(journalFile()), 'notes.json');
}

/** План работы: общий файл агента и окна. */
function planFile(): string {
  return path.join(path.dirname(journalFile()), 'plan.json');
}

/**
 * Папка с разбором прогонов.
 *
 * Рядом с журналом действий, но отдельной папкой: там одна строка на событие
 * для человека, здесь — полный ход работы для разбора, по файлу на задачу.
 */
function runsDir(): string {
  return path.join(path.dirname(journalFile()), 'runs');
}

function jarvisHome(): string {
  return path.dirname(path.dirname(journalFile()));
}

function openJournal(): JournalStore {
  const file = journalFile();
  console.log(`[jarvis] журнал действий: ${file}`);
  return new JournalStore(file);
}

function ensureOutputDir(): string | undefined {
  try {
    const dir = process.env.JARVIS_OUTPUT_DIR?.trim() || path.join(app.getPath('desktop'), 'Джарвис');
    mkdirSync(dir, { recursive: true });
    // Разделы заводятся сразу: размеченная папка понятнее пустой, и агенту не
    // приходится гадать, куда класть — раздел уже существует.
    for (const section of OUTPUT_SECTIONS) {
      mkdirSync(path.join(dir, section), { recursive: true });
    }
    console.log(`[jarvis] папка для файлов: ${dir}`);
    return dir;
  } catch (error) {
    console.error('[jarvis] не удалось создать папку для файлов:', error);
    return undefined;
  }
}

function toFloat32(samples: Float32Array | ArrayBuffer | number[]): Float32Array {
  if (samples instanceof Float32Array) return samples;
  if (samples instanceof ArrayBuffer) return new Float32Array(samples);
  return Float32Array.from(samples);
}

async function createAudioWindow(): Promise<BrowserWindow> {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'jarvis-audio-'));
  const pagePath = path.join(dir, 'audio.html');
  writeFileSync(pagePath, buildAudioBridgeHtml(), 'utf8');

  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      sandbox: false,
    },
  });

  // The page is generated by this file and loaded from disk, so the only
  // request that can reach this handler is our own microphone request.
  window.webContents.session.setPermissionRequestHandler((_contents, permission, callback) => {
    callback(permission === 'media');
  });

  const ready = new Promise<void>((resolve) => {
    ipcMain.once(AUDIO_BRIDGE_CHANNELS.ready, () => resolve());
  });
  await window.loadFile(pagePath);
  await ready;
  return window;
}

/**
 * Один рот на двоих.
 *
 * Речь выстроена в очередь, и это не украшение. Окно звука на новую фразу
 * **обрывает** текущую: `player.pause()` в обработчике. Пока говорил один
 * поток, обрывать было нечего. Теперь говорят двое — работа и разговор, — и
 * без очереди человек слышал бы половину фразы и начало следующей.
 *
 * Очередь ждёт конца ЗВУЧАНИЯ, а не конца синтеза: окно присылает
 * «отзвучало» с меткой фразы. Заодно чинится давняя мелочь — окно слушания
 * отсчитывалось от конца синтеза, то есть открывалось, пока Джарвис ещё
 * говорил.
 *
 * «Тишина» и «стоп» очередь не тормозят, а **выбрасывают**: попросили
 * замолчать — значит и то, что ещё не прозвучало, уже не нужно.
 */
function createPlayback(audioWindow: BrowserWindow): SpeechPlayback {
  let token = 0;
  /** Чем закончить фразу, которая звучит прямо сейчас. */
  let finish: ((forToken: number) => void) | null = null;

  ipcMain.on(AUDIO_BRIDGE_CHANNELS.spoken, (_event, forToken: number) => {
    finish?.(forToken);
  });

  const playOnce = async (text: string): Promise<void> => {
    // Запоминается до синтеза: эхо возвращается, пока фраза ещё звучит.
    echoGuard.spoke(text);
    try {
      const result = await synthesizeSpeech({
        text,
        modelId: DEFAULT_TTS_MODEL_ID,
        provider: 'cpu',
        voiceId: 0,
        speed: 1,
        pitch: 0,
        autotuneEnabled: false,
      });
      if (audioWindow.isDestroyed()) return;

      token += 1;
      const mine = token;
      await new Promise<void>((resolve) => {
        // Срок — на случай, если окно не отзовётся вовсе: молчащая очередь
        // хуже наложившихся фраз, потому что она молчит навсегда.
        const timer = setTimeout(() => finish?.(mine), wavDurationMs(result.wavBuffer) + 3_000);
        timer.unref?.();
        finish = (forToken: number) => {
          if (forToken !== mine) return;
          clearTimeout(timer);
          finish = null;
          resolve();
        };
        audioWindow.webContents.send(AUDIO_BRIDGE_CHANNELS.speak, {
          token: mine,
          data: toPlaybackBase64(result.wavBuffer),
        });
      });
    } catch (error) {
      console.error('[jarvis] синтез речи не удался:', error);
    }
  };

  const queue = new SpeechQueue({
    say: playOnce,
    cut: () => {
      // Фраза, которую сейчас оборвут, обязана закончиться и здесь — иначе
      // очередь останется ждать «отзвучало», которого уже не будет.
      finish?.(token);
      if (!audioWindow.isDestroyed()) {
        audioWindow.webContents.send(AUDIO_BRIDGE_CHANNELS.stopSpeaking);
      }
    },
  });

  return {
    speak: (text: string) => queue.speak(text),
    stop: () => queue.stop(),
    isSpeaking: () => queue.isSpeaking(),
  };
}

/**
 * Сколько звучит WAV, по его же заголовку.
 *
 * Нужно только как срок ожидания: если окно звука не отзовётся, очередь не
 * должна встать навсегда. Точность здесь не важна, поэтому и разбора никакого
 * нет — байты на скорость потока.
 */
function wavDurationMs(wav: Buffer): number {
  try {
    const byteRate = wav.readUInt32LE(28);
    if (!byteRate) return 10_000;
    const ms = ((wav.length - 44) / byteRate) * 1000;
    return Math.min(Math.max(ms, 500), 120_000);
  } catch {
    return 10_000;
  }
}

function createPushToTalkCapture(audioWindow: BrowserWindow): AudioCapture {
  let capturing = false;
  return {
    start() {
      capturing = true;
      audioWindow.webContents.send(AUDIO_BRIDGE_CHANNELS.startPush);
    },
    async stop() {
      if (!capturing) return null;
      capturing = false;
      const recorded = new Promise<RecordedAudio | null>((resolve) => {
        ipcMain.once(AUDIO_BRIDGE_CHANNELS.pushResult, (_event, payload: RecordedAudio | null) => {
          resolve(payload);
        });
      });
      audioWindow.webContents.send(AUDIO_BRIDGE_CHANNELS.stopPush);
      const payload = await recorded;
      if (!payload) return null;
      return { samples: toFloat32(payload.samples), sampleRate: payload.sampleRate };
    },
    isCapturing: () => capturing,
  };
}

/**
 * `globalShortcut` reports a press but never a release, so hold-to-talk is not
 * available through it. A press-to-start / press-to-stop toggle is, and it
 * drives the same two session methods.
 */
/**
 * Немой режим.
 *
 * Выключает и уши, и голос: микрофон перестаёт слушать, начатая фраза
 * обрывается на полуслове. Это то, что нужно, когда в комнате начался разговор
 * не с ним или пошла запись.
 *
 * Состояние обязано быть видно. Замолчавший помощник, выглядящий как
 * слушающий, — ловушка: человек говорит в пустоту и считает, что его
 * игнорируют.
 */
function registerSelfMute(
  session: VoiceSession,
  audioWindow: BrowserWindow,
  overlay: StatusOverlay,
  setMuted: (value: boolean) => void,
): void {
  let muted = false;

  const registered = globalShortcut.register(MUTE_ACCELERATOR, () => {
    muted = !muted;
    setMuted(muted);

    if (muted) {
      // Сказать надо ДО того, как замолчать, и дождаться.
      //
      // Первая попытка делала наоборот: фраза начиналась, и тут же `sleep()`
      // обрывал воспроизведение — человек не слышал ничего, то есть ровно то,
      // что и чинилось. Человек смотрит не на индикатор, а в свою работу, и за
      // вечер трижды решал, что Джарвис сломался, а тот просто не слышал.
      void (async () => {
        await session.speak('Микрофон выключен.');
        session.sleep();
        try {
          audioWindow.webContents.send(AUDIO_BRIDGE_CHANNELS.stopAmbient);
        } catch {
          // Окно захвата могло упасть — режим всё равно включается.
        }
        console.log('[jarvis] немой режим включён');
        overlay.note(session.status, 'Микрофон выключен — Ctrl+M');
      })();
      return;
    }

    try {
      audioWindow.webContents.send(AUDIO_BRIDGE_CHANNELS.startAmbient);
    } catch {
      // См. выше.
    }
    console.log('[jarvis] немой режим выключен');
    overlay.note(session.status, 'Слушаю снова');
    void session.speak('Слушаю.');
  });

  if (!registered) {
    console.error(`[jarvis] не удалось занять ${MUTE_ACCELERATOR} — сочетание занято.`);
    return;
  }
  console.log(`[jarvis] ${MUTE_ACCELERATOR}: выключить и включить микрофон.`);
}

function registerPushToTalk(session: VoiceSession): void {
  let listening = false;

  const registered = globalShortcut.register(PUSH_TO_TALK_ACCELERATOR, () => {
    void (async () => {
      if (!listening) {
        listening = true;
        await session.pressPushToTalk();
        return;
      }
      listening = false;
      const turn = await session.releasePushToTalk();
      if (turn) console.log(`[jarvis] ход: ${turn.kind}`);
    })();
  });

  if (!registered) {
    console.error(
      `[jarvis] не удалось занять ${PUSH_TO_TALK_ACCELERATOR} — сочетание уже занято другой программой.`,
    );
    return;
  }
  console.log(`[jarvis] ${PUSH_TO_TALK_ACCELERATOR}: нажмите, говорите, нажмите ещё раз.`);
}

/**
 * Asks permission out loud and listens for the answer.
 *
 * A dialog with buttons was the wrong shape for this assistant: the person it
 * is built for may have no hand free for the mouse, and a confirmation they
 * cannot give is a task that never runs.
 *
 * Silence is refusal. Waiting forever would strand the task, and assuming
 * consent from a missing answer is exactly what a confirmation exists to
 * prevent.
 */
async function askForApproval(
  summary: string,
  session: VoiceSession,
  hold: (waiter: ((answer: 'yes' | 'no') => void) | null) => void,
): Promise<boolean> {
  const question = `${summary} Разрешаете?`;
  console.log(`[jarvis] спрашиваю разрешение: ${summary}`);

  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (answer: 'yes' | 'no') => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      hold(null);
      session.keepAwake();
      resolve(answer === 'yes');
    };

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      hold(null);
      console.log('[jarvis] ответа не дождался — считаю отказом');
      void session.speak('Не дождался ответа, отменяю.');
      resolve(false);
    }, 45_000);
    timer.unref?.();

    hold(finish);
    session.keepAwake();
    void session.speak(question);
  });
}

app.on('will-quit', () => {
  active?.dispose();
  // Живые сессии агента — отдельные процессы, и сами они не уйдут.
  jarvisRef?.dispose();
});
