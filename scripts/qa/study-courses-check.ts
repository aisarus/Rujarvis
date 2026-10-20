/**
 * Правка курсов в окне учёбы настоящим Электроном — скрытым:
 * `pnpm jarvis:study-courses-check [-- --en]`.
 *
 * Та же страница, тот же мост, та же служба, а хранилище и учёба —
 * временные: настоящие курсы проверка не трогает. Окно не показывается и
 * фокус не берёт; нажатия — событиями страницы, а не мышью.
 *
 * Как человек: «+ Новый курс» с языком лекций → курс; язык конспекта —
 * списком на странице курса; «Изменить» — новое название (у курса с лекцией и
 * банком вопросов: переезжают и они); «Удалить курс» — подтверждение в окне →
 * папка в Корзине Windows настоящим `shell.trashItem`.
 *
 * Отвечает: прошло / не прошло.
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { app, shell } from 'electron';

import { openStudyWindow, studyWindowForCheck } from '../../app/studyWindow';
import { setLanguage } from '../../jarvis/locale/language';
import { StudyService } from '../../jarvis/study/service';
import { StudyStore } from '../../jarvis/study/store';
import type { LectureBank } from '../../jarvis/study/types';

const ждать = (мс: number): Promise<void> => new Promise((r) => setTimeout(r, мс));
const en = process.argv.includes('--en');
setLanguage(en ? 'en' : 'ru');
const T = en
  ? { courses: 'Courses', newCourse: '+ New course', create: 'Create', name: 'Course name', lectureLang: 'Lecture language:', notesLang: 'Notes language:', edit: 'Edit', save: 'Save', del: 'Delete course', yes: 'Delete', bin: 'Recycle Bin', deleted: 'is deleted' }
  : { courses: 'Курсы', newCourse: '+ Новый курс', create: 'Создать', name: 'Название курса', lectureLang: 'Язык лекций:', notesLang: 'Язык конспекта:', edit: 'Изменить', save: 'Сохранить', del: 'Удалить курс', yes: 'Удалить', bin: 'Корзин', deleted: 'удалён' };

app.setPath('userData', mkdtempSync(path.join(os.tmpdir(), 'jarvis-study-courses-')));

/** Курс с одной лекцией и банком вопросов — проверить, что переименование уносит учёбу с собой. */
function курсСЛекцией(vault: string, store: StudyStore, курс: string): string {
  const папка = path.join(vault, курс);
  mkdirSync(папка, { recursive: true });
  writeFileSync(path.join(папка, `${курс}.md`), `---\nкурс: '${курс}'\n---\n\n# ${курс}\n`, 'utf8');
  const заметка = path.join(папка, '2026-10-20 — Спрос.md');
  writeFileSync(
    заметка,
    `---\nкурс: ${курс}\nлекция: 1\nдата: 2026-10-20\nтема: Спрос\n---\n# Спрос\nРасшифровка: [[2026-10-20 — Спрос — расшифровка]] · [[${курс}]]\n\n## Конспект\n\n### Спрос (01:00–05:00)\n- спрос падает с ценой\n`,
    'utf8',
  );
  const bank: LectureBank = {
    version: 1,
    lecture: '2026-10-20 — Спрос',
    notesFile: заметка,
    audioFile: заметка.replace(/\.md$/u, '.wav'),
    course: курс,
    date: '2026-10-20',
    number: 1,
    topic: 'Спрос',
    generatedAt: Date.now(),
    topics: [{ id: '2026-10-20 — Спрос#1', lecture: '2026-10-20 — Спрос', title: 'Спрос', from: 60, to: 300 }],
    questions: [],
    cards: [{ id: 'к1', topicId: '2026-10-20 — Спрос#1', front: 'спрос', back: 'сколько купят', source: { lecture: '2026-10-20 — Спрос', at: 90 }, origin: 'concept' }],
    tasks: [],
    warnings: [],
  };
  store.saveBank(bank);
  return заметка;
}

