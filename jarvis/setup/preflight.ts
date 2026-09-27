/**
 * Предполётная проверка: всё ли звенья Джарвиса на этой машине на месте.
 *
 * Здесь только решения — какой ответ дать по тому, что намерено, и что
 * посоветовать. Сами замеры (процессы, файлы, CLI) делает
 * `scripts/qa/preflight.ts`: так логику можно проверить числами и строками,
 * не поднимая ни Codex, ни MCP-сервер.
 *
 * Ответов три, и третий не прячется в первые два. «Нечем мерить» — это не
 * «прошло»: человек, которому сказали «всё хорошо» про непроверенное, будет
 * искать поломку в Джарвисе, когда молчит его микрофон.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { tr } from '../locale/language';

export type Итог = 'прошло' | 'не прошло' | 'нечем мерить';

export interface Звено {
  /** Латиницей и неизменно: по нему CI отличает известное от нового. */
  id: string;
  имя: string;
  итог: Итог;
  подробно?: string;
  /** Что сделать человеку. У «прошло» совета нет. */
  совет?: string;
}

export function метка(итог: Итог): string {
  if (итог === 'прошло') return tr('прошло', 'passed');
  if (итог === 'не прошло') return tr('НЕ ПРОШЛО', 'FAILED');
  return tr('нечем мерить', 'cannot measure');
}

/**
 * 1 — есть что чинить; 2 — не намерено ничего; 0 — провалов нет.
 *
 * «Нечем мерить» при остальных «прошло» — не провал: у тестера может не быть
 * Claude Code, и это его выбор, а не поломка.
 */
export function кодВыхода(звенья: readonly Звено[]): 0 | 1 | 2 {
  if (звенья.some((з) => з.итог === 'не прошло')) return 1;
  if (!звенья.some((з) => з.итог === 'прошло')) return 2;
  return 0;
}

/** Строки отчёта: человеку — метки на его языке, CI — латинские строки в конце. */
export function отчёт(звенья: readonly Звено[]): string[] {
  const строки: string[] = [];
  const ширина = Math.max(...звенья.map((з) => метка(з.итог).length), 0);
  const ширинаId = Math.max(...звенья.map((з) => з.id.length), 0);
  const отступ = ' '.repeat(2 + ширина + 2 + ширинаId + 2);
  for (const з of звенья) {
    строки.push(`  ${метка(з.итог).padEnd(ширина)}  ${з.id.padEnd(ширинаId)}  ${з.имя}${з.подробно ? ` — ${з.подробно}` : ''}`);
    if (з.совет && з.итог !== 'прошло') строки.push(`${отступ}→ ${з.совет}`);
  }
  const сколько = (итог: Итог): number => звенья.filter((з) => з.итог === итог).length;
  строки.push('');
  строки.push(
    tr(
      `Итог: прошло ${сколько('прошло')}, не прошло ${сколько('не прошло')}, нечем мерить ${сколько('нечем мерить')}`,
      `Total: passed ${сколько('прошло')}, failed ${сколько('не прошло')}, cannot measure ${сколько('нечем мерить')}`,
    ),
  );
  строки.push(`preflight: pass=${сколько('прошло')} fail=${сколько('не прошло')} none=${сколько('нечем мерить')}`);
  const номера = (итог: Итог): string => звенья.filter((з) => з.итог === итог).map((з) => з.id).join(' ');
  строки.push(`preflight-pass: ${номера('прошло')}`);
  строки.push(`preflight-fail: ${номера('не прошло')}`);
  строки.push(`preflight-none: ${номера('нечем мерить')}`);
  return строки;
}

// --- установка -----------------------------------------------------------------

export interface ФактыУстановки {
  platform: NodeJS.Platform;
  /** Папка исходников установки. */
  source: string;
  приложение: boolean;
  сервер: boolean;
  /** Ярлык: `~/Applications/Rujarvis.app` на маке, «Пуск» на Windows. */
  ярлык: string;
  ярлыкЕсть: boolean;
  /** Только мак: ярлык запускаемый. */
  ярлыкЗапускается?: boolean;
  /** Только мак: в Info.plist есть ключ микрофона — без него macOS не даст записывать. */
  ключМикрофона?: boolean;
}

