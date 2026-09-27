/**
 * Онбординг целиком, настоящим окном: от первого шага мастера до «Начать».
 *
 * Условие 3 автопилота — установщик, онбординг и основа не ломаются, — а
 * онбординг до 27.09.2026 не проверял никто, кроме одного ручного прогона под
 * xvfb. Тестер придёт на мак: первое, что он увидит после установки, — этот
 * мастер, и серая кнопка «Далее» на нём значит, что Джарвиса у него нет.
 *
 * Окно, страница, IPC и хранилище настроек — те же, что у приложения
 * (`openSettingsWindow`). Нажатия — через DOM, как их делает человек: язык
 * туда и обратно, «Далее» по каждому шагу, «Начать». Прошло — если каждый
 * шаг показал своё, а «Начать» поставило `onboarded` и закрыло окно.
 *
 * Настройки — во временной папке и с непройденным онбордингом, как у
 * человека сразу после установки; модели — настоящие, поставленные
 * установщиком: их загрузку меряет download-check. Окно выходит на экран —
 * поэтому гоняется в CI, а не на машине человека.
 *
 * Три ответа: прошло, не прошло, нечем мерить (нет моделей или сборки).
 *
 *   node build.mjs && electron dist/qa/onboarding-check.cjs
 */
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { app, BrowserWindow } from 'electron';

import { cloudSpeechKey } from '../../app/cloudTranscriber';
import { openSettingsWindow } from '../../app/settingsWindow';
import { createClaudeProbe, createCodexProbe } from '../../jarvis/backends/cliProbes';
import { UI_STRINGS } from '../../app/ui/strings';
import { jarvisPaths } from '../../jarvis/setup/paths';
import { SettingsStore } from '../../jarvis/setup/settings';
import { WHISPER_MODELS } from '../../jarvis/voice/sttModels';
import { isVoiceInstalled, VOICES } from '../../jarvis/voice/tts';
import { isWhisperModelInstalled } from '../../jarvis/voice/whisperRecognizer';

type Итог = { вид: 'прошло' | 'не прошло' | 'нечем мерить'; что: string };

const ru = UI_STRINGS.ru;
const en = UI_STRINGS.en;
const подождать = (мс: number): Promise<void> => new Promise((готово) => setTimeout(готово, мс));

