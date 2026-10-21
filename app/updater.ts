/**
 * Обновления и отчёт для разработчика — главный процесс.
 *
 * Вся логика — в `jarvis/setup/update.ts` и `report.ts`, здесь только
 * расписание проверок, память о результате и переходники к Электрону.
 *
 * Проверка — через минуту после запуска и дальше раз в шесть часов. Нашлась
 * новая версия — значок в трее и одно уведомление системы, без голоса:
 * Джарвис не перебивает человека ради себя.
 */

import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { app, Notification, shell } from 'electron';

import { lectureState } from './lectureMode';
import { APP_ROOT } from './root';
import { cliStatus } from '../jarvis/backends/cliProbes';
import { tr } from '../jarvis/locale/language';
import type { JarvisPaths } from '../jarvis/setup/paths';
import { buildReport, имяОтчёта } from '../jarvis/setup/report';
import type { AppSettings } from '../jarvis/setup/settings';
import { checkForUpdate, currentVersion, isInstalledCopy, runGit, startUpdate, type UpdateCheck, type Version } from '../jarvis/setup/update';

export interface UpdateState {
  /** Установленная копия — её можно обновить кнопкой. */
  installed: boolean;
  version: Version | null;
  checking: boolean;
  result: UpdateCheck | null;
  /** Когда проверяли, ISO. */
  checkedAt: string | null;
}

interface Настройка {
  paths: JarvisPaths;
  settings: () => AppSettings;
  /** Состояние поменялось — перерисовать трей и окно. */
  onChange: () => void;
}

const ПЕРВАЯ_ПРОВЕРКА_МС = 60_000;
const ПЕРИОД_МС = 6 * 60 * 60 * 1000;

let настройка: Настройка | null = null;
let версия: Version | null = null;
let результат: UpdateCheck | null = null;
let когда: string | null = null;
let идёт: Promise<UpdateCheck> | null = null;
/** О какой версии уже сказали: уведомление — одно на версию. */
let сказалиО: string | null = null;

const git = () => runGit(APP_ROOT);

function установлена(): boolean {
  return Boolean(настройка && isInstalledCopy(APP_ROOT, настройка.paths.source));
}

export function startUpdateChecks(options: Настройка): void {
  настройка = options;
  void currentVersion(git())
    .then((v) => {
      версия = v;
      options.onChange();
    })
    .catch(() => undefined);
  // Копию разработчика не проверяем сами: у неё свой git и свои ветки.
  if (!установлена()) return;
  setTimeout(() => void checkUpdateNow(), ПЕРВАЯ_ПРОВЕРКА_МС).unref();
  setInterval(() => void checkUpdateNow(), ПЕРИОД_МС).unref();
}

export function updateState(): UpdateState {
  return { installed: установлена(), version: версия, checking: Boolean(идёт), result: результат, checkedAt: когда };
}

export function checkUpdateNow(): Promise<UpdateCheck> {
  if (идёт) return идёт;
  if (!установлена()) {
    результат = {
      state: 'unknown',
      reason: tr('это копия разработчика — она обновляется через git', 'this is a developer copy — it updates through git'),
    };
    return Promise.resolve(результат);
  }
  идёт = checkForUpdate(git())
    .then((итог) => {
      результат = итог;
      когда = new Date().toISOString();
      console.log(
        `[jarvis:update] проверка: ${итог.state === 'available' ? `есть новая версия (${итог.changes.length}${итог.more ? '+' : ''})` : итог.state === 'current' ? 'последняя версия' : `не вышло — ${итог.reason}`}`,
      );
      if (итог.state === 'available' && сказалиО !== итог.latest) {
        сказалиО = итог.latest;
        уведомить(итог.changes.length, итог.more);
      }
      return итог;
    })
    .finally(() => {
      идёт = null;
      настройка?.onChange();
    });
  настройка?.onChange();
  return идёт;
}