/** Как в `docs/jarvis/install.md`: через файл, а не `| bash`. */
const СТРОКА_УСТАНОВКИ =
  'f=/tmp/rujarvis-install.sh; curl -fsSL https://raw.githubusercontent.com/aisarus/Rujarvis/main/install.sh -o "$f" && bash "$f"';

export function звеноУстановки(ф: ФактыУстановки): Звено {
  const имя = tr('Установка и ярлык', 'Installation and launcher');
  const переустановить =
    ф.platform === 'win32'
      ? tr(
          'Запустите установщик ещё раз — он обновляет установку, ничего не теряя.',
          'Run the installer again — it updates the installation without losing anything.',
        )
      : tr(
          `Запустите установщик ещё раз — той же строкой, что ставили: ${СТРОКА_УСТАНОВКИ}`,
          `Run the installer again — the same line you installed with: ${СТРОКА_УСТАНОВКИ}`,
        );
  const беды: string[] = [];
  if (!ф.приложение) беды.push(tr(`нет сборки приложения в ${ф.source}`, `no app build in ${ф.source}`));
  if (!ф.сервер) беды.push(tr('нет сборки MCP-сервера', 'no MCP server build'));
  if (!ф.ярлыкЕсть) беды.push(tr(`нет ярлыка ${ф.ярлык}`, `no launcher at ${ф.ярлык}`));
  else if (ф.ярлыкЗапускается === false) беды.push(tr(`ярлык ${ф.ярлык} не запускаемый`, `launcher ${ф.ярлык} is not executable`));
  if (ф.ключМикрофона === false) {
    беды.push(tr('в Info.plist нет ключа микрофона — macOS не даст записывать', 'Info.plist has no microphone key — macOS will refuse to record'));
  }
  if (беды.length > 0) return { id: 'install', имя, итог: 'не прошло', подробно: беды.join('; '), совет: переустановить };
  return { id: 'install', имя, итог: 'прошло', подробно: ф.ярлык };
}

// --- PATH как у Finder ------------------------------------------------------------

export type Инструмент = 'node' | 'codex' | 'claude';

export interface ОтветИнструмента {
  есть: boolean;
  работает: boolean;
  /** Первая строка ответа `--version` или ошибки. */
  вывод: string;
}

export interface ОтветЯрлыка {
  path: string | null;
  инструменты: Partial<Record<Инструмент, ОтветИнструмента>>;
}

/**
 * Кусок bash, который печатает PATH ярлыка и ответ каждого инструмента.
 *
 * Метки с `@@`: вывод CLI может быть каким угодно, а спутать его строку с
 * нашей нельзя.
 */
export const ОПРОС_ЯРЛЫКА = [
  'echo "@@PATH=$PATH"',
  'for t in node codex claude; do',
  '  if ! command -v "$t" >/dev/null 2>&1; then echo "@@$t=missing"; continue; fi',
  '  if out=$("$t" --version 2>&1); then echo "@@$t=ok $(printf %s "$out" | head -1)";',
  '  else echo "@@$t=fail $(printf %s "$out" | head -1)"; fi',
  'done',
].join('\n');

export function разобратьЯрлык(вывод: string): ОтветЯрлыка {
  const ответ: ОтветЯрлыка = { path: null, инструменты: {} };
  for (const строка of вывод.split(/\r?\n/u)) {
    if (строка.startsWith('@@PATH=')) {
      ответ.path = строка.slice('@@PATH='.length);
      continue;
    }
    const m = /^@@(node|codex|claude)=(ok|fail|missing)\s?(.*)$/u.exec(строка);
    if (!m) continue;
    const имя = m[1] as Инструмент;
    ответ.инструменты[имя] = { есть: m[2] !== 'missing', работает: m[2] === 'ok', вывод: m[3]?.trim() ?? '' };
  }
  return ответ;
}