async function main(): Promise<number> {
  console.log('');
  console.log('Онбординг: мастер настоящим окном, от языка до «Начать»');

  const настоящие = jarvisPaths();
  const whisper = (
    await Promise.all(
      WHISPER_MODELS.map(async (m) => ((await isWhisperModelInstalled(настоящие.whisperModels, m.id)) ? m.id : null)),
    )
  ).find((id) => id !== null);
  const голос = VOICES.find((v) => v.language === 'ru' && isVoiceInstalled(настоящие.voiceModels, v.id))?.id;
  if (!whisper || !голос) {
    console.log(`НЕЧЕМ МЕРИТЬ: модели не поставлены (распознавание: ${whisper ?? 'нет'}, голос: ${голос ?? 'нет'}) — сначала установка`);
    return 2;
  }

  const папка = mkdtempSync(path.join(os.tmpdir(), 'jarvis-onboarding-'));
  const файл = path.join(папка, 'settings.json');
  if (existsSync(настоящие.settings)) copyFileSync(настоящие.settings, файл);
  const settings = new SettingsStore(файл);
  settings.update({ onboarded: false, language: 'ru', whisperModel: whisper, voiceId: голос });

  let закончен = false;
  openSettingsWindow({
    settings,
    paths: { ...настоящие, settings: файл },
    onFinished: () => {
      закончен = true;
    },
    onSettingsChanged: () => undefined,
  });

  const первое = BrowserWindow.getAllWindows()[0];
  if (!первое) {
    console.log('НЕ ПРОШЛО: окно настройки не открылось');
    return 1;
  }
  // Переменная: после «Начать» настройки открываются заново, и помощники
  // ниже должны смотреть уже в новое окно.
  let окно: BrowserWindow = первое;
  const js = <T>(код: string): Promise<T> => окно.webContents.executeJavaScript(код, true) as Promise<T>;
  const заголовок = (): Promise<string> =>
    окно.isDestroyed() ? Promise.resolve('') : js<string>(`document.querySelector('h1')?.textContent ?? ''`);
  const текст = (): Promise<string> => js<string>(`document.body.innerText`);
  const нажать = (селектор: string): Promise<string> =>
    js<string>(`(() => {
      const b = document.querySelector(${JSON.stringify(селектор)});
      if (!b) return 'нет кнопки';
      if (b.disabled) return 'кнопка серая';
      b.click();
      return 'ok';
    })()`);
  const дождаться = async (ждём: string, мс = 20_000): Promise<boolean> => {
    const конец = Date.now() + мс;
    while (Date.now() < конец) {
      if ((await заголовок().catch(() => '')) === ждём) return true;
      await подождать(200);
    }
    return false;
  };

  const итоги: Array<{ имя: string; итог: Итог }> = [];
  const шаг = async (имя: string, делать: () => Promise<Итог>): Promise<void> => {
    if (итоги.some((и) => и.итог.вид !== 'прошло')) {
      итоги.push({ имя, итог: { вид: 'нечем мерить', что: 'шаг выше не прошёл' } });
      return;
    }
    try {
      итоги.push({ имя, итог: await делать() });
    } catch (беда) {
      итоги.push({ имя, итог: { вид: 'не прошло', что: (беда instanceof Error ? беда.message : String(беда)).slice(0, 240) } });
    }
  };
  const далее = async (ждём: string): Promise<Итог> => {
    const нажато = await нажать('[data-act=next]');
    if (нажато !== 'ok') return { вид: 'не прошло', что: `«Далее»: ${нажато}; на странице: ${(await текст()).slice(0, 160)}` };
    return (await дождаться(ждём))
      ? { вид: 'прошло', что: ждём }
      : { вид: 'не прошло', что: `после «Далее» заголовок «${await заголовок()}», ждали «${ждём}»` };
  };

  await шаг('первый шаг — приветствие без «Windows», с Codex', async () => {
    if (!(await дождаться(ru.onboardingTitle))) return { вид: 'не прошло', что: `заголовок «${await заголовок()}»` };
    const страница = await текст();
    return страница.includes(ru.onboardingIntro) && !/Windows/u.test(страница)
      ? { вид: 'прошло', что: ru.onboardingTitle }
      : { вид: 'не прошло', что: страница.slice(0, 200) };
  });
  await шаг('язык: English и обратно', async () => {
    await нажать('[data-lang=en]');
    if (!(await дождаться(en.onboardingTitle))) return { вид: 'не прошло', что: `после English заголовок «${await заголовок()}»` };
    await нажать('[data-lang=ru]');
    if (!(await дождаться(ru.onboardingTitle))) return { вид: 'не прошло', что: `после «Русский» заголовок «${await заголовок()}»` };
    return { вид: 'прошло', что: `${en.onboardingTitle} → ${ru.onboardingTitle}` };
  });
  await шаг('«Далее» → агенты: Claude Code и Codex', async () => {
    const итог = await далее(ru.stepAgent);
    if (итог.вид !== 'прошло') return итог;
    const страница = await текст();
    return страница.includes('Claude Code') && страница.includes('Codex')
      ? итог
      : { вид: 'не прошло', что: `на шаге агентов нет карточек: ${страница.slice(0, 200)}` };
  });
  await шаг('«Далее» → модели (установленные — «Далее» не серое)', () => далее(ru.stepModels));
  await шаг('«Далее» → микрофон', () => далее(ru.stepMic));
  await шаг('«Далее» → готово', async () => {
    const итог = await далее(ru.stepReady);
    if (итог.вид !== 'прошло') return итог;
    const кнопка = await js<string>(`document.querySelector('[data-act=next]')?.textContent ?? ''`);
    return кнопка === ru.finish ? итог : { вид: 'не прошло', что: `на последнем шаге кнопка «${кнопка}», ждали «${ru.finish}»` };
  });
  await шаг('без агента — предупреждение и путь назад к агентам', async () => {
    // Живой тест на маке 27.09.2026: мастер пустил дальше без входа в Codex.
    // Правда — у тех же проб, что у окна: готов ли хоть один агент.
    const [claude, codex] = await Promise.all([createClaudeProbe().status(), createCodexProbe().status()]);
    const готов = [claude, codex].some((a) => a.installed && a.loggedIn !== false);
    const есть = await js<boolean>(`Boolean(document.getElementById('no-agent'))`);
    if (готов) {
      return есть
        ? { вид: 'не прошло', что: 'агент готов, а мастер пугает «Агент не подключён»' }
        : { вид: 'прошло', что: 'агент готов — предупреждения нет' };
    }
    if (!есть) return { вид: 'не прошло', что: 'ни один агент не готов, а предупреждения нет' };
    const назад = await нажать('[data-act=to-agents]');
    if (назад !== 'ok' || !(await дождаться(ru.stepAgent))) {
      return { вид: 'не прошло', что: `«${ru.noAgentBack}»: ${назад}, заголовок «${await заголовок()}»` };
    }
    for (const ждём of [ru.stepModels, ru.stepMic, ru.stepReady]) {
      const итог = await далее(ждём);
      if (итог.вид !== 'прошло') return итог;
    }
    return { вид: 'прошло', что: 'предупреждение есть, «Вернуться к агентам» ведёт на шаг агентов и обратно' };
  });
  await шаг('«Начать» — онбординг пройден, окно закрыто', async () => {
    const нажато = await нажать('[data-act=next]');
    if (нажато !== 'ok') return { вид: 'не прошло', что: `«Начать»: ${нажато}` };
    const конец = Date.now() + 10_000;
    while (Date.now() < конец && !(закончен && окно.isDestroyed())) await подождать(200);
    return закончен && settings.get().onboarded && окно.isDestroyed()
      ? { вид: 'прошло', что: 'onboarded = true, окно закрыто' }
      : { вид: 'не прошло', что: `закончен: ${закончен}, onboarded: ${settings.get().onboarded}, окно закрыто: ${окно.isDestroyed()}` };
  });

  // Где распознаётся речь — уже в обычных настройках. До 28.09.2026 облако
  // включалось само от ключа в системе, и звук уходил наружу без ведома
  // человека. Теперь это явный выбор, и этот компьютер — первым и по умолчанию.
  const карточка = (): Promise<{ есть: boolean; первая: boolean; облако: boolean; текст: string }> =>
    js(`(() => {
      const c = document.querySelector('#speech-place');
      const cloud = c && c.querySelector('input[value=cloud]');
      return { есть: Boolean(c), первая: document.querySelector('#main .card') === c,
        облако: Boolean(cloud && cloud.checked), текст: c ? c.innerText : '' };
    })()`);
  const ждатьНастройку = async (облако: boolean): Promise<boolean> => {
    const конец = Date.now() + 5_000;
    while (Date.now() < конец && settings.get().cloudSpeech !== облако) await подождать(100);
    return settings.get().cloudSpeech === облако;
  };
  await шаг('настройки → «Речь»: первой — где распознаётся речь, по умолчанию этот компьютер', async () => {
    openSettingsWindow({
      settings,
      paths: { ...настоящие, settings: файл },
      onFinished: () => undefined,
      onSettingsChanged: () => undefined,
    });
    const новое = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
    if (!новое) return { вид: 'не прошло', что: 'настройки не открылись' };
    окно = новое;
    if (!(await дождаться(ru.tabGeneral))) return { вид: 'не прошло', что: `заголовок «${await заголовок()}», ждали «${ru.tabGeneral}»` };
    const вкладка = await js<string>(`(() => {
      const b = [...document.querySelectorAll('#nav button')].find((x) => x.textContent === ${JSON.stringify(ru.tabVoice)});
      if (!b) return 'нет вкладки';
      b.click();
      return 'ok';
    })()`);
    if (вкладка !== 'ok' || !(await дождаться(ru.tabVoice))) return { вид: 'не прошло', что: `вкладка «${ru.tabVoice}»: ${вкладка}` };
    const к = await карточка();
    if (!к.есть) return { вид: 'не прошло', что: 'карточки «где распознаётся речь» нет' };
    if (!к.первая) return { вид: 'не прошло', что: 'карточка не первая на вкладке' };
    if (к.облако || settings.get().cloudSpeech) return { вид: 'не прошло', что: 'по умолчанию выбрано облако' };
    return к.текст.includes(ru.speechPlaceNowLocal)
      ? { вид: 'прошло', что: `«${ru.speechPlaceNowLocal} ${settings.get().whisperModel}»` }
      : { вид: 'не прошло', что: `нет строки «${ru.speechPlaceNowLocal}»: ${к.текст.slice(0, 160)}` };
  });
  await шаг('облако включается и выключается только переключателем', async () => {
    const вКлик = (значение: string): Promise<string> =>
      нажать(`#speech-place input[value=${значение}]`);
    if ((await вКлик('cloud')) !== 'ok' || !(await ждатьНастройку(true))) {
      return { вид: 'не прошло', что: `облако не записалось: cloudSpeech = ${settings.get().cloudSpeech}` };
    }
    // Ключа у проверки нет — окно обязано сказать, что облако не заработает.
    const сКлючом = Boolean(cloudSpeechKey(true));
    await подождать(300);
    const после = await карточка();
    const ждём = сКлючом ? ru.speechPlaceNowCloud : ru.speechPlaceNoKey;
    if (!после.текст.includes(ждём)) return { вид: 'не прошло', что: `нет «${ждём}»: ${после.текст.slice(0, 160)}` };
    if ((await вКлик('local')) !== 'ok' || !(await ждатьНастройку(false))) {
      return { вид: 'не прошло', что: `назад на этот компьютер не переключилось: cloudSpeech = ${settings.get().cloudSpeech}` };
    }
    return { вид: 'прошло', что: `облако → ${сКлючом ? 'облако' : '«ключа нет»'} → этот компьютер` };
  });

  if (!окно.isDestroyed()) окно.destroy();
  rmSync(папка, { recursive: true, force: true });

  let неПрошло = 0;
  let нечем = 0;
  for (const { имя, итог } of итоги) {
    if (итог.вид === 'не прошло') неПрошло++;
    if (итог.вид === 'нечем мерить') нечем++;
    const метка = итог.вид === 'прошло' ? 'прошло      ' : итог.вид === 'не прошло' ? 'НЕ ПРОШЛО   ' : 'нечем мерить';
    console.log(`  ${метка} ${имя} — ${итог.что}`);
  }
  console.log(`Всего ${итоги.length}: не прошло ${неПрошло}, нечем мерить ${нечем}`);
  return неПрошло > 0 ? 1 : нечем > 0 ? 2 : 0;
}

// Окно закрывается кнопкой «Начать» — приложение при этом жить обязано: итог
// печатается после.
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
