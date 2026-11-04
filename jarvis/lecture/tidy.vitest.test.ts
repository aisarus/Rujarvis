import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { GRAPH_FORCES } from '../notes/graphSettings';
import { StudyService } from '../study/service';
import { StudyStore } from '../study/store';
import { parseFrontmatter, renderFrontmatter, withFormulasMark } from './courses';
import { moveLecture } from './finalize';
import { VaultTidier, type TidyDeps } from './tidy';
import { obsidianState, vaultOfFolder, type ObsidianState } from './vault';

const папки: string[] = [];
afterEach(async () => {
  for (const папка of папки.splice(0)) await rm(папка, { recursive: true, force: true });
});

interface Стенд {
  vault: string;
  root: string;
  dir: string;
  граф: string;
  физика: string;
  алгебра: string;
  вызовы: string[];
  открыт: { state: ObsidianState };
  ответ: { fn: (prompt: string) => string };
  tidier(extra?: Partial<TidyDeps>): VaultTidier;
}

/** Хранилище: две лекции с формулами, новая без них, свои файлы человека, настройки графа. */
async function стенд(): Promise<Стенд> {
  const корень = await mkdtemp(path.join(tmpdir(), 'jarvis-tidy-'));
  папки.push(корень);
  const vault = path.join(корень, 'хранилище');
  const root = path.join(vault, 'Лекции');
  const dir = path.join(корень, 'данные', 'tidy');
  await mkdir(path.join(vault, '.obsidian'), { recursive: true });
  await mkdir(path.join(root, 'Физика', 'Материалы'), { recursive: true });
  await mkdir(path.join(root, 'Алгебра'), { recursive: true });
  const граф = path.join(vault, '.obsidian', 'graph.json');
  await writeFile(граф, JSON.stringify({ search: '', showOrphans: true, 'свой-ключ': 1, colorGroups: [{ query: 'tag:#важное', color: { a: 1, rgb: 7 } }], scale: 0.4 }), 'utf8');
  const заметка = (курс: string, тело: string): string => `${renderFrontmatter({ course: курс, number: 1, date: '2026-10-13', topic: 'Тема' }, 'ru')}# Тема\n\n## Конспект\n\n### Раздел (00:00–05:00)\n${тело}\n`;
  const физика = path.join(root, 'Физика', '2026-10-13 — Тема.md');
  const алгебра = path.join(root, 'Алгебра', '2026-10-13 — Тема.md');
  await writeFile(физика, заметка('Физика', '- скорость v = s/t\n- обычный текст про физику\n- сила F = m·a'), 'utf8');
  await writeFile(алгебра, заметка('Алгебра', '- корень x = 5'), 'utf8');
  await writeFile(path.join(root, 'Физика', '2026-10-20 — Без формул.md'), заметка('Физика', '- только слова'), 'utf8');
  // Своё: расшифровка, звук, файлы и заметка с формулой, не лекция.
  await writeFile(path.join(root, 'Физика', '2026-10-13 — Тема — расшифровка.md'), '# Расшифровка\n\n**[00:00]** x = 5\n', 'utf8');
  await writeFile(path.join(root, 'Физика', '2026-10-13 — Тема.wav'), Buffer.alloc(44));
  await writeFile(path.join(root, 'Физика', 'Материалы', 'статья.md'), 'y = 6\n', 'utf8');
  await writeFile(path.join(root, 'План.md'), 'x = 5\n', 'utf8');
  const вызовы: string[] = [];
  const открыт = { state: 'closed' as ObsidianState };
  // Модель понарошку: заворачивает всё после «= » и подобное в формулы.
  const ответ = {
    fn: (prompt: string): string => {
      const строки = prompt.split('Строки:\n')[1]?.split('\n') ?? [];
      return строки.map((с) => с.replace(/^(\d+\| - .*?)([a-zA-Z] = .+)$/u, '$1$$$2$$')).join('\n');
    },
  };
  return {
    vault,
    root,
    dir,
    граф,
    физика,
    алгебра,
    вызовы,
    открыт,
    ответ,
    tidier: (extra = {}) =>
      new VaultTidier({
        root,
        dir,
        summarize: async (prompt) => {
          вызовы.push(prompt);
          return ответ.fn(prompt);
        },
        obsidian: async () => открыт.state,
        now: () => Date.UTC(2026, 10, 4),
        pollMs: 5,
        ...extra,
      }),
  };
}