const ИМЕНА: Record<Инструмент, string> = { node: 'node', codex: 'Codex', claude: 'Claude Code' };

/**
 * Звенья «запуск из Finder»: node обязателен, агенты — те, что стоят.
 *
 * `вТерминале` — где инструмент нашёлся с PATH Терминала. Стоит, но ярлык
 * его не видит — это ровно та поломка, ради которой звено заведено: Finder
 * даёт приложению /usr/bin:/bin:/usr/sbin:/sbin, и без ярлыка Codex из npm
 * падает на «#!/usr/bin/env node».
 */
export function звеньяЯрлыка(
  ответ: ОтветЯрлыка | null,
  вТерминале: Partial<Record<Инструмент, string | null>>,
  почемуНет?: string,
): Звено[] {
  const звенья: Звено[] = [];
  for (const инструмент of ['node', 'codex', 'claude'] as const) {
    const id = `finder-${инструмент}`;
    const имя = tr(`${ИМЕНА[инструмент]} из ярлыка (PATH как у Finder)`, `${ИМЕНА[инструмент]} from the launcher (Finder PATH)`);
    const а = ответ?.инструменты[инструмент];
    if (!ответ || !а) {
      звенья.push({
        id,
        имя,
        итог: 'не прошло',
        подробно: почемуНет ?? tr('ярлык не ответил', 'the launcher did not answer'),
        совет: tr('Переустановите Rujarvis — установщик перепишет ярлык.', 'Reinstall Rujarvis — the installer rewrites the launcher.'),
      });
      continue;
    }
    if (а.работает) {
      звенья.push({ id, имя, итог: 'прошло', подробно: а.вывод });
      continue;
    }
    const где = вТерминале[инструмент];
    if (!а.есть && инструмент !== 'node' && !где) {
      звенья.push({
        id,
        имя,
        итог: 'нечем мерить',
        подробно: tr(`${ИМЕНА[инструмент]} не установлен`, `${ИМЕНА[инструмент]} is not installed`),
      });
      continue;
    }
    const папка = где ? где.replace(/\/[^/]*$/u, '') : null;
    звенья.push({
      id,
      имя,
      итог: 'не прошло',
      подробно: а.есть
        ? tr(`запускается с ошибкой: ${а.вывод || 'без вывода'}`, `fails to start: ${а.вывод || 'no output'}`)
        : tr(
            `ярлык не видит ${ИМЕНА[инструмент]}${папка ? ` (в Терминале он в ${папка})` : ''}`,
            `the launcher cannot see ${ИМЕНА[инструмент]}${папка ? ` (Terminal finds it in ${папка})` : ''}`,
          ),
      совет: tr(
        'Переустановите Rujarvis: ярлык дописывает папки node, Homebrew и npm, которые найдёт при установке.',
        'Reinstall Rujarvis: the launcher adds the node, Homebrew and npm folders it finds during installation.',
      ),
    });
  }
  return звенья;
}

// --- вход в агентов -----------------------------------------------------------------

export interface СостояниеCli {
  installed: boolean;
  loggedIn: boolean | 'unknown';
  error?: string;
}

const КАК_ВОЙТИ: Record<'codex' | 'claude', string> = {
  codex: 'codex login',
  claude: 'claude auth login',
};