void app.whenReady().then(async () => {
  const корень = mkdtempSync(path.join(os.tmpdir(), 'jarvis-study-courses-vault-'));
  const vault = path.join(корень, 'Лекции');
  mkdirSync(vault, { recursive: true });
  const store = new StudyStore(path.join(корень, 'study'));
  курсСЛекцией(vault, store, 'Микро');
  const вКорзину: string[] = [];
  const service = new StudyService({
    store,
    vaultRoot: () => vault,
    notes: en ? 'en' : 'ru',
    languages: () => ({ lecture: 'he', notes: en ? 'en' : 'ru' }),
    trash: async (file) => {
      вКорзину.push(file);
      await shell.trashItem(file);
    },
  });

  const ошибки: string[] = [];
  openStudyWindow({ service: () => service, preparing: () => [], prepare: () => undefined, language: () => (en ? 'en' : 'ru'), hidden: true });
  const окно = studyWindowForCheck();
  if (!окно) {
    console.log('НЕ ПРОШЛО: окно не создалось');
    app.exit(1);
    return;
  }
  окно.webContents.on('console-message', (event) => {
    if (event.level === 'error') ошибки.push(event.message);
  });
  await new Promise<void>((r) => окно.webContents.once('did-finish-load', () => r()));
  const js = <R>(код: string): Promise<R> => окно.webContents.executeJavaScript(код) as Promise<R>;
  const текст = (): Promise<string> => js<string>("document.querySelector('main').innerText");
  const нажать = (надпись: string): Promise<boolean> =>
    js<boolean>(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === ${JSON.stringify(надпись)}); if (b) b.click(); return Boolean(b); })()`);
  /** Ждать, пока на странице не появится текст. */
  const дождаться = async (что: string | RegExp, мс = 4000): Promise<string> => {
    let сейчас = '';
    for (let i = 0; i < мс / 100; i += 1) {
      сейчас = await текст();
      if (typeof что === 'string' ? сейчас.includes(что) : что.test(сейчас)) return сейчас;
      await ждать(100);
    }
    return сейчас;
  };
  /** Выбрать в списке, что стоит после подписи, — как выбор мышью: значение и событие change. */
  const выбрать = (подпись: string, значение: string): Promise<boolean> =>
    js<boolean>(`(() => {
      const b = [...document.querySelectorAll('b')].find((x) => x.textContent === ${JSON.stringify(подпись)});
      const s = b && b.nextElementSibling;
      if (!s || s.tagName !== 'SELECT') return false;
      s.value = ${JSON.stringify(значение)};
      s.dispatchEvent(new Event('change'));
      return true;
    })()`);
  const заголовок = (): Promise<string> => js<string>("document.querySelector('main h1')?.textContent ?? ''");
  const страница = (курс: string): string => {
    try {
      return readFileSync(path.join(vault, курс, `${курс}.md`), 'utf8');
    } catch {
      return '';
    }
  };

  // `--shots=папка` — снимки страницы курса и подтверждения: посмотреть вёрстку глазами.
  const снимки = process.argv.find((a) => a.startsWith('--shots='))?.slice('--shots='.length);
  const снять = async (имя: string): Promise<void> => {
    if (!снимки) return;
    // Скрытое окно рисует лениво: дать странице дорисоваться.
    await ждать(800);
    mkdirSync(снимки, { recursive: true });
    writeFileSync(path.join(снимки, `${имя}${en ? '-en' : ''}.png`), (await окно.webContents.capturePage()).toPNG());
  };

  const провалы: string[] = [];
  const шаг = (ок: boolean, что: string, подробно = ''): void => {
    console.log(`  ${ок ? 'да ' : 'НЕТ'} ${что}${подробно ? ` — ${подробно}` : ''}`);
    if (!ок) провалы.push(что);
  };

  await дождаться(T.courses);
  await нажать(T.courses);
  await дождаться(T.newCourse);

  // 1. Новый курс с языком лекций.
  const имя = en ? 'Window check course' : 'Проверка окна учёбы';
  await нажать(T.newCourse);
  await js(`(() => { const i = [...document.querySelectorAll('input')].find((x) => x.placeholder === ${JSON.stringify(T.name)}); i.value = ${JSON.stringify(имя)}; })()`);
  await js(`(() => { const s = [...document.querySelectorAll('b')].find((x) => x.textContent === ${JSON.stringify(T.lectureLang)}).nextElementSibling; s.value = 'en'; })()`);
  await нажать(T.create);
  await дождаться(T.edit);
  шаг((await заголовок()) === имя && /^язык: en$/mu.test(страница(имя)), 'новый курс: страница курса с языком лекций', `заголовок «${await заголовок()}»`);

  // 2. Язык конспекта — списком на странице курса.
  шаг(await выбрать(T.notesLang, 'en'), 'список языка конспекта на странице курса');
  await ждать(700);
  шаг(/^конспект: en$/mu.test(страница(имя)), 'язык конспекта записан в страницу курса');
  const выбрано = await js<string>(`[...document.querySelectorAll('b')].find((x) => x.textContent === ${JSON.stringify(T.lectureLang)})?.nextElementSibling?.value ?? ''`);
  шаг(выбрано === 'en', 'после перерисовки в списке — язык курса', `«${выбрано}»`);
  await снять('1-курс');

  // 3. «Изменить» — новое название.
  const новое = en ? 'Window check renamed' : 'Проверка окна — переименован';
  await нажать(T.edit);
  await снять('2-изменить');
  await js(`(() => { const i = [...document.querySelectorAll('input')].find((x) => x.value === ${JSON.stringify(имя)}); i.value = ${JSON.stringify(новое)}; })()`);
  await нажать(T.save);
  for (let i = 0; i < 40 && (await заголовок()) !== новое; i += 1) await ждать(100);
  шаг((await заголовок()) === новое && !existsSync(path.join(vault, имя)) && /^язык: en$/mu.test(страница(новое)), 'переименование пустого курса: папка и страница, языки на месте');

  // 4. Курс с лекцией и банком: «Изменить» уносит и учёбу.
  await нажать(en ? '← Back' : '← Назад');
  await дождаться('Микро');
  await js("[...document.querySelectorAll('button.card')].find((b) => b.textContent.includes('Микро'))?.click()");
  await дождаться(T.edit);
  await нажать(T.edit);
  await js("(() => { const i = [...document.querySelectorAll('input')].find((x) => x.value === 'Микро'); i.value = 'Микроэкономика'; })()");
  await нажать(T.save);
  for (let i = 0; i < 40 && (await заголовок()) !== 'Микроэкономика'; i += 1) await ждать(100);
  const банк = store.banks('Микроэкономика')[0];
  const заметка = path.join(vault, 'Микроэкономика', '2026-10-20 — Спрос.md');
  шаг(
    (await заголовок()) === 'Микроэкономика' && store.courses().join() === 'Микроэкономика' && банк?.notesFile === заметка && readFileSync(заметка, 'utf8').includes('[[Микроэкономика]]'),
    'переименование курса с лекцией: банк вопросов и ссылка в заметке переехали',
    `банки: ${store.courses().join(', ')}`,
  );
  const карточек = await текст();
  шаг(/Спрос/u.test(карточек), 'страница переименованного курса показывает лекцию и тему');

  // 5. «Удалить курс» пустой — подтверждение в окне, папка в Корзину.
  await нажать(en ? '← Back' : '← Назад');
  await дождаться(новое);
  await js(`[...document.querySelectorAll('button.card')].find((b) => b.textContent.includes(${JSON.stringify(новое)}))?.click()`);
  await дождаться(T.del);
  await нажать(T.del);
  const вопрос = await дождаться(T.bin);
  шаг(вопрос.includes(T.bin) && existsSync(path.join(vault, новое)), 'подтверждение в окне, до него ничего не удалено');
  await снять('3-удалить');
  await нажать(T.yes);
  const после = await дождаться(T.deleted, 8000);
  шаг(после.includes(T.deleted) && !existsSync(path.join(vault, новое)) && вКорзину.length === 1, 'пустой курс удалён — в Корзину Windows', вКорзину.map((f) => path.basename(f)).join(', '));
  шаг(readdirSync(vault).sort().join() === 'Микроэкономика', 'остальные курсы на месте', readdirSync(vault).join(', '));
  await снять('4-курсы');

  if (ошибки.length > 0) провалы.push(`ошибки страницы: ${ошибки.join('; ').slice(0, 300)}`);
  console.log(провалы.length === 0 ? 'ПРОШЛО' : `НЕ ПРОШЛО: ${провалы.join('; ')}`);
  app.exit(провалы.length === 0 ? 0 : 1);
});