/** Снимок дерева: путь → отпечаток; то, что кнопка не должна трогать, сравнивается целиком. */
function снимок(папка: string, база = папка, out: Record<string, string> = {}): Record<string, string> {
  for (const имя of readdirSync(папка)) {
    const полный = path.join(папка, имя);
    if (statSync(полный).isDirectory()) снимок(полный, база, out);
    else out[path.relative(база, полный)] = createHash('sha256').update(readFileSync(полный)).digest('hex');
  }
  return out;
}

const дождаться = async (условие: () => boolean): Promise<void> => {
  await vi.waitFor(() => expect(условие()).toBe(true), { timeout: 2000, interval: 5 });
};

describe('«Упорядочить хранилище»', () => {
  it('граф и формулы: цвета курсов, LaTeX в строках формул, пометка; файлы на местах', async () => {
    const с = await стенд();
    const до = снимок(с.root);
    const порядок = с.tidier();

    const план = await порядок.plan();
    expect(план.nothing).toBe(false);
    expect(план.lines.join(' ')).toMatch(/заметок 2, строк 3 — вызовов модели по вашей подписке: 2/u);

    const итог = await порядок.run();
    expect(итог).toMatchObject({ running: false, waiting: null, canUndo: true });
    expect(итог.lines.join(' ')).toMatch(/настройки на диске.*Obsidian был закрыт/u);
    expect(итог.lines.join(' ')).toMatch(/заметок 2, строк 3/u);

    const граф = JSON.parse(await readFile(с.граф, 'utf8'));
    expect(граф['свой-ключ']).toBe(1);
    expect(граф.scale).toBe(0.4);
    expect(граф.colorGroups.map((г: { query: string }) => г.query)).toEqual(['tag:#важное', 'path:"Лекции/Алгебра"', 'path:"Лекции/Физика"']);
    expect(граф).toMatchObject({ showOrphans: false, hideUnresolved: true, ...GRAPH_FORCES });

    const физика = await readFile(с.физика, 'utf8');
    expect(физика).toContain('- скорость $v = s/t$\n- обычный текст про физику\n- сила $F = m·a$');
    expect(parseFrontmatter(физика)?.formulas).toBe(true);
    // Модель видит только строки формул, а не остальной текст заметки.
    expect(с.вызовы.join('\n')).not.toContain('обычный текст про физику');

    // Кроме двух заметок с формулами в «Лекциях» не изменился и не появился ни один файл.
    const после = снимок(с.root);
    expect(Object.keys(после).sort()).toEqual(Object.keys(до).sort());
    const изменились = Object.keys(после).filter((ф) => после[ф] !== до[ф]);
    expect(изменились.sort()).toEqual([path.relative(с.root, с.алгебра), path.relative(с.root, с.физика)].sort());
  });

  it('повторное нажатие ничего не стоит и ничего не меняет', async () => {
    const с = await стенд();
    await с.tidier().run();
    const вызововБыло = с.вызовы.length;
    const было = { граф: readFileSync(с.граф, 'utf8'), дерево: снимок(с.root) };

    const порядок = с.tidier();
    const план = await порядок.plan();
    expect(план).toMatchObject({ nothing: true });
    expect(план.lines[0]).toMatch(/Всё уже в порядке/u);
    const итог = await порядок.run();
    expect(итог.lines.join(' ')).toMatch(/Граф уже настроен/u);
    expect(с.вызовы.length).toBe(вызововБыло);
    expect(readFileSync(с.граф, 'utf8')).toBe(было.граф);
    expect(снимок(с.root)).toEqual(было.дерево);
  });

  it('Obsidian открыт: файл графа не тронут и успеха нет; закрыли — записано само и проверено', async () => {
    const с = await стенд();
    const исходный = readFileSync(с.граф, 'utf8');
    с.открыт.state = 'running';
    const порядок = с.tidier();
    expect((await порядок.plan()).lines.join(' ')).toMatch(/Obsidian сейчас открыт/u);

    const итог = await порядок.run();
    expect(итог.waiting).toBe('apply');
    expect(итог.lines.join(' ')).toMatch(/Граф ещё не настроен/u);
    expect(итог.lines.join(' ')).not.toMatch(/настройки на диске/u);
    expect(readFileSync(с.граф, 'utf8')).toBe(исходный);
    // Формулы от открытого Obsidian не зависят: он подхватывает заметки сам.
    expect(parseFrontmatter(readFileSync(с.физика, 'utf8'))?.formulas).toBe(true);

    // Пока ждали, открытый Obsidian сохранил своё: это и сливается, а не прежний снимок.
    await new Promise((r) => setTimeout(r, 30));
    expect(порядок.state().waiting).toBe('apply');
    await writeFile(с.граф, JSON.stringify({ ...JSON.parse(исходный), scale: 0.9 }), 'utf8');
    с.открыт.state = 'closed';
    await дождаться(() => порядок.state().waiting === null);

    const граф = JSON.parse(readFileSync(с.граф, 'utf8'));
    expect(граф.scale).toBe(0.9);
    expect(граф.colorGroups).toHaveLength(3);
    expect(порядок.state().lines.join(' ')).toMatch(/настройки на диске.*Obsidian был закрыт/u);
    порядок.dispose();
  });

  it('«Не ждать» — граф не тронут; во время лекции и при неизвестном состоянии не пишем', async () => {
    const с = await стенд();
    const исходный = readFileSync(с.граф, 'utf8');
    с.открыт.state = 'running';
    const порядок = с.tidier();
    await порядок.run();
    expect(порядок.cancelWait().lines.join(' ')).toMatch(/вы отменили ожидание/u);
    с.открыт.state = 'closed';
    await new Promise((r) => setTimeout(r, 30));
    expect(readFileSync(с.граф, 'utf8')).toBe(исходный);

    с.открыт.state = 'unknown';
    const неясно = await с.tidier().run();
    expect(неясно.lines.join(' ')).toMatch(/не удалось проверить, открыт ли Obsidian/u);
    expect(readFileSync(с.граф, 'utf8')).toBe(исходный);

    // Лекция идёт: кнопка отказывает. Началась, пока ждали Obsidian: граф ждёт и её.
    const занято = { причина: 'идёт конспект' as string | null };
    const при = с.tidier({ busy: () => занято.причина });
    await expect(при.run()).rejects.toThrow(/идёт конспект/u);
    expect((await при.plan()).busy).toBe('идёт конспект');
    занято.причина = null;
    с.открыт.state = 'running';
    await при.run();
    занято.причина = 'идёт конспект';
    с.открыт.state = 'closed';
    await new Promise((r) => setTimeout(r, 30));
    expect(при.state().waiting).toBe('apply');
    expect(readFileSync(с.граф, 'utf8')).toBe(исходный);
    занято.причина = null;
    await дождаться(() => при.state().waiting === null);
    expect(JSON.parse(readFileSync(с.граф, 'utf8')).colorGroups).toHaveLength(3);
  });

  it('нет .obsidian — так и говорит, хранилище не выдумывает и ничего не создаёт', async () => {
    const с = await стенд();
    await rm(path.join(с.vault, '.obsidian'), { recursive: true });
    const до = снимок(с.vault);
    const порядок = с.tidier();
    expect(await порядок.plan()).toMatchObject({ nothing: true });
    expect((await порядок.plan()).lines[0]).toMatch(/нет хранилища Obsidian/u);
    const итог = await порядок.run();
    expect(итог.lines.join(' ')).toMatch(/нет хранилища Obsidian/u);
    expect(итог.canUndo).toBe(false);
    expect(снимок(с.vault)).toEqual(до);
    expect(existsSync(path.join(с.vault, '.obsidian'))).toBe(false);
    expect(с.вызовы).toEqual([]);
  });

  it('испорченный graph.json не перезаписывается', async () => {
    const с = await стенд();
    await writeFile(с.граф, '{ не json', 'utf8');
    const итог = await с.tidier().run();
    expect(итог.lines.join(' ')).toMatch(/не разобрать настройки графа/u);
    expect(readFileSync(с.граф, 'utf8')).toBe('{ не json');
  });

  it('модель не ответила — заметка без изменений и без пометки; следующее нажатие её доделает', async () => {
    const с = await стенд();
    const было = readFileSync(с.алгебра, 'utf8');
    с.ответ.fn = (prompt) => {
      if (prompt.includes('корень')) throw new Error('лимит подписки');
      return '1| - скорость $v = s/t$';
    };
    const итог = await с.tidier().run();
    expect(итог.lines.join(' ')).toMatch(/лимит подписки — заметка без изменений/u);
    expect(readFileSync(с.алгебра, 'utf8')).toBe(было);

    с.ответ.fn = () => '1| - корень $x = 5$';
    const вызовов = с.вызовы.length;
    const ещё = await с.tidier().run();
    expect(ещё.lines.join(' ')).toMatch(/заметок 1, строк 1/u);
    expect(с.вызовы.length).toBe(вызовов + 1);
  });

  it('модель подряд не отвечает — останавливается, не тратя время на остальные', async () => {
    const с = await стенд();
    await writeFile(path.join(с.root, 'Алгебра', '2026-10-20 — Ещё.md'), `${renderFrontmatter({ course: 'Алгебра', date: '2026-10-20' }, 'ru')}- y = 6\n`, 'utf8');
    с.ответ.fn = () => {
      throw new Error('нет сети');
    };
    const итог = await с.tidier().run();
    expect(с.вызовы).toHaveLength(2);
    expect(итог.lines.join(' ')).toMatch(/Остановился: модель не отвечает подряд, осталось заметок: 1/u);
  });

  it('модель поменяла число — строка остаётся, остальное принято, заметка помечена', async () => {
    const с = await стенд();
    const строкаБыла = '- сила F = m·a';
    с.ответ.fn = (prompt) => (prompt.includes('скорость') ? '1| - скорость $v = s/t$\n2| - сила $F = 2m·a$' : 'НЕТ');
    const итог = await с.tidier().run();
    expect(итог.lines.join(' ')).toMatch(/Строк не принято: 1/u);
    const текст = readFileSync(с.физика, 'utf8');
    expect(текст).toContain(строкаБыла);
    expect(текст).toContain('- скорость $v = s/t$');
    expect(parseFrontmatter(текст)?.formulas).toBe(true);
  });

  it('заметку поправили, пока модель думала — её правка важнее', async () => {
    const с = await стенд();
    с.ответ.fn = (prompt) => {
      if (prompt.includes('корень')) {
        void writeFile(с.алгебра, 'правка человека\n', 'utf8');
        return '1| - корень $x = 5$';
      }
      return 'НЕТ';
    };
    // Запись выше асинхронная: дожидаемся её прямо из ответа.
    const исходный = с.ответ.fn;
    const порядок = с.tidier({
      summarize: async (prompt) => {
        const ответ = исходный(prompt);
        await new Promise((r) => setTimeout(r, 20));
        return ответ;
      },
    });
    const итог = await порядок.run();
    expect(итог.lines.join(' ')).toMatch(/заметка изменилась, пока шла работа/u);
    expect(readFileSync(с.алгебра, 'utf8')).toBe('правка человека\n');
  });

  it('отмена возвращает заметки и граф; правленое после этого не трогает; можно нажать снова', async () => {
    const с = await стенд();
    const до = { граф: readFileSync(с.граф, 'utf8'), дерево: снимок(с.root) };
    await с.tidier().run();

    // Человек поправил одну заметку и завёл свой цвет после порядка.
    const правка = `${readFileSync(с.алгебра, 'utf8')}\nмоя правка\n`;
    await writeFile(с.алгебра, правка, 'utf8');
    const графСейчас = JSON.parse(readFileSync(с.граф, 'utf8'));
    await writeFile(с.граф, JSON.stringify({ ...графСейчас, 'добавил-потом': true }), 'utf8');

    const порядок = с.tidier();
    const итог = await порядок.undo();
    expect(итог.canUndo).toBe(false);
    expect(итог.lines.join(' ')).toMatch(/вернул прежний текст в 1/u);
    expect(итог.lines.join(' ')).toMatch(/заметку меняли после этого — оставляю/u);
    expect(итог.lines.join(' ')).toMatch(/как до первого нажатия/u);
    expect(readFileSync(с.физика, 'utf8')).not.toContain('$');
    expect(parseFrontmatter(readFileSync(с.физика, 'utf8'))?.formulas).toBeUndefined();
    expect(readFileSync(с.алгебра, 'utf8')).toBe(правка);
    expect(readFileSync(с.граф, 'utf8')).toBe(до.граф);
    expect(снимок(с.root)[path.relative(с.root, с.физика)]).toBe(до.дерево[path.relative(с.root, с.физика)]);

    // Ничего не потеряно: то, что отмена заменила, лежит в копиях.
    const копии = readdirSync(path.join(с.dir, 'graph'));
    expect(копии.some((и) => и.endsWith('.original.json'))).toBe(true);
    expect(копии.some((и) => и.endsWith('.replaced.json'))).toBe(true);

    // И снова можно навести порядок: копия снимается заново.
    expect((await с.tidier().run()).canUndo).toBe(true);
    expect(JSON.parse(readFileSync(с.граф, 'utf8')).colorGroups).toHaveLength(3);
  });

  it('отмена при открытом Obsidian: заметки сразу, граф — когда его закроют', async () => {
    const с = await стенд();
    const исходный = readFileSync(с.граф, 'utf8');
    await с.tidier().run();
    с.открыт.state = 'running';
    const порядок = с.tidier();
    const итог = await порядок.undo();
    expect(итог.waiting).toBe('undo');
    expect(readFileSync(с.физика, 'utf8')).not.toContain('$');
    expect(readFileSync(с.граф, 'utf8')).not.toBe(исходный);
    с.открыт.state = 'closed';
    await дождаться(() => порядок.state().waiting === null);
    expect(readFileSync(с.граф, 'utf8')).toBe(исходный);
  });

  it('файла настроек не было: появится; отмена уберёт его в копии, а не удалит', async () => {
    const с = await стенд();
    await rm(с.граф);
    await с.tidier().run();
    expect(JSON.parse(readFileSync(с.граф, 'utf8')).colorGroups).toHaveLength(2);
    await с.tidier().undo();
    expect(existsSync(с.граф)).toBe(false);
    expect(readdirSync(path.join(с.dir, 'graph')).some((и) => и.endsWith('.created.json'))).toBe(true);
  });
});

