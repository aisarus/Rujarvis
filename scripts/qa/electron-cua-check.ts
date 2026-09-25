/**
 * Компьютер-юз на маке: шесть инструментов против НАСТОЯЩЕГО окна.
 *
 * `windowTools.ts` отдаёт шесть действий — список окон, снимок, поиск
 * элемента, нажатие, ввод текста, клавиша. На Windows их делает `cua-driver`,
 * на маке — System Events и CoreGraphics. Форма ответов одна, и модель
 * различия не видит; значит и проверять надо одинаково, а на маке эти шесть
 * не проверял никто.
 *
 * Замер, а не рассуждение: поднимается своё окно Электрона с кнопкой и полем,
 * и каждый инструмент спрашивается по очереди. Ответы сверяются с тем, что
 * окно САМО про себя говорит, — не «инструмент не упал», а «нажатие дошло».
 *
 * Три ответа, а не два. Универсальный доступ на маке спрашивается у человека:
 * без него CGEvent не падает, а молча ничего не делает — худший из отказов.
 * Поэтому отсутствие разрешения это «нечем мерить» (код 2), а не «не
 * работает» (код 1): на первое чинят машину, на второе — программу.
 *
 *   pnpm jarvis:cua-check
 */

import { app, BrowserWindow } from 'electron';

import { createWindowTools } from '../../jarvis/desktop/windowTools';
import { DarwinDriver } from '../../jarvis/desktop/darwinDriver';

const ИМЯ_ОКНА = 'Проба компьютер-юза Rujarvis';

const СТРАНИЦА = `<!doctype html>
<html lang="ru">
<head><meta charset="utf-8"><title>${ИМЯ_ОКНА}</title></head>
<body style="font-family: system-ui; padding: 24px; background: #101014; color: #e4e4e7">
  <h1 id="zagolovok">Проба</h1>
  <button id="knopka">Нажми меня</button>
  <input id="pole" type="text" value="" placeholder="Сюда пишем">
  <p id="itog">не нажата</p>
  <script>
    document.getElementById('knopka').addEventListener('click', function () {
      document.getElementById('itog').textContent = 'нажата';
    });
  </script>
</body>
</html>`;

type Ответ = { прошло: true } | { прошло: false; почему: string } | { прошло: null; почему: string };

const итоги: Array<{ имя: string; ответ: Ответ }> = [];

function записать(имя: string, ответ: Ответ): void {
  итоги.push({ имя, ответ });
  const метка = ответ.прошло === true ? 'прошло      ' : ответ.прошло === false ? 'НЕ ПРОШЛО   ' : 'нечем мерить';
  const хвост = ответ.прошло === true ? '' : ` — ${ответ.почему}`;
  console.log(`  ${метка} ${имя}${хвост}`);
}

/** Нет разрешения — это «нечем мерить», а не «не работает». */
function нетДоступа(error: unknown): boolean {
  const текст = error instanceof Error ? error.message : String(error);
  return (
    текст.includes('Универсальный доступ') ||
    текст.includes('accessibility') ||
    текст.includes('not trusted') ||
    текст.includes('-25211') ||
    текст.includes('not allowed assistive')
  );
}

const ждать = (мс: number): Promise<void> => new Promise((готово) => setTimeout(готово, мс));