function уведомить(сколько: number, больше: boolean): void {
  if (!Notification.isSupported()) return;
  const n = `${сколько}${больше ? '+' : ''}`;
  new Notification({
    title: tr('Вышло обновление Джарвиса', 'A Jarvis update is out'),
    body: tr(`Изменений: ${n}. Обновить — в трее или в настройках.`, `${n} changes. Update from the tray or the settings.`),
    silent: true,
  }).show();
}

/**
 * Обновить сейчас: подготовить окно обновления и закрыть Джарвиса.
 *
 * Перед этим — ещё одна проверка: между уведомлением и нажатием могла
 * выйти следующая версия, а установщик берётся из той, что скачана.
 */
export async function runUpdateNow(): Promise<{ ok: true } | { ok: false; message: string }> {
  if (!настройка || !установлена()) {
    return { ok: false, message: tr('обновлять кнопкой можно только установленную копию', 'only an installed copy can be updated with the button') };
  }
  // Обновление закрывает Джарвиса — посреди лекции это оборвало бы запись
  // (тестер 21.10.2026 обновился посреди пары, и итог не дописался).
  const лекция = lectureState();
  if (лекция !== 'off') {
    return {
      ok: false,
      message:
        лекция === 'finishing'
          ? tr('Дописываю итог лекции — через минуту можно обновляться.', 'Writing the lecture summary. You can update in a minute.')
          : tr(
              'Идёт конспект лекции — обновление оборвало бы запись. Закончите конспект и нажмите «Обновить» снова.',
              'Lecture notes are in progress; updating would cut the recording. Finish the notes and press Update again.',
            ),
    };
  }
  const итог = await checkUpdateNow();
  if (итог.state === 'unknown') return { ok: false, message: итог.reason };
  if (итог.state === 'current') return { ok: false, message: tr('уже последняя версия', 'already up to date') };
  const s = настройка.settings();
  try {
    await startUpdate({
      pid: process.pid,
      home: настройка.paths.home,
      logs: настройка.paths.logs,
      sourceDir: APP_ROOT,
      branch: итог.branch,
      language: s.language === 'en' ? 'en' : 'ru',
      whisperModel: s.whisperModel,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[jarvis:update] окно обновления не открылось: ${message}`);
    return { ok: false, message };
  }
  console.log(`[jarvis:update] обновляюсь до ${итог.latest.slice(0, 7)} — закрываюсь, окно обновления ждёт`);
  // Ответ окну настроек успевает уйти, потом — выход.
  setTimeout(() => app.quit(), 400);
  return { ok: true };
}

/** Сохранить отчёт в папку Джарвиса и показать его в проводнике. Путь к файлу. */
export async function saveReport(): Promise<string> {
  if (!настройка) throw new Error('обновления не настроены');
  const { paths } = настройка;
  let журнал = '';
  try {
    журнал = readFileSync(paths.log, 'utf8');
  } catch {
    журнал = '';
  }
  const [claude, codex] = await Promise.all([cliStatus('claude').catch(() => null), cliStatus('codex').catch(() => null)]);
  const when = new Date();
  const текст = buildReport({
    when,
    version: версия ?? (await currentVersion(git()).catch(() => null)),
    installedCopy: установлена(),
    update: результат,
    platform: process.platform,
    osRelease: os.release(),
    arch: process.arch,
    totalRamMb: Math.round(os.totalmem() / (1024 * 1024)),
    versions: { electron: process.versions.electron, node: process.versions.node, chrome: process.versions.chrome },
    settings: настройка.settings(),
    agents: { claude, codex },
    log: журнал,
  });
  const папка = path.join(paths.home, 'reports');
  mkdirSync(папка, { recursive: true });
  const файл = path.join(папка, имяОтчёта(when));
  writeFileSync(файл, текст, 'utf8');
  shell.showItemInFolder(файл);
  console.log(`[jarvis:update] отчёт сохранён: ${файл}`);
  return файл;
}
