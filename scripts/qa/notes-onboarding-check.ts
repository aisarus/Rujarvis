/**
 * Мастер варианта «только конспекты» настоящим окном — так, как его пройдёт
 * тестерша на маке: `node build.mjs && electron dist/qa/notes-onboarding-check.cjs -- --file=речь.wav`.
 *
 * Проверяется самодостаточность — всё, что человек делает без Терминала:
 * - шаги конспектора: язык → агент → лекции → микрофон → готово;
 * - «Установить» у отсутствующего агента ставит его настоящим npm, и карточка
 *   показывает «установлен» (`--install=claude|codex`; без ключа — не ставит);
 * - «Проверить связь» отвечает по каждому агенту — ответом или причиной;
 * - «Записать 8 секунд» с подставного микрофона (файл) доходит до модели для
 *   лекций и возвращает «Услышал…» со скоростью;
 * - «Начать» ставит `onboarded`.
 *
 * Настройки — во временной папке; модели и агенты — настоящие, от установки.
 * Окно выходит на экран — гонять в CI, а не на машине человека.
 *
 * Отвечает: прошло / не прошло / нечем мерить (нет распознавания лекций или записи).
 */

import { copyFileSync, existsSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { app, BrowserWindow } from 'electron';

import { openSettingsWindow } from '../../app/settingsWindow';
import { UI_STRINGS } from '../../app/ui/strings';
import { cliStatus } from '../../jarvis/backends/cliProbes';
import { jarvisPaths } from '../../jarvis/setup/paths';
import { SettingsStore } from '../../jarvis/setup/settings';
import { findGpuWhisper, gpuWhisperDir } from '../../jarvis/voice/gpuWhisper';

const арг = (имя: string): string | undefined => process.argv.find((a) => a.startsWith(`--${имя}=`))?.slice(имя.length + 3);
const файл = арг('file');
const ставить = арг('install');
const ru = UI_STRINGS.ru;
const подождать = (мс: number): Promise<void> => new Promise((готово) => setTimeout(готово, мс));

if (файл) {
  app.commandLine.appendSwitch('use-fake-device-for-media-stream');
  app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
  // По кругу: микрофон открывают и полоска уровня, и запись проверки — запись
  // не должна застать файл уже доигранным.
  app.commandLine.appendSwitch('use-file-for-fake-audio-capture', файл);
  // На маке служба звука в песочнице к файлу не допускается (см. notes-check).
  app.commandLine.appendSwitch('disable-features', 'AudioServiceOutOfProcess,AudioServiceSandbox');
}

type Итог = { вид: 'прошло' | 'не прошло' | 'нечем мерить'; что: string };

async function main(): Promise<number> {
  if (!файл || !existsSync(файл)) {
    console.log('НЕЧЕМ МЕРИТЬ: нужна запись речи — --file=речь.wav');
    return 2;
  }
  const настоящие = jarvisPaths();
  if (!(await findGpuWhisper(gpuWhisperDir(настоящие.home)).catch(() => null))) {
    console.log('НЕЧЕМ МЕРИТЬ: распознавание лекций не установлено — сначала установка с --notes');
    return 2;
  }
  const папка = mkdtempSync(path.join(os.tmpdir(), 'jarvis-notes-onboarding-'));
  const настройкиФайл = path.join(папка, 'settings.json');
  if (existsSync(настоящие.settings)) copyFileSync(настоящие.settings, настройкиФайл);
  const settings = new SettingsStore(настройкиФайл);
  settings.update({ onboarded: false, language: 'ru', edition: 'notes', lectureLanguage: арг('language') ?? 'en' });

  openSettingsWindow({ settings, paths: { ...настоящие, settings: настройкиФайл }, onFinished: () => undefined, onSettingsChanged: () => undefined });
  const окно = BrowserWindow.getAllWindows()[0];
  if (!окно) {
    console.log('НЕ ПРОШЛО: окно настройки не открылось');
    return 1;
  }
  const ошибки: string[] = [];
  окно.webContents.on('console-message', (event) => {
    if (event.level === 'error') ошибки.push(event.message);
  });
  const js = <T>(код: string): Promise<T> => окно.webContents.executeJavaScript(код, true) as Promise<T>;
  const заголовок = (): Promise<string> => (окно.isDestroyed() ? Promise.resolve('') : js<string>(`document.querySelector('h1')?.textContent ?? ''`));
  const текст = (селектор = 'body'): Promise<string> => js<string>(`document.querySelector(${JSON.stringify(селектор)})?.innerText ?? ''`);
  const нажать = (селектор: string): Promise<string> =>
    js<string>(`(() => { const b = document.querySelector(${JSON.stringify(селектор)}); if (!b) return 'нет кнопки'; if (b.disabled) return 'кнопка серая'; b.click(); return 'ok'; })()`);
  const ждать = async (условие: () => Promise<boolean>, мс: number): Promise<boolean> => {
    const конец = Date.now() + мс;
    while (Date.now() < конец) {
      if (await условие().catch(() => false)) return true;
      await подождать(500);
    }
    return false;
  };

  const итоги: Array<{ имя: string; итог: Итог }> = [];
  const шаг = async (имя: string, делать: () => Promise<Итог>): Promise<void> => {
    try {
      итоги.push({ имя, итог: await делать() });
    } catch (беда) {
      итоги.push({ имя, итог: { вид: 'не прошло', что: (беда instanceof Error ? беда.message : String(беда)).slice(0, 240) } });
    }
  };
  const далее = async (ждём: string): Promise<Итог> => {
    const нажато = await нажать('[data-act=next]');
    if (нажато !== 'ok') return { вид: 'не прошло', что: `«Далее»: ${нажато}` };
    return (await ждать(async () => (await заголовок()) === ждём, 20_000)) ? { вид: 'прошло', что: ждём } : { вид: 'не прошло', что: `заголовок «${await заголовок()}», ждали «${ждём}»` };
  };

  await шаг('первый шаг', async () =>
    (await ждать(async () => (await заголовок()) === ru.onboardingTitle, 20_000)) ? { вид: 'прошло', что: ru.onboardingTitle } : { вид: 'не прошло', что: `заголовок «${await заголовок()}»` },
  );
  await шаг('«Далее» → агент', () => далее(ru.stepAgent));

  if (ставить === 'claude' || ставить === 'codex') {
    await шаг(`«Установить» ставит ${ставить} без Терминала`, async () => {
      const до = await cliStatus(ставить);
      if (до.installed) return { вид: 'нечем мерить', что: `${ставить} уже стоит: ${до.path}` };
      const нажато = await нажать('[data-act=install]');
      if (нажато !== 'ok') return { вид: 'не прошло', что: `«Установить»: ${нажато}` };
      const встал = await ждать(async () => (await cliStatus(ставить)).installed, 8 * 60_000);
      const ошибка = await текст('[data-act=install-error]');
      if (!встал) return { вид: 'не прошло', что: `за 8 минут не встал${ошибка ? `: ${ошибка}` : ''}` };
      const после = await cliStatus(ставить);
      const карточкаВидит = await ждать(async () => (await текст('main')).includes(ru.agentInstalled), 30_000);
      return карточкаВидит ? { вид: 'прошло', что: `${после.path} ${после.version ?? ''}` } : { вид: 'не прошло', что: 'встал, а карточка не показала «установлен»' };
    });
  }

  await шаг('«Проверить связь» — ответ или причина по каждому агенту', async () => {
    const нажато = await нажать('#brain-check [data-act=run]');
    if (нажато === 'кнопка серая') return { вид: 'нечем мерить', что: 'ни одного агента' };
    if (нажато !== 'ok') return { вид: 'не прошло', что: `«${ru.brainCheckRun}»: ${нажато}` };
    const пришло = await ждать(async () => (await текст('#brain-check [data-act=result]')).trim().length > 0, 4 * 60_000);
    const ответ = (await текст('#brain-check [data-act=result]')).replace(/\s+/gu, ' ').trim();
    return пришло ? { вид: 'прошло', что: ответ.slice(0, 200) } : { вид: 'не прошло', что: 'за 4 минуты ни ответа, ни причины' };
  });

  await шаг('«Далее» → лекции', () => далее(ru.stepLecture));
  await шаг('«Далее» → микрофон', () => далее(ru.stepMic));
  await шаг('«Записать 8 секунд» → «Услышал…» и скорость', async () => {
    const нажато = await нажать('#hearing-check [data-act=rec]');
    if (нажато !== 'ok') return { вид: 'не прошло', что: `«${ru.hearingRun}»: ${нажато}` };
    const пришло = await ждать(async () => (await текст('#hearing-check [data-act=result]')).trim().length > 0, 5 * 60_000);
    const ответ = (await текст('#hearing-check [data-act=result]')).replace(/\s+/gu, ' ').trim();
    if (!пришло) return { вид: 'не прошло', что: 'за 5 минут ничего' };
    return ответ.includes('Услышал') ? { вид: 'прошло', что: ответ.slice(0, 240) } : { вид: 'не прошло', что: ответ.slice(0, 240) };
  });
  await шаг('«Далее» → готово', () => далее(ru.stepReady));
  await шаг('«Начать» — онбординг пройден', async () => {
    const нажато = await нажать('[data-act=next]');
    if (нажато !== 'ok') return { вид: 'не прошло', что: `«${ru.finish}»: ${нажато}` };
    return (await ждать(async () => settings.get().onboarded, 10_000)) ? { вид: 'прошло', что: 'onboarded' } : { вид: 'не прошло', что: 'onboarded не встал' };
  });
  if (ошибки.length > 0) итоги.push({ имя: 'ошибки страницы', итог: { вид: 'не прошло', что: ошибки.join('; ').slice(0, 300) } });

  let неПрошло = 0;
  let нечем = 0;
  for (const { имя, итог } of итоги) {
    if (итог.вид === 'не прошло') неПрошло++;
    if (итог.вид === 'нечем мерить') нечем++;
    console.log(`  ${итог.вид === 'прошло' ? 'прошло      ' : итог.вид === 'не прошло' ? 'НЕ ПРОШЛО   ' : 'нечем мерить'} ${имя} — ${итог.что}`);
  }
  console.log(`Всего ${итоги.length}: не прошло ${неПрошло}, нечем мерить ${нечем}`);
  return неПрошло > 0 ? 1 : 0;
}

app.on('window-all-closed', () => undefined);
void app.whenReady().then(async () => {
  let код = 1;
  try {
    код = await main();
  } catch (беда) {
    console.log(`НЕ ПРОШЛО: ${беда instanceof Error ? беда.message : String(беда)}`);
  }
  app.exit(код);
});
