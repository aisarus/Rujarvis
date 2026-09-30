import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { segmentConfidence } from '../../app/gpuTranscriber';
import { chunkLevel, cutAtPause, splitAtPauses } from './audioCut';
import {
  coursePage,
  guessByDeclared,
  guessBySchedule,
  lectureBase,
  listCourses,
  matchCourse,
  parseFrontmatter,
  parseSchedule,
  readCourseInfo,
  renderFrontmatter,
  splitCourseAndTopic,
  stripCourseGloss,
  withFrontmatter,
} from './courses';
import { finalizeLecture, moveLecture } from './finalize';
import { groupSections } from './finishFromTranscript';
import { BAD_CONFIDENCE, HearingMonitor } from './hearing';
import { LectureRecorder } from './recorder';
import { sectionTitle, withRange } from './session';

const папки: string[] = [];
afterEach(async () => {
  for (const папка of папки.splice(0)) await rm(папка, { recursive: true, force: true });
});

async function временная(): Promise<string> {
  const папка = await mkdtemp(path.join(tmpdir(), 'jarvis-courses-'));
  папки.push(папка);
  return папка;
}

/** Звук: речь (синус) с паузой тишины в `паузаС`. */
function звукСПаузой(всегоС: number, паузаС: number, частота = 16_000): Float32Array {
  const out = new Float32Array(всегоС * частота);
  for (let i = 0; i < out.length; i += 1) {
    const t = i / частота;
    out[i] = Math.abs(t - паузаС) < 0.2 ? 0 : 0.3 * Math.sin(2 * Math.PI * 220 * t);
  }
  return out;
}

describe('нарезка лекции по паузам', () => {
  it('режет в тишине между 20-й и 28-й секундой, а не вслепую', () => {
    const звук = звукСПаузой(30, 23.4);
    const срез = cutAtPause(звук, 16_000);
    expect(срез).not.toBeNull();
    // Пауза — 0,4 с, кадр — 0,1 с: срез попадает внутрь паузы.
    expect(Math.abs((срез as number) / 16_000 - 23.4)).toBeLessThan(0.2);
    // Меньше 28 секунд — резать рано.
    expect(cutAtPause(звук.subarray(0, 16_000 * 27), 16_000)).toBeNull();
  });

  it('вся запись — куски подряд, без дыр и без потерь', () => {
    const звук = звукСПаузой(95, 50);
    const куски = splitAtPauses(звук, 16_000);
    expect(куски[0]?.[0]).toBe(0);
    expect(куски[куски.length - 1]?.[1]).toBe(звук.length);
    for (let i = 1; i < куски.length; i += 1) expect(куски[i]?.[0]).toBe(куски[i - 1]?.[1]);
    for (const [от, до] of куски) expect((до - от) / 16_000).toBeLessThanOrEqual(28);
  });

  it('сплошная запись: склеенные куски — ровно то, что пришло', () => {
    const куски: Float32Array[] = [];
    const запись = new LectureRecorder((samples) => куски.push(samples));
    const звук = звукСПаузой(70, 25);
    for (let i = 0; i < звук.length; i += 16_000) запись.push(звук.subarray(i, i + 16_000), 16_000);
    запись.flush();
    const всего = куски.reduce((n, к) => n + к.length, 0);
    expect(всего).toBe(звук.length);
    const склеено = new Float32Array(всего);
    let at = 0;
    for (const к of куски) {
      склеено.set(к, at);
      at += к.length;
    }
    expect(склеено).toEqual(звук);
    // Первый кусок кончился в паузе на 25-й секунде.
    expect(Math.abs((куски[0]?.length ?? 0) / 16_000 - 25)).toBeLessThan(0.2);
  });

  it('уровень: речь над полом и доля речи; тишина — не речь', () => {
    expect(chunkLevel(new Float32Array(16_000 * 5), 16_000).speechShare).toBe(0);
    // Слоги по 0,7 с и паузы по 0,3 с с тихим шумом комнаты.
    const звук = new Float32Array(16_000 * 10);
    for (let i = 0; i < звук.length; i += 1) {
      const t = i / 16_000;
      звук[i] = (t % 1 < 0.7 ? 0.3 * Math.sin(2 * Math.PI * 220 * t) : 0) + 0.001 * Math.sin(2 * Math.PI * 50 * t);
    }
    const речь = chunkLevel(звук, 16_000);
    expect(речь.speechShare).toBeGreaterThan(0.6);
    expect(речь.speechShare).toBeLessThan(0.8);
    expect(речь.speechDb - речь.floorDb).toBeGreaterThan(30);
  });
});