describe('хранилище и открытый Obsidian', () => {
  it('хранилище — ближайшая папка сверху с .obsidian; нет такой — null', async () => {
    const с = await стенд();
    expect(vaultOfFolder(с.root)).toBe(с.vault);
    expect(vaultOfFolder(path.join(с.root, 'Физика'))).toBe(с.vault);
    await rm(path.join(с.vault, '.obsidian'), { recursive: true });
    expect(vaultOfFolder(с.root, () => false)).toBeNull();
  });

  it('система отвечает одним из трёх: на чужой системе — не падает и не выдумывает «закрыт»', async () => {
    expect(['running', 'closed', 'unknown']).toContain(await obsidianState());
    // pgrep нет (Windows) — «не знаю», а не «закрыт».
    if (process.platform === 'win32') expect(await obsidianState('darwin')).toBe('unknown');
  });
});

describe('кнопка через службу учёбы', () => {
  it('копии — в папке данных рядом с учёбой; лекция идёт — отказ; повторное нажатие — без модели', async () => {
    const с = await стенд();
    const данные = path.dirname(с.dir);
    const занято = { причина: null as string | null };
    let вызовов = 0;
    const служба = new StudyService({
      store: new StudyStore(path.join(данные, 'study')),
      vaultRoot: () => с.root,
      notes: 'ru',
      summarize: async (prompt) => {
        вызовов += 1;
        return с.ответ.fn(prompt);
      },
      vaultBusy: () => занято.причина,
      obsidian: async () => 'closed',
      now: () => Date.UTC(2026, 10, 4),
    });

    занято.причина = 'идёт конспект';
    await expect(служба.tidy()).rejects.toThrow(/идёт конспект/u);
    expect(вызовов).toBe(0);
    занято.причина = null;

    expect((await служба.tidyPlan()).nothing).toBe(false);
    expect((await служба.tidy()).lines.join(' ')).toMatch(/настройки на диске/u);
    expect(вызовов).toBe(2);
    expect(служба.tidyState().canUndo).toBe(true);
    expect(existsSync(path.join(данные, 'tidy', 'graph'))).toBe(true);
    expect(existsSync(path.join(данные, 'tidy', 'notes'))).toBe(true);

    expect((await служба.tidyPlan()).nothing).toBe(true);
    await служба.tidy();
    expect(вызовов).toBe(2);

    await служба.tidyUndo();
    expect(служба.tidyState().canUndo).toBe(false);
    expect(readFileSync(с.физика, 'utf8')).not.toContain('$');
  });
});