/** Вход в один CLI. Второй нужен, чтобы понять: отсутствие — выбор или беда. */
export function звеноВхода(cli: 'codex' | 'claude', своё: СостояниеCli, второе: СостояниеCli): Звено {
  const имя = tr(`Вход в ${ИМЕНА[cli]}`, `${ИМЕНА[cli]} sign-in`);
  const id = `login-${cli}`;
  if (!своё.installed) {
    if (второе.installed) {
      return {
        id,
        имя,
        итог: 'нечем мерить',
        подробно: tr(
          `${ИМЕНА[cli]} не установлен — Джарвис работает через ${ИМЕНА[cli === 'codex' ? 'claude' : 'codex']}`,
          `${ИМЕНА[cli]} is not installed — Jarvis works through ${ИМЕНА[cli === 'codex' ? 'claude' : 'codex']}`,
        ),
      };
    }
    return {
      id,
      имя,
      итог: 'не прошло',
      подробно: своё.error ?? tr('не установлен ни Codex, ни Claude Code', 'neither Codex nor Claude Code is installed'),
      совет:
        cli === 'codex'
          ? tr('В Терминале: npm install -g @openai/codex, затем codex login', 'In Terminal: npm install -g @openai/codex, then codex login')
          : tr(
              'В Терминале: npm install -g @anthropic-ai/claude-code, затем claude auth login',
              'In Terminal: npm install -g @anthropic-ai/claude-code, then claude auth login',
            ),
    };
  }
  if (своё.loggedIn === true) return { id, имя, итог: 'прошло' };
  if (своё.loggedIn === false) {
    return {
      id,
      имя,
      итог: 'не прошло',
      подробно: tr(`${ИМЕНА[cli]} говорит: не вошли`, `${ИМЕНА[cli]} says: not signed in`),
      совет: tr(`В Терминале: ${КАК_ВОЙТИ[cli]}`, `In Terminal: ${КАК_ВОЙТИ[cli]}`),
    };
  }
  return {
    id,
    имя,
    итог: 'нечем мерить',
    подробно: tr(`${ИМЕНА[cli]} не сказал, вошли ли вы`, `${ИМЕНА[cli]} did not say whether you are signed in`),
    совет: tr(
      `В Терминале: ${cli === 'codex' ? 'codex login status' : 'claude auth status'} — и если не вошли, ${КАК_ВОЙТИ[cli]}`,
      `In Terminal: ${cli === 'codex' ? 'codex login status' : 'claude auth status'} — and if not signed in, ${КАК_ВОЙТИ[cli]}`,
    ),
  };
}

// --- модели речи ---------------------------------------------------------------------

export interface ФактыМоделей {
  /** Модель распознавания из настроек. */
  распознавание: string;
  /** Какие модели распознавания стоят. */
  стоятРаспознавания: readonly string[];
  голос: string;
  голосСтоит: boolean;
}

export function звеноМоделей(ф: ФактыМоделей): Звено {
  const имя = tr('Модели речи', 'Speech models');
  const совет = tr(
    'Откройте Rujarvis → Настройки → модели и скачайте недостающее (или запустите установщик ещё раз).',
    'Open Rujarvis → Settings → models and download what is missing (or run the installer again).',
  );
  const беды: string[] = [];
  if (ф.стоятРаспознавания.length === 0) беды.push(tr('нет ни одной модели распознавания', 'no recognition model installed'));
  if (!ф.голосСтоит) беды.push(tr(`нет голоса ${ф.голос}`, `voice ${ф.голос} is missing`));
  if (беды.length > 0) return { id: 'models', имя, итог: 'не прошло', подробно: беды.join('; '), совет };
  // Своя модель не стоит, но стоит другая — приложение возьмёт её, как
  // `pickInstalledModel`. Это не провал, но сказать надо.
  const взята = ф.стоятРаспознавания.includes(ф.распознавание) ? ф.распознавание : ф.стоятРаспознавания[0];
  return {
    id: 'models',
    имя,
    итог: 'прошло',
    подробно:
      взята === ф.распознавание
        ? `whisper-${взята}, ${ф.голос}`
        : tr(
            `в настройках whisper-${ф.распознавание}, стоит whisper-${взята} — возьмётся она; ${ф.голос}`,
            `settings say whisper-${ф.распознавание}, whisper-${взята} is installed and will be used; ${ф.голос}`,
          ),
  };
}

// --- разрешения ------------------------------------------------------------------------

export type Разрешение = 'дано' | 'отказано' | 'не спрашивали' | 'не нужно';

export interface ЗаписьРазрешений {
  когда: string;
  микрофон: Разрешение;
  доступность: Разрешение;
  экран: Разрешение;
}

/** Где приложение оставляет ответы системы: в папке данных, как всё остальное. */
export function файлРазрешений(dataDir: string): string {
  return path.join(dataDir, 'mac-permissions.json');
}