describe('курсы', () => {
  it('курс узнаётся в любом падеже, но «история» — не «история древнего мира»', () => {
    const курсы = ['История человечества', 'История древнего мира', 'Социология'];
    expect(matchCourse('истории человечества', курсы)).toBe('История человечества');
    expect(matchCourse('социологию', курсы)).toBe('Социология');
    expect(matchCourse('истории', курсы)).toBeNull();
    expect(matchCourse('физике', курсы)).toBeNull();
  });

  it('расписание: две лекции в тот же день недели около того же часа — и явный лидер', () => {
    const лекции = [
      { course: 'История', date: '2026-09-15', start: '10:00' },
      { course: 'История', date: '2026-09-22', start: '10:05' },
      { course: 'Социология', date: '2026-09-22', start: '14:00' },
    ];
    // 29.09.2026 — вторник, как и 15-е и 22-е.
    expect(guessBySchedule(new Date(2026, 8, 29, 10, 20), лекции)).toBe('История');
    expect(guessBySchedule(new Date(2026, 8, 29, 14, 0), лекции)).toBeNull(); // одна — могла быть переносом
    expect(guessBySchedule(new Date(2026, 8, 30, 10, 0), лекции)).toBeNull(); // среда
    expect(guessBySchedule(new Date(2026, 8, 29, 12, 30), лекции)).toBeNull(); // не тот час
  });

  it('страница курса: иврит с апострофом, расписание, экзамен — и курс по расписанию с первой пары', async () => {
    const root = await временная();
    await mkdir(path.join(root, 'Математика А'));
    await writeFile(
      path.join(root, 'Математика А', 'Математика А.md'),
      "---\nкурс: 'Математика А'\nкод: '66-4102'\nиврит: 'מתמטיקה א'''\nкредиты: 3\nрасписание: 'вт 16:00-19:00; чт 10:00-12:00'\nэкзамен: 2027-02-10\n---\n# Математика А\n",
      'utf8',
    );
    const info = readCourseInfo(root, 'Математика А');
    expect(info).toMatchObject({ code: '66-4102', hebrew: "מתמטיקה א'", credits: 3, exam: '2027-02-10' });
    expect(info.slots).toEqual([
      { day: 2, from: 960, to: 1140 },
      { day: 4, from: 600, to: 720 },
    ]);
    const микро = { name: 'Микро', slots: parseSchedule('вт 10:00–13:00') };
    // 20.10.2026 — вторник.
    expect(guessByDeclared(new Date(2026, 9, 20, 15, 40), [info, микро])).toBe('Математика А'); // за двадцать минут до пары
    expect(guessByDeclared(new Date(2026, 9, 20, 10, 5), [info, микро])).toBe('Микро');
    expect(guessByDeclared(new Date(2026, 9, 20, 19, 30), [info, микро])).toBeNull();
    expect(guessByDeclared(new Date(2026, 9, 21, 16, 0), [info, микро])).toBeNull(); // среда
    expect(stripCourseGloss("Математика А (מתמטיקה א')")).toBe('Математика А');
    expect(readCourseInfo(root, 'Нет такого')).toEqual({ name: 'Нет такого', slots: [] });
  });

  it('свойства заметки: туда и обратно, в обоих языках, с двоеточием в теме', () => {
    const meta = { course: 'История', number: 3, date: '2026-09-29', start: '10:05', topic: 'Неолит: начало', duration: '1:28' };
    expect(parseFrontmatter(renderFrontmatter(meta, 'ru'))).toEqual(meta);
    expect(parseFrontmatter(renderFrontmatter(meta, 'en'))).toEqual(meta);
    expect(parseFrontmatter('# просто заметка')).toBeNull();
    const заменено = withFrontmatter(`${renderFrontmatter(meta, 'ru')}# Тема\n`, { ...meta, number: 4 }, 'ru');
    expect(заменено.match(/^---$/gmu)).toHaveLength(2);
    expect(parseFrontmatter(заменено)?.number).toBe(4);
  });

  it('имя лекции — дата и тема без запрещённых знаков', () => {
    expect(lectureBase('2026-09-29', 'Неолит: начало?')).toBe('2026-09-29 — Неолит начало');
    expect(lectureBase('2026-09-29', undefined)).toBe('2026-09-29');
  });

  it('предмет и тема — из первых строк ответа модели, остальное — итог', () => {
    const { course, topic, rest } = splitCourseAndTopic('**Предмет:** История человечества\nТема: «Неолитическая революция»\n\n## Кратко\nТекст.');
    expect(course).toBe('История человечества');
    expect(topic).toBe('Неолитическая революция');
    expect(rest).toBe('## Кратко\nТекст.');
    expect(splitCourseAndTopic('## Summary\nText.')).toEqual({ course: undefined, topic: undefined, rest: '## Summary\nText.' });
  });

  it('страница курса: список между пометками, написанное человеком — на месте', () => {
    const лекции = [{ file: 'x/2026-09-29 — Неолит.md', meta: { course: 'История', number: 1, date: '2026-09-29' } }];
    const новая = coursePage(null, 'История', лекции, 'ru');
    expect(новая).toContain('1. [[2026-09-29 — Неолит]] — 29.09.2026');
    const своя = `# История\n\nМои заметки о курсе.\n\n${новая.slice(новая.indexOf('%%'))}\nЕщё строка.`;
    const обновлена = coursePage(своя, 'История', [...лекции, { file: 'x/2026-10-06 — Бронза.md', meta: { course: 'История', number: 2, date: '2026-10-06' } }], 'ru');
    expect(обновлена).toContain('Мои заметки о курсе.');
    expect(обновлена).toContain('Ещё строка.');
    expect(обновлена).toContain('2. [[2026-10-06 — Бронза]]');
    expect(обновлена.match(/1\. \[\[/gu)).toHaveLength(1);
  });

  it('время раздела — в заголовке и снимается обратно', () => {
    expect(withRange('### Пределы\n- пункт', 760_000, 1_075_000)).toBe('### Пределы (12:40–17:55)\n- пункт');
    expect(sectionTitle('### Пределы (12:40–17:55)')).toBe('Пределы');
    expect(sectionTitle('### Пределы (1:02:03–1:07:00)')).toBe('Пределы');
    expect(sectionTitle('### Тема куска: Большая история')).toBe('Большая история');
  });

  it('разделы по расшифровке знают свои минуты', () => {
    const куски = Array.from({ length: 14 }, (_, i) => ({ at: i * 40, text: 'слово '.repeat(20).trim() }));
    const разделы = groupSections(куски);
    // Раздел закрылся куском на 320-й секунде, а тот длится до следующего — до 360-й.
    expect(разделы[0]).toMatchObject({ from: 0, to: 360 });
    expect(разделы[1]?.from).toBe(360);
  });
});

async function лекцияНаДиске(папка: string, база: string, текстЗаметки?: string): Promise<{ notesFile: string; transcriptFile: string; audioFile: string }> {
  await mkdir(папка, { recursive: true });
  const notesFile = path.join(папка, `${база}.md`);
  const transcriptFile = path.join(папка, `${база} — расшифровка.md`);
  const audioFile = path.join(папка, `${база}.wav`);
  await writeFile(
    notesFile,
    текстЗаметки ?? `# Лекция\n\nРасшифровка: [[${база} — расшифровка]] · звук: ${база}.wav\n\n## Кратко\nО неолите.\n\n## Конспект\n\n### Неолит (00:00–05:00)\n- пункт\n`,
    'utf8',
  );
  await writeFile(transcriptFile, `# Расшифровка — Лекция\n\nКонспект: [[${база}]]\n\n**[00:00]** текст\n`, 'utf8');
  await writeFile(audioFile, Buffer.alloc(44));
  return { notesFile, transcriptFile, audioFile };
}

describe('лекция кончилась — по местам', () => {
  it('папка курса, тема в имени, свойства, ссылки и страница курса', async () => {
    const root = await временная();
    const файлы = await лекцияНаДиске(root, '2026-09-29 1005 Лекция');
    const итог = await finalizeLecture({
      root,
      ...файлы,
      notes: 'ru',
      when: new Date(2026, 8, 29, 10, 5),
      durationSec: 5280,
      course: null,
      modelCourse: 'История человечества',
      topic: 'Неолитическая революция',
    });
    const папка = path.join(root, 'История человечества');
    expect(итог).toMatchObject({ course: 'История человечества', number: 1 });
    expect((await readdir(папка)).sort()).toEqual(
      [
        '2026-09-29 — Неолитическая революция — расшифровка.md',
        '2026-09-29 — Неолитическая революция.md',
        '2026-09-29 — Неолитическая революция.wav',
        'История человечества.md',
      ].sort(),
    );
    expect(existsSync(файлы.notesFile)).toBe(false);
    const заметка = await readFile(итог.notesFile, 'utf8');
    expect(parseFrontmatter(заметка)).toEqual({
      course: 'История человечества',
      number: 1,
      date: '2026-09-29',
      start: '10:05',
      topic: 'Неолитическая революция',
      duration: '1:28',
    });
    expect(заметка).toContain('# Неолитическая революция');
    expect(заметка).toContain('Расшифровка: [[2026-09-29 — Неолитическая революция — расшифровка]] · [[История человечества]]');
    expect(заметка).toContain('![[2026-09-29 — Неолитическая революция.wav]]');
    expect(заметка).toContain('### Неолит (00:00–05:00)');
    expect(await readFile(итог.transcriptFile, 'utf8')).toContain('Конспект: [[2026-09-29 — Неолитическая революция]]');
    expect(await readFile(path.join(папка, 'История человечества.md'), 'utf8')).toContain('1. [[2026-09-29 — Неолитическая революция]]');
    // «Без курса» — не курс: в списке для выбора и для модели его нет.
    await mkdir(path.join(root, 'Без курса'));
    expect(listCourses(root)).toEqual(['История человечества']);
  });

  it('выбранный человеком курс важнее названного моделью; номер растёт', async () => {
    const root = await временная();
    const первая = await лекцияНаДиске(root, 'a');
    await finalizeLecture({ root, ...первая, notes: 'ru', when: new Date(2026, 8, 22, 10), durationSec: 60, course: 'История', topic: 'Первая' });
    const вторая = await лекцияНаДиске(root, 'b');
    const итог = await finalizeLecture({
      root,
      ...вторая,
      notes: 'ru',
      when: new Date(2026, 8, 29, 10),
      durationSec: 60,
      course: 'истории',
      modelCourse: 'Социология',
      topic: 'Вторая',
    });
    expect(итог).toMatchObject({ course: 'История', number: 2 });
  });

  it('запасная запись того же дня заменяет лекцию: прежние файлы — в Корзину, номер тот же', async () => {
    const root = await временная();
    const первая = await лекцияНаДиске(root, 'a');
    const была = await finalizeLecture({ root, ...первая, notes: 'ru', when: new Date(2026, 8, 29, 10), durationSec: 60, course: 'История', topic: 'С ноутбука' });
    const вКорзине: string[] = [];
    const запасная = await лекцияНаДиске(root, 'b');
    const итог = await finalizeLecture({
      root,
      ...запасная,
      notes: 'ru',
      when: new Date(2026, 8, 29, 10, 1),
      durationSec: 60,
      course: 'История',
      topic: 'С телефона',
      replaceSameDay: true,
      trash: async (файл) => {
        вКорзине.push(path.basename(файл));
        await rm(файл);
      },
    });
    expect(вКорзине.sort()).toEqual([path.basename(была.notesFile), path.basename(была.transcriptFile), path.basename(была.audioFile)].sort());
    expect(итог.number).toBe(1);
    const страница = await readFile(path.join(root, 'История', 'История.md'), 'utf8');
    expect(страница).toContain('С телефона');
    expect(страница).not.toContain('С ноутбука');
  });

  it('перенос в другой курс: обе страницы курса, один проигрыватель звука', async () => {
    const root = await временная();
    const файлы = await лекцияНаДиске(root, 'a');
    const была = await finalizeLecture({ root, ...файлы, notes: 'ru', when: new Date(2026, 8, 29, 10), durationSec: 90, course: 'История', topic: 'Общество' });
    const итог = await moveLecture(root, была.notesFile, 'социологию', 'ru');
    expect(итог.course).toBe('социологию');
    // Новый курс со слуха — как сказан; известный узнаётся по основе.
    const заметка = await readFile(итог.notesFile, 'utf8');
    expect(заметка.match(/!\[\[/gu)).toHaveLength(1);
    expect(parseFrontmatter(заметка)).toMatchObject({ course: 'социологию', number: 1, topic: 'Общество', start: '10:00', duration: '0:02' });
    expect(await readFile(path.join(root, 'История', 'История.md'), 'utf8')).not.toContain('Общество');
    expect(await readFile(path.join(root, 'социологию', 'социологию.md'), 'utf8')).toContain('Общество');
  });
});

describe('слышно ли лектора', () => {
  const уровень = { speechDb: -25, floorDb: -50, speechShare: 0.8 };
  it('молчит, пока речи мало; «плохо» — по уверенности распознавания, «наладилось» — с зазором', () => {
    const слух = new HearingMonitor();
    expect(слух.observe({ seconds: 30, level: уровень, text: 'а', confidence: -0.4 })).toBeNull(); // 24 с речи — рано
    expect(слух.observe({ seconds: 30, level: уровень, text: 'а', confidence: -0.4 })).toBe('bad');
    expect(слух.observe({ seconds: 30, level: уровень, text: 'а', confidence: -0.4 })).toBeNull(); // уже сказано
    // Придвинули ноутбук — окно в две минуты заполняется хорошими кусками.
    let вердикт: string | null = null;
    for (let i = 0; i < 6 && !вердикт; i += 1) вердикт = слух.observe({ seconds: 30, level: уровень, text: 'а', confidence: -0.05 });
    expect(вердикт).toBe('recovered');
  });

  it('тишина и куски без уверенности не судятся — лучше промолчать, чем пугать', () => {
    const слух = new HearingMonitor();
    for (let i = 0; i < 10; i += 1) {
      expect(слух.observe({ seconds: 28, level: { ...уровень, speechShare: 0 }, text: null })).toBeNull();
      expect(слух.observe({ seconds: 28, level: уровень, text: 'а' })).toBeNull();
    }
  });

  it('порог «плохо» лежит между замеренными «терпимо» и «половина слов мимо»', () => {
    // Замер зала 30.09.2026: шёпот зала 10 дБ (29% ошибок) — −0,17; зал (46%) — −0,23.
    expect(BAD_CONFIDENCE).toBeLessThan(-0.174);
    expect(BAD_CONFIDENCE).toBeGreaterThan(-0.229);
  });

  it('уверенность ответа сервера — средняя по сегментам, взвешенная длительностью', () => {
    expect(segmentConfidence([{ start: 0, end: 3, avg_logprob: -0.1 }, { start: 3, end: 4, avg_logprob: -0.5 }])).toBeCloseTo(-0.2);
    expect(segmentConfidence([])).toBeUndefined();
    expect(segmentConfidence(undefined)).toBeUndefined();
    expect(segmentConfidence([{ start: 1, end: 1, avg_logprob: -9 }])).toBeUndefined();
  });
});
