/**
 * Окно учёбы настоящим Электроном — скрытым: `pnpm jarvis:study-window-check`.
 *
 * Та же страница (`app/ui/study.html`), тот же мост (`studyPreload`), та же
 * служба — но окно не показывается и фокус не берёт. Банки учёбы копируются
 * во временную папку: ответы проверки не трогают настоящий прогресс.
 *
 * Проверяется то, чего не видно из тестов и стенда:
 * - мост из песочницы доходит до службы и обратно («Сегодня» нарисовано);
 * - квиз: ответ — разбор каждого варианта и источник;
 * - звук лекции открывается из файла при защите страницы (CSP);
 * - на странице нет ошибок.
 *
 * Отвечает: прошло / не прошло / нечем мерить (нет ни одного банка — сначала
 * `pnpm jarvis:study-prepare`).
 */

import { cpSync, existsSync, mkdtempSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { app } from 'electron';

import { openStudyWindow, studyWindowForCheck } from '../../app/studyWindow';
import { createClaudeSummarizer } from '../../jarvis/lecture/summarize';
import { lectureFolder } from '../../jarvis/lecture/vault';
import { jarvisOutputDir, jarvisPaths } from '../../jarvis/setup/paths';
import { SettingsStore } from '../../jarvis/setup/settings';
import { StudyService, studyRoot } from '../../jarvis/study/service';
import { StudyStore } from '../../jarvis/study/store';

const ждать = (мс: number): Promise<void> => new Promise((r) => setTimeout(r, мс));

app.setPath('userData', mkdtempSync(path.join(os.tmpdir(), 'jarvis-study-check-')));

void app.whenReady().then(async () => {
  const paths = jarvisPaths();
  const settings = new SettingsStore(paths.settings).get();
  const настоящие = studyRoot(paths.data);
  const банков = existsSync(настоящие) ? readdirSync(настоящие).length : 0;
  if (банков === 0) {
    console.log('НЕЧЕМ МЕРИТЬ: заготовленных лекций нет — pnpm jarvis:study-prepare');
    app.exit(2);
    return;
  }
  const копия = mkdtempSync(path.join(os.tmpdir(), 'jarvis-study-copy-'));
  cpSync(настоящие, копия, { recursive: true });
  const vault = lectureFolder(settings.outputDir || jarvisOutputDir(process.env, app.getPath('desktop'), settings.language === 'en' ? 'Jarvis' : 'Джарвис'), settings.language).folder;
  const service = new StudyService({ store: new StudyStore(копия), vaultRoot: () => vault, notes: settings.language, summarize: createClaudeSummarizer() });

  const ошибки: string[] = [];
  openStudyWindow({ service: () => service, preparing: () => [], prepare: () => undefined, language: () => settings.language, hidden: true });
  const окно = studyWindowForCheck();
  if (!окно) {
    console.log('НЕ ПРОШЛО: окно не создалось');
    app.exit(1);
    return;
  }
  окно.webContents.on('console-message', (_e, level, message) => {
    if (level >= 3) ошибки.push(message);
  });
  await new Promise<void>((r) => окно.webContents.once('did-finish-load', () => r()));
  const js = <T>(код: string): Promise<T> => окно.webContents.executeJavaScript(код) as Promise<T>;
  const текст = async (): Promise<string> => js<string>("document.querySelector('main').innerText");

  const провалы: string[] = [];
  let сегодня = '';
  for (let i = 0; i < 20 && !сегодня.includes('Курсы') && !сегодня.includes('Courses'); i += 1) {
    await ждать(250);
    сегодня = await текст();
  }
  console.log(`  «Сегодня»: ${сегодня.split('\n').slice(0, 3).join(' | ')}`);
  if (!/Курсы|Courses/u.test(сегодня)) провалы.push('«Сегодня» не нарисовано — мост не отвечает');

  // Квиз по первой заготовленной лекции — через мост, как нажатие кнопки.
  const курс = service.today().courses.find((c) => c.lectures > 0)?.name;
  if (курс) {
    await js(`(${String((name: string) => {
      const card = Array.from(document.querySelectorAll('button.card')).find((b) => (b.textContent ?? '').includes(name)) as HTMLButtonElement | undefined;
      card?.click();
    })})(${JSON.stringify(курс)})`);
    await ждать(600);
    await js("[...document.querySelectorAll('button')].find((b) => b.textContent === 'Квиз по курсу' || b.textContent === 'Course quiz')?.click()");
    await ждать(800);
    const вопрос = await текст();
    await js("document.querySelector('.option')?.click()");
    await ждать(800);
    const разбор = await текст();
    const причин = await js<number>("[...document.querySelectorAll('.option .why')].filter((w) => w.style.display !== 'none' && w.textContent).length");
    console.log(`  квиз: ${вопрос.split('\n')[1] ?? ''}; разборов вариантов после ответа: ${причин}`);
    if (причин !== 4) провалы.push(`после ответа видно ${причин} разборов из четырёх`);
    if (!/▶/u.test(разбор)) провалы.push('нет кнопки «где лектор это сказал»');

    // Звук из файла при CSP страницы.
    const звук = await js<string>(`(async () => {
      const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.startsWith('▶'));
      if (!btn) return 'нет кнопки';
      btn.click();
      const a = document.getElementById('audio');
      for (let i = 0; i < 30; i += 1) { await new Promise((r) => setTimeout(r, 100)); if (a.readyState >= 1) break; }
      const итог = a.readyState >= 1 ? 'звук открыт, ' + Math.round(a.duration) + ' с, с ' + Math.round(a.currentTime) + ' с' : 'звук не открылся: ' + (a.error ? a.error.code : 'нет данных');
      a.pause();
      return итог;
    })()`);
    console.log(`  ${звук}`);
    if (!звук.startsWith('звук открыт')) провалы.push(звук);
  } else {
    провалы.push('в «Сегодня» нет курса с лекциями');
  }

  if (ошибки.length > 0) провалы.push(`ошибки страницы: ${ошибки.join('; ').slice(0, 300)}`);
  console.log(провалы.length === 0 ? 'ПРОШЛО' : `НЕ ПРОШЛО: ${провалы.join('; ')}`);
  app.exit(провалы.length === 0 ? 0 : 1);
});