/** Записать, что ответила система. Сбой записи не должен мешать запуску. */
export function сохранитьРазрешения(
  файл: string,
  опрос: Omit<ЗаписьРазрешений, 'когда'>,
  когда: Date = new Date(),
): void {
  try {
    mkdirSync(path.dirname(файл), { recursive: true });
    const запись: ЗаписьРазрешений = { когда: штамп(когда), ...опрос };
    writeFileSync(файл, JSON.stringify(запись, null, 2), 'utf8');
  } catch {
    // Проверка тогда скажет «нечем мерить» — это правда, а не беда запуска.
  }
}

const РАЗРЕШЕНИЯ: readonly Разрешение[] = ['дано', 'отказано', 'не спрашивали', 'не нужно'];

export function прочитатьРазрешения(файл: string): ЗаписьРазрешений | null {
  try {
    const сырое = JSON.parse(readFileSync(файл, 'utf8')) as Partial<Record<keyof ЗаписьРазрешений, unknown>>;
    const одно = (значение: unknown): Разрешение | null =>
      РАЗРЕШЕНИЯ.includes(значение as Разрешение) ? (значение as Разрешение) : null;
    const микрофон = одно(сырое.микрофон);
    const доступность = одно(сырое.доступность);
    const экран = одно(сырое.экран);
    if (!микрофон || !доступность || !экран || typeof сырое.когда !== 'string') return null;
    return { когда: сырое.когда, микрофон, доступность, экран };
  } catch {
    return null;
  }
}

function штамп(когда: Date): string {
  const д = (n: number): string => String(n).padStart(2, '0');
  return `${когда.getFullYear()}-${д(когда.getMonth() + 1)}-${д(когда.getDate())} ${д(когда.getHours())}:${д(когда.getMinutes())}`;
}

/**
 * Разрешения мака — по записи самого приложения.
 *
 * Спросить систему из Терминала нельзя: macOS ответит про Терминал, а не про
 * Rujarvis. Поэтому приложение при каждом запуске пишет, что ему ответила
 * система, и проверка читает это. Записи нет — приложение не запускалось, и
 * это «нечем мерить», а не «не дано».
 */
export function звеньяРазрешенийМака(запись: ЗаписьРазрешений | null): Звено[] {
  const настройки = tr('Системные настройки → Конфиденциальность и безопасность', 'System Settings → Privacy & Security');
  const перезапуск = tr(
    'затем выйдите из Rujarvis (значок в строке меню → Выйти), откройте снова и повторите проверку',
    'then quit Rujarvis (menu bar icon → Quit), open it again and rerun this check',
  );
  const строка = (
    id: string,
    имя: string,
    раздел: string,
    значение: Разрешение | undefined,
    зачем: string,
  ): Звено => {
    if (!запись || !значение) {
      return {
        id,
        имя,
        итог: 'нечем мерить',
        подробно: tr('Rujarvis ещё не запускался с этой версией', 'Rujarvis has not run with this version yet'),
        совет: tr(
          'Откройте Rujarvis из «Программ», ответьте «Разрешить» на вопросы системы и повторите проверку.',
          'Open Rujarvis from Applications, answer “Allow” to the system prompts and rerun this check.',
        ),
      };
    }
    const когда = tr(`по запуску ${запись.когда}`, `as of launch ${запись.когда}`);
    if (значение === 'дано') return { id, имя, итог: 'прошло', подробно: когда };
    return {
      id,
      имя,
      итог: 'не прошло',
      подробно: `${значение === 'отказано' ? tr('отказано', 'denied') : tr('не выдано', 'not granted')} (${когда}) — ${зачем}`,
      совет: tr(
        `${настройки} → ${раздел}: включите Rujarvis (в списке он может называться Electron); ${перезапуск}.`,
        `${настройки} → ${раздел}: turn on Rujarvis (it may be listed as Electron); ${перезапуск}.`,
      ),
    };
  };
  return [
    строка('perm-mic', tr('Микрофон', 'Microphone'), tr('Микрофон', 'Microphone'), запись?.микрофон, tr('без него нет голоса', 'no voice without it')),
    строка(
      'perm-access',
      tr('Универсальный доступ', 'Accessibility'),
      tr('Универсальный доступ', 'Accessibility'),
      запись?.доступность,
      tr('без него нажатия молча не доходят', 'without it clicks and keys silently do nothing'),
    ),
    строка(
      'perm-screen',
      tr('Запись экрана', 'Screen Recording'),
      tr('Запись экрана', 'Screen & System Audio Recording'),
      запись?.экран,
      tr('без неё нет снимков окон и сетки', 'no window snapshots or grid without it'),
    ),
  ];
}

