/**
 * Плашка сворачивается в панель задач и разворачивается обратно — настоящим
 * Электроном: `pnpm jarvis:overlay-minimize-check`.
 *
 * Плашку показывает и сворачивает сама проверка, поэтому гоняется она в CI, а
 * не на машине, за которой сидит человек. Нажимается настоящая «–» на
 * странице, разворачивает — `restore()`, как щелчок по кнопке в панели.
 *
 * Проверяется:
 * - «–» сворачивает окно, а не делает из него что-то поверх всего;
 * - на Windows у свёрнутой появляется кнопка «Rujarvis» в панели задач, у
 *   развёрнутой её нет (читается через UI Automation, без щелчков);
 * - крупный режим, включённый свёрнутой, развёрнутая получает: свёрнутое окно
 *   заданный размер теряет;
 * - развёрнутая встаёт на прежнее место и снова не берёт фокус.
 *
 * `OVERLAY_SHOT=<файл.png>` — снимок низа экрана со свёрнутой плашкой (идёт
 * запись — с красной точкой): что кнопка выглядит как Джарвис, по числам не
 * проверить.
 *
 * Отвечает: прошло / не прошло / нечем мерить (панель задач не читается).
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { app, BrowserWindow, desktopCapturer, screen } from 'electron';

import { APP_USER_MODEL_ID } from '../../app/root';
import { createStatusOverlay } from '../../app/statusOverlay';

const ждать = (мс: number): Promise<void> => new Promise((r) => setTimeout(r, мс));

async function дождаться(условие: () => boolean, мс = 4000): Promise<boolean> {
  const до = Date.now() + мс;
  while (Date.now() < до) {
    if (условие()) return true;
    await ждать(100);
  }
  return условие();
}

/** Подписи кнопок панели задач Windows; null — панель не читается. */
function кнопкиПанели(): string[] | null {
  const ps = [
    '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
    'Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes',
    '$A = [System.Windows.Automation.AutomationElement]',
    "$tray = $A::RootElement.FindFirst([System.Windows.Automation.TreeScope]::Children, (New-Object System.Windows.Automation.PropertyCondition($A::ClassNameProperty, 'Shell_TrayWnd')))",
    "if (-not $tray) { exit 3 }",
    '$b = New-Object System.Windows.Automation.PropertyCondition($A::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button)',
    '$tray.FindAll([System.Windows.Automation.TreeScope]::Descendants, $b) | ForEach-Object { $_.Current.Name }',
  ].join('; ');
  try {
    const вывод = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', timeout: 30_000 });
    return вывод.split(/\r?\n/u).map((s) => s.trim()).filter(Boolean);
  } catch {
    return null;
  }
}

async function снимокНизаЭкрана(файл: string): Promise<void> {
  const { width, height } = screen.getPrimaryDisplay().size;
  const [экран] = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width, height } });
  if (!экран) return;
  const низ = экран.thumbnail.crop({ x: 0, y: Math.max(0, height - 90), width, height: Math.min(90, height) });
  writeFileSync(файл, низ.toPNG());
  console.log(`снимок низа экрана: ${файл}`);
}

app.setPath('userData', mkdtempSync(path.join(os.tmpdir(), 'jarvis-overlay-check-')));
if (process.platform === 'win32') app.setAppUserModelId(APP_USER_MODEL_ID);

void app.whenReady().then(async () => {
  const провалы: string[] = [];
  const нечем: string[] = [];
  const windows = process.platform === 'win32';

  const былиДо = new Set(BrowserWindow.getAllWindows());
  const плашка = createStatusOverlay();
  const состояние = { indicator: 'listening', listening: true, awake: true, muted: false, label: 'Слушаю' } as never;
  плашка.update(состояние);
  const окно = BrowserWindow.getAllWindows().find((w) => !былиДо.has(w));
  if (!окно || !(await дождаться(() => окно.isVisible() && !окно.webContents.isLoading(), 10_000))) {
    console.log('НЕЧЕМ МЕРИТЬ: окно плашки не показалось');
    app.exit(2);
    return;
  }
  await ждать(500);
  const было = окно.getBounds();
  const доКнопки = windows ? кнопкиПанели() : [];
  const своя = (кнопки: string[]): string[] => кнопки.filter((имя) => /Rujarvis/u.test(имя));

  if (windows && доКнопки && своя(доКнопки).length > 0) провалы.push(`у развёрнутой плашки кнопка в панели задач: ${своя(доКнопки).join(' | ')}`);

  // Настоящая «–» на странице: проверяется и страница, и главный процесс.
  await окно.webContents.executeJavaScript("document.getElementById('mini').click()");
  if (!(await дождаться(() => окно.isMinimized()))) {
    провалы.push('«–» не свернула плашку');
  } else {
    console.log('«–»: плашка свёрнута');
    if (windows) {
      const кнопки = await (async () => {
        // Кнопка появляется не мгновенно.
        for (let i = 0; i < 20; i += 1) {
          const к = кнопкиПанели();
          if (!к || своя(к).length > 0) return к;
          await ждать(250);
        }
        return кнопкиПанели();
      })();
      if (!кнопки) нечем.push('панель задач не читается через UI Automation');
      else if (своя(кнопки).length === 0) провалы.push(`у свёрнутой нет кнопки «Rujarvis» в панели задач; есть: ${кнопки.join(' | ')}`);
      else console.log(`кнопка в панели задач: ${своя(кнопки).join(' | ')}`);
    }

    // Пока свёрнута: идёт запись и включили крупный режим.
    плашка.setLecture('on');
    плашка.setBig(true);
    await ждать(400);
    if (!окно.isMinimized()) провалы.push('крупный режим развернул свёрнутую плашку');

    const снимок = process.env.OVERLAY_SHOT;
    if (снимок) await снимокНизаЭкрана(снимок).catch((error) => console.log(`снимок не вышел: ${String(error)}`));

    // Щелчок по кнопке в панели задач — для окна это restore.
    окно.restore();
    if (!(await дождаться(() => !окно.isMinimized() && окно.isVisible()))) {
      провалы.push('плашка не развернулась');
    } else {
      await ждать(600);
      const стало = окно.getBounds();
      console.log(`было ${JSON.stringify(было)}, стало ${JSON.stringify(стало)}`);
      if (окно.isFocusable()) провалы.push('развёрнутая плашка снова берёт фокус');
      // Крупная — 560 точек; масштаб экрана сдвигает на пару точек.
      if (стало.width < 540) провалы.push(`крупный режим, включённый свёрнутой, потерялся: ширина ${стало.width}`);
      if (Math.abs(стало.x + стало.width - (было.x + было.width)) > 4 && Math.abs(стало.x - было.x) > 4) {
        провалы.push(`развёрнутая встала не туда: было x=${было.x}, стало x=${стало.x}`);
      }
      if (windows) {
        await ждать(400);
        const после = кнопкиПанели();
        if (после && своя(после).length > 0) провалы.push(`у развёрнутой осталась кнопка в панели задач: ${своя(после).join(' | ')}`);
      }
    }
  }

  плашка.dispose();
  for (const п of провалы) console.log(`НЕ ПРОШЛО: ${п}`);
  for (const н of нечем) console.log(`НЕЧЕМ МЕРИТЬ: ${н}`);
  const код = провалы.length > 0 ? 1 : нечем.length > 0 ? 2 : 0;
  console.log(`Всего: ${код === 0 ? 'прошло' : код === 1 ? 'не прошло' : 'нечем мерить'}`);
  app.exit(код);
});