describe('пометка «формулы уже в LaTeX»', () => {
  it('ставится одной строкой: остальные свойства и текст как есть; на обоих языках', () => {
    const ru = '---\nкурс: Физика\nдата: 2026-10-13\nсвоё: важно\n---\n# Тема\n';
    expect(withFormulasMark(ru)).toBe('---\nкурс: Физика\nдата: 2026-10-13\nсвоё: важно\nформулы: LaTeX\n---\n# Тема\n');
    expect(withFormulasMark(withFormulasMark(ru))).toBe(withFormulasMark(ru));
    expect(withFormulasMark('---\r\ncourse: Physics\r\ndate: 2026-10-13\r\n---\r\n# T\r\n')).toBe('---\r\ncourse: Physics\r\ndate: 2026-10-13\r\nformulas: LaTeX\r\n---\r\n# T\r\n');
    expect(parseFrontmatter(withFormulasMark(ru))?.formulas).toBe(true);
    expect(withFormulasMark('# без свойств\n')).toBe('# без свойств\n');
  });

  it('переживает перенос лекции в другой курс; у необработанной не появляется', async () => {
    const с = await стенд();
    const перенесена = await moveLecture(с.root, с.алгебра, 'Геометрия', 'ru');
    expect(parseFrontmatter(readFileSync(перенесена.notesFile, 'utf8'))?.formulas).toBeUndefined();
    await writeFile(перенесена.notesFile, withFormulasMark(readFileSync(перенесена.notesFile, 'utf8')), 'utf8');
    const обратно = await moveLecture(с.root, перенесена.notesFile, 'Алгебра', 'ru');
    expect(parseFrontmatter(readFileSync(обратно.notesFile, 'utf8'))?.formulas).toBe(true);
  });
});