/** Ответ `reg query … /v Value`: Allow, Deny или ничего. */
export function значениеРеестра(вывод: string | null): 'Allow' | 'Deny' | null {
  const m = /\bValue\s+REG_SZ\s+(Allow|Deny)\b/iu.exec(вывод ?? '');
  if (!m) return null;
  return m[1]!.toLowerCase() === 'allow' ? 'Allow' : 'Deny';
}

/**
 * Микрофон на Windows: общий выключатель и выключатель для обычных программ.
 *
 * Джарвис — обычная программа (не из Store), и Windows пускает её к
 * микрофону, только если включены оба. Ключа нет — Windows не спрашивала, и
 * по умолчанию доступ открыт, но утверждать этого по реестру нельзя.
 */
export function звеноМикрофонаWindows(общий: 'Allow' | 'Deny' | null, программы: 'Allow' | 'Deny' | null): Звено {
  const имя = tr('Микрофон', 'Microphone');
  if (общий === 'Deny' || программы === 'Deny') {
    return {
      id: 'perm-mic',
      имя,
      итог: 'не прошло',
      подробно: tr('Windows не пускает программы к микрофону', 'Windows blocks apps from the microphone'),
      совет: tr(
        'Параметры → Конфиденциальность и защита → Микрофон: включите «Доступ к микрофону» и «Разрешить классическим приложениям».',
        'Settings → Privacy & security → Microphone: turn on “Microphone access” and “Let desktop apps access your microphone”.',
      ),
    };
  }
  if (общий === 'Allow') return { id: 'perm-mic', имя, итог: 'прошло' };
  return {
    id: 'perm-mic',
    имя,
    итог: 'нечем мерить',
    подробно: tr('Windows ещё не записала выбор', 'Windows has not recorded a choice yet'),
  };
}

// --- хук красных линий -------------------------------------------------------------------

export interface ЗапускХука {
  код: number | null;
  вывод: string;
  беда?: string;
}

/**
 * Хук поднялся — если безобидный вызов пропущен, а нечитаемый отклонён.
 *
 * Второе важнее первого: хук, который на мусоре молчит, на сбое пропускает, а
 * красная линия держится только тем, что сбой — это отказ.
 */
export function звеноХука(подготовка: { ok: true } | { ok: false; reason: string }, безобидный?: ЗапускХука, мусор?: ЗапускХука): Звено {
  const имя = tr('Хук красных линий поднимается', 'Red-line hook starts');
  const совет = tr(
    'Переустановите Rujarvis. Если повторится — пришлите вывод этой проверки.',
    'Reinstall Rujarvis. If it repeats, send the output of this check.',
  );
  if (!подготовка.ok) {
    return {
      id: 'gate',
      имя,
      итог: 'не прошло',
      подробно: подготовка.reason,
      совет: /node/u.test(подготовка.reason)
        ? tr('Без node у агента нет хука, а значит и рук. Переустановите Rujarvis.', 'Without node the agent has no hook and so no hands. Reinstall Rujarvis.')
        : совет,
    };
  }
  if (!безобидный || !мусор) return { id: 'gate', имя, итог: 'не прошло', подробно: tr('хук не запускался', 'the hook was not run'), совет };
  const запрет = (з: ЗапускХука): boolean => /"permissionDecision"\s*:\s*"deny"/u.test(з.вывод);
  if (безобидный.беда || безобидный.код !== 0 || запрет(безобидный)) {
    return {
      id: 'gate',
      имя,
      итог: 'не прошло',
      подробно: tr(
        `безобидный вызов: ${безобидный.беда ?? `код ${String(безобидный.код)}`} ${безобидный.вывод.trim().slice(0, 200)}`,
        `harmless call: ${безобидный.беда ?? `exit ${String(безобидный.код)}`} ${безобидный.вывод.trim().slice(0, 200)}`,
      ).trim(),
      совет,
    };
  }
  if (!запрет(мусор)) {
    return {
      id: 'gate',
      имя,
      итог: 'не прошло',
      подробно: tr(
        `нечитаемый вызов не отклонён: ${мусор.беда ?? `код ${String(мусор.код)}`} ${мусор.вывод.trim().slice(0, 200)}`,
        `an unreadable call was not denied: ${мусор.беда ?? `exit ${String(мусор.код)}`} ${мусор.вывод.trim().slice(0, 200)}`,
      ).trim(),
      совет,
    };
  }
  return { id: 'gate', имя, итог: 'прошло', подробно: tr('пропускает безобидное, отклоняет нечитаемое', 'allows the harmless, denies the unreadable') };
}