async function main(): Promise<void> {
  console.log(`Компьютер-юз на ${process.platform}: шесть инструментов против живого окна\n`);

  const окно = new BrowserWindow({
    width: 640,
    height: 420,
    title: ИМЯ_ОКНА,
    show: true,
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });
  await окно.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(СТРАНИЦА)}`);
  окно.setTitle(ИМЯ_ОКНА);
  окно.focus();
  // Окно появляется не мгновенно: на macos-latest между показом и попаданием
  // в список окон проходит до секунды (замер в jarvis:window-check).
  await ждать(1500);

  const инструменты = createWindowTools();
  let pid = 0;
  let windowId = 0;

  try {
    const окна = await инструменты.windows();
    const своё = окна.find((о) => о.title === ИМЯ_ОКНА);
    if (!своё) {
      записать('windows: своё окно есть в списке', {
        прошло: false,
        почему: `видно ${окна.length} окон, своего нет: ${окна.map((о) => о.title).slice(0, 5).join(' | ')}`,
      });
    } else {
      pid = своё.pid;
      windowId = своё.windowId;
      записать('windows: своё окно есть в списке', { прошло: true });
    }
  } catch (error) {
    const почему = error instanceof Error ? error.message : String(error);
    записать('windows: своё окно есть в списке', нетДоступа(error) ? { прошло: null, почему } : { прошло: false, почему });
  }

  if (pid) {
    try {
      const снимок = await инструменты.look(pid, windowId, `${app.getPath('temp')}/rujarvis-cua-check.png`);
      // Пустой кадр — это не снимок. Ширина и высота обязаны быть настоящими.
      записать(
        'look: снимок окна, а не пустой кадр',
        снимок.width > 100 && снимок.height > 100
          ? { прошло: true }
          : { прошло: false, почему: `кадр ${снимок.width}x${снимок.height}` },
      );
    } catch (error) {
      const почему = error instanceof Error ? error.message : String(error);
      записать('look: снимок окна, а не пустой кадр', нетДоступа(error) ? { прошло: null, почему } : { прошло: false, почему });
    }

    let индексКнопки = -1;
    try {
      const найдено = await инструменты.find(pid, windowId, 'Нажми');
      индексКнопки = найдено[0]?.index ?? -1;
      if (найдено.length === 0 && process.platform === 'darwin') {
        // Не гадать, а посмотреть: «кнопки нет» и «дерева нет» — разные беды,
        // и лечатся они по-разному. Своего мака у автора нет, и единственный
        // способ узнать, что там внутри, — напечатать это здесь.
        try {
          const драйвер = new DarwinDriver();
          const { title, elements } = await драйвер.elements();
          console.log(`    дерево окна «${title}»: ${elements.length} элементов`);
          for (const э of elements.slice(0, 12)) {
            console.log(`      ${э.type} | ${э.name}`);
          }
        } catch (беда) {
          console.log(`    дерево спросить не вышло: ${беда instanceof Error ? беда.message : String(беда)}`);
        }
      }
      записать(
        'find: кнопка находится по своему тексту',
        найдено.length > 0 ? { прошло: true } : { прошло: false, почему: 'кнопки нет в дереве окна' },
      );
    } catch (error) {
      const почему = error instanceof Error ? error.message : String(error);
      записать('find: кнопка находится по своему тексту', нетДоступа(error) ? { прошло: null, почему } : { прошло: false, почему });
    }

    if (индексКнопки >= 0) {
      try {
        await инструменты.press(pid, windowId, индексКнопки);
        await ждать(400);
        // Спрашиваем у самой страницы: «press не упал» и «нажатие дошло» —
        // разные утверждения, и на маке первое бывает верным без второго.
        const итог = await окно.webContents.executeJavaScript(
          "document.getElementById('itog').textContent",
        );
        записать(
          'press: нажатие правда дошло до страницы',
          итог === 'нажата' ? { прошло: true } : { прошло: false, почему: `страница говорит «${String(итог)}»` },
        );
      } catch (error) {
        const почему = error instanceof Error ? error.message : String(error);
        записать('press: нажатие правда дошло до страницы', нетДоступа(error) ? { прошло: null, почему } : { прошло: false, почему });
      }
    }

    try {
      const поля = await инструменты.find(pid, windowId, 'Сюда пишем');
      const индексПоля = поля[0]?.index ?? -1;
      if (индексПоля < 0) {
        записать('writeInto: текст доезжает до поля', { прошло: false, почему: 'поле не нашлось' });
      } else {
        await инструменты.writeInto(pid, windowId, индексПоля, 'проверка');
        await ждать(400);
        const значение = await окно.webContents.executeJavaScript(
          "document.getElementById('pole').value",
        );
        записать(
          'writeInto: текст доезжает до поля',
          String(значение).includes('проверка')
            ? { прошло: true }
            : { прошло: false, почему: `в поле «${String(значение)}»` },
        );
      }
    } catch (error) {
      const почему = error instanceof Error ? error.message : String(error);
      записать('writeInto: текст доезжает до поля', нетДоступа(error) ? { прошло: null, почему } : { прошло: false, почему });
    }

    try {
      await инструменты.key(pid, windowId, 'Tab');
      записать('key: клавиша уходит в окно без отказа', { прошло: true });
    } catch (error) {
      const почему = error instanceof Error ? error.message : String(error);
      записать('key: клавиша уходит в окно без отказа', нетДоступа(error) ? { прошло: null, почему } : { прошло: false, почему });
    }
  }

  инструменты.dispose();
  if (!окно.isDestroyed()) окно.destroy();

  const прошло = итоги.filter((и) => и.ответ.прошло === true).length;
  const провал = итоги.filter((и) => и.ответ.прошло === false).length;
  const нечем = итоги.filter((и) => и.ответ.прошло === null).length;
  console.log(`\nВсего ${итоги.length}: прошло ${прошло}, не прошло ${провал}, нечем мерить ${нечем}`);

  // Три ответа разными кодами: 1 — чинить программу, 2 — чинить машину.
  if (провал > 0) {
    app.exit(1);
    return;
  }
  app.exit(нечем > 0 && прошло === 0 ? 2 : 0);
}

// Своё окно закрывается в конце, и Электрон на этом гасит приложение.
app.on('window-all-closed', () => {});

void app
  .whenReady()
  .then(main)
  .catch((error: unknown) => {
    console.error('\nЗамер оборвался:', error instanceof Error ? error.message : String(error));
    app.exit(3);
  });