// --- MCP-сервер ----------------------------------------------------------------------------

export function звеноСервера(ответ: { tools: readonly string[]; ms: number } | { error: string }): Звено {
  const имя = tr('MCP-сервер рабочего стола отвечает', 'Desktop MCP server answers');
  if ('error' in ответ) {
    return {
      id: 'mcp',
      имя,
      итог: 'не прошло',
      подробно: ответ.error,
      совет: tr('Переустановите Rujarvis — сборка сервера будет сделана заново.', 'Reinstall Rujarvis — the server will be rebuilt.'),
    };
  }
  if (ответ.tools.length === 0) {
    return {
      id: 'mcp',
      имя,
      итог: 'не прошло',
      подробно: tr('сервер поднялся, но не отдал ни одного инструмента', 'the server started but listed no tools'),
      совет: tr('Переустановите Rujarvis.', 'Reinstall Rujarvis.'),
    };
  }
  return {
    id: 'mcp',
    имя,
    итог: 'прошло',
    подробно: tr(`${ответ.tools.length} инструментов за ${ответ.ms} мс`, `${ответ.tools.length} tools in ${ответ.ms} ms`),
  };
}

// --- ход разговора ---------------------------------------------------------------------------

export function звеноРазговора(
  спрошен: boolean,
  ответ?: { ok: boolean; text: string; error?: string } | { нет: string },
): Звено {
  const имя = tr('Ход разговора через Codex', 'A conversation turn through Codex');
  if (!спрошен) {
    return {
      id: 'talk',
      имя,
      итог: 'нечем мерить',
      подробно: tr('не проверялся: это ход по подписке', 'not checked: it spends a subscription turn'),
      совет: tr('Чтобы проверить и его: pnpm jarvis:preflight -- --with-agent', 'To check it too: pnpm jarvis:preflight -- --with-agent'),
    };
  }
  if (!ответ || 'нет' in ответ) {
    return { id: 'talk', имя, итог: 'нечем мерить', подробно: ответ?.нет ?? tr('Codex не найден', 'Codex not found') };
  }
  if (ответ.ok && ответ.text.trim()) return { id: 'talk', имя, итог: 'прошло', подробно: `«${ответ.text.trim().slice(0, 80)}»` };
  return {
    id: 'talk',
    имя,
    итог: 'не прошло',
    подробно: (ответ.error ?? tr('пустой ответ', 'empty answer')).slice(0, 300),
    совет: tr('Проверьте вход: codex login status. Если вошли — пришлите вывод этой проверки.', 'Check sign-in: codex login status. If signed in, send the output of this check.'),
  };
}

/** «Только для macOS» — честно, а не молча: Windows и мак проверяются одним списком. */
export function толькоМак(id: string, имя: string): Звено {
  return { id, имя, итог: 'нечем мерить', подробно: tr('только для macOS', 'macOS only') };
}
