import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rename, rm, utimes, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const папка = vi.hoisted(() => ({ путь: '' }));

vi.mock('electron', () => ({ shell: { openExternal: vi.fn(async () => undefined) } }));
// Настоящий obsidian.json владельца указывает на его заметки: проверка туда не пишет.
vi.mock('../jarvis/lecture/vault', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../jarvis/lecture/vault')>()),
  lectureFolder: () => ({ folder: папка.путь, vault: null }),
}));

// Модель конспекта понарошку: курс, тема и итог — без настоящего Claude Code.
vi.mock('../jarvis/lecture/summarize', () => {
  const модель = () => async (prompt: string) =>
    prompt.includes('## Кратко') ? 'Предмет: История\nТема: Аграрная революция\n\n## Кратко\nО земледелии.' : '### Земледелие\n- пункт';
  return { createAgentSummarizer: модель, createAgentFinalSummarizer: модель };
});

const { feedLecture, finishLecture, lectureActive, lectureFromFile, lectureInfo, lectureState, onLectureState, startLecture } = await import('./lectureMode');
const { parseFrontmatter } = await import('../jarvis/lecture/courses');
const { encodeWav16 } = await import('../jarvis/voice/wav');
const { readWavParts } = await import('../jarvis/lecture/mediaSlices');

afterEach(async () => {
  await finishLecture();
  if (папка.путь) await rm(папка.путь, { recursive: true, force: true });
});

describe('режим лекции в мосте', () => {
  it('«закончи» не держит мост: лекция кончается сразу, итог приходит потом', async () => {
    папка.путь = await mkdtemp(path.join(tmpdir(), 'jarvis-lecture-mode-'));
    const options = { home: папка.путь, outputDir: папка.путь, lectureLanguage: 'ru', notesLanguage: 'ru' as const, mainEndpoint: () => null };

    // Ни модели для лекций, ни общего сервера: звук пишется, а расшифровать
    // нечем — так и сказано. До 13.10.2026 здесь ждали «Конспектирую общим
    // распознаванием», и тест закреплял неправду: на чистой машине конспект
    // выходил пустым.
    expect(await startLecture('Физика', options)).toMatch(/нечем|nothing to transcribe/u);
    expect(lectureInfo()?.line).toMatch(/Только запись|Recording only/u);
    expect(lectureActive()).toBe(true);
    expect(await startLecture('Физика', options)).toMatch(/уже пишется|Already/u);

    const итог = finishLecture();
    expect(итог).not.toBeNull();
    // Следующая фраза — уже разговор, а не лекция.
    expect(lectureActive()).toBe(false);
    // Прошлая ещё дописывается и держит порт своего сервера — новая ждёт.
    expect(await startLecture('Химия', options)).toMatch(/дописываю|Still finishing/u);
    expect(lectureActive()).toBe(false);

    expect(await итог).toMatch(/разделов — 0|0 sections/u);
    // Ничего не услышано — модели нечего назвать, и лекция ложится «без курса»:
    // заметка со свойствами, расшифровка и страница курса.
    const безКурса = path.join(папка.путь, 'Без курса');
    expect((await readdir(безКурса)).filter((f) => f.endsWith('.md')).sort()).toHaveLength(3);
    expect((await readdir(папка.путь)).filter((f) => f.endsWith('.md'))).toHaveLength(0);
    expect(await startLecture('Химия', options)).not.toMatch(/дописываю|Still finishing/u);
    expect(lectureActive()).toBe(true);
  });

  it('«закончи», когда конспекта нет, — не ошибка и не ожидание', () => {
    expect(finishLecture()).toBeNull();
  });
});

/** Сервер распознавания понарошку: отвечает текстом и уверенностью, как whisper.cpp. */
async function поддельныйСлух(): Promise<{ адрес: string; закрыть(): Promise<void> }> {
  const сервер = createServer((req, res) => {
    if (req.method === 'POST') {
      req.resume();
      req.on('end', () => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ text: ' היום נדבר על המהפכה החקלאית', segments: [{ start: 0, end: 5, avg_logprob: -0.05 }] }));
      });
      return;
    }
    res.end('ok');
  });
  await new Promise<void>((r) => сервер.listen(0, '127.0.0.1', () => r()));
  const { port } = сервер.address() as AddressInfo;
  return { адрес: `http://127.0.0.1:${port}`, закрыть: () => new Promise((r) => сервер.close(() => r())) };
}

/** Слоги и паузы — чтобы кусок не приняли за тишину. */
function речь(секунд: number): Float32Array {
  const out = new Float32Array(секунд * 16_000);
  for (let i = 0; i < out.length; i += 1) {
    const t = i / 16_000;
    out[i] = t % 1 < 0.7 ? 0.3 * Math.sin(2 * Math.PI * 220 * t) : 0;
  }
  return out;
}

describe('конспект по файлу', () => {
  it('новый файл: курс и тема от модели, папка курса; своя лекция — перерасшифровка с прежним номером', async () => {
    папка.путь = await mkdtemp(path.join(tmpdir(), 'jarvis-lecture-file-'));
    const слух = await поддельныйСлух();
    const вКорзине: string[] = [];
    const корзина = path.join(папка.путь, '.корзина');
    await mkdir(корзина);
    const options = {
      home: папка.путь,
      outputDir: папка.путь,
      lectureLanguage: 'he',
      notesLanguage: 'ru' as const,
      mainEndpoint: () => слух.адрес,
      // Настоящий потоковый читатель WAV, кусками по 10 с.
      decode: (file: string, onPart: (samples: Float32Array, rate: number) => void) => readWavParts(file, onPart, 10).then(() => undefined),
      trash: async (file: string) => {
        вКорзине.push(path.basename(file));
        await rename(file, path.join(корзина, path.basename(file)));
      },
    };
    try {
      const запись = path.join(папка.путь, 'Запись 12.m4a.wav');
      await writeFile(запись, encodeWav16(речь(40), 16_000));
      const состояния: string[] = [];
      const отписка = onLectureState((state) => состояния.push(state));
      const ответ = await lectureFromFile(запись, options);
      отписка();
      expect(ответ).toMatch(/«Аграрная революция» — История, лекция 1/u);
      expect(состояния).toContain('importing');
      expect(lectureState()).toBe('off');

      const курс = path.join(папка.путь, 'История');
      const заметки = (await readdir(курс)).filter((f) => f.endsWith(' — Аграрная революция.md'));
      expect(заметки).toHaveLength(1);
      const заметка = path.join(курс, заметки[0] as string);
      expect(parseFrontmatter(await readFile(заметка, 'utf8'))).toMatchObject({ course: 'История', number: 1, topic: 'Аграрная революция' });
      // Чужой файл не трогаем: он остаётся, где был.
      expect(existsSync(запись)).toBe(true);
      expect(вКорзине).toEqual([]);

      // Звук своей же лекции — перерасшифровать её: прежние файлы — в Корзину.
      const звук = заметка.replace(/\.md$/u, '.wav');
      expect(await lectureFromFile(звук, options)).toMatch(/лекция 1/u);
      expect(вКорзине.sort()).toEqual([path.basename(заметка), path.basename(звук), path.basename(заметка).replace(/\.md$/u, ' — расшифровка.md')].sort());
      expect((await readdir(курс)).filter((f) => f.endsWith('.md') && !f.startsWith('История'))).toHaveLength(2);
    } finally {
      await слух.закрыть();
    }
  });

  it('не звук и не видео — сразу отказ, без раскрытия', async () => {
    let раскрыто = false;
    const ответ = await lectureFromFile('C:/x/конспект.docx', {
      home: '',
      outputDir: '',
      lectureLanguage: 'he',
      notesLanguage: 'ru',
      mainEndpoint: () => null,
      decode: async () => {
        раскрыто = true;
      },
      trash: async () => undefined,
    });
    expect(ответ).toMatch(/не звук и не видео/u);
    expect(раскрыто).toBe(false);
  });
});

/** Сервер распознавания понарошку, который запоминает, на каком языке его просили слушать. */
async function слухСЯзыком(): Promise<{ адрес: string; языки: string[]; закрыть(): Promise<void> }> {
  const языки: string[] = [];
  const сервер = createServer((req, res) => {
    if (req.method !== 'POST') {
      res.end('ok');
      return;
    }
    const части: Buffer[] = [];
    req.on('data', (c: Buffer) => части.push(c));
    req.on('end', () => {
      const язык = /name="language"\r\n\r\n([a-z]+)/u.exec(Buffer.concat(части).toString('latin1'))?.[1];
      языки.push(язык ?? '—');
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ text: ' today we talk about Hamlet', segments: [{ start: 0, end: 5, avg_logprob: -0.05 }] }));
    });
  });
  await new Promise<void>((r) => сервер.listen(0, '127.0.0.1', () => r()));
  const { port } = сервер.address() as AddressInfo;
  return { адрес: `http://127.0.0.1:${port}`, языки, закрыть: () => new Promise((r) => сервер.close(() => r())) };
}

describe('язык курса', () => {
  /** Курс со своими языками на странице — как его сохраняет окно «Учёба». */
  async function курсНаАнглийском(root: string, ещё = ''): Promise<string> {
    const папкаКурса = path.join(root, 'English Literature');
    await mkdir(папкаКурса, { recursive: true });
    await writeFile(path.join(папкаКурса, 'English Literature.md'), `---\nкурс: 'English Literature'\nязык: en\nконспект: en\n${ещё}---\n\n# English Literature\n`, 'utf8');
    return папкаКурса;
  }

  it('курс назван — слушает и пишет на языке курса; не известен — на языках настроек', async () => {
    папка.путь = await mkdtemp(path.join(tmpdir(), 'jarvis-lecture-lang-'));
    const слух = await слухСЯзыком();
    // Настройки владельца: лекции на иврите, конспект по-русски.
    const options = { home: папка.путь, outputDir: папка.путь, lectureLanguage: 'he', notesLanguage: 'ru' as const, mainEndpoint: () => слух.адрес };
    try {
      const курс = await курсНаАнглийском(папка.путь);
      expect(await startLecture('English Literature', options)).toMatch(/English Literature/u);
      feedLecture(речь(6), 16_000);
      await finishLecture();
      expect(слух.языки).toEqual(['en']);
      const файлы = await readdir(курс);
      const заметка = файлы.find((f) => f.endsWith('.md') && !f.startsWith('English') && !f.includes(' — transcript'));
      expect(заметка).toBeDefined();
      const текст = await readFile(path.join(курс, заметка as string), 'utf8');
      // Конспект — на языке конспекта курса: английские заголовки и свойства.
      expect(текст).toMatch(/^## Notes$/mu);
      expect(текст).toMatch(/^course: /mu);
      expect(файлы.some((f) => f.endsWith(' — transcript.md'))).toBe(true);
      // Страница курса — одним списком, хоть и с английскими пометками.
      expect(await readFile(path.join(курс, 'English Literature.md'), 'utf8')).toContain('%% lecture list kept by Jarvis %%');

      // Курс не назван и расписания нет — иврит и русский конспект из настроек.
      слух.языки.length = 0;
      await startLecture(undefined, options);
      feedLecture(речь(6), 16_000);
      await finishLecture();
      expect(слух.языки).toEqual(['he']);
    } finally {
      await слух.закрыть();
    }
  });

  it('«Из файла…»: курс по расписанию на время записи — расшифровка на его языке', async () => {
    папка.путь = await mkdtemp(path.join(tmpdir(), 'jarvis-lecture-lang-file-'));
    const слух = await слухСЯзыком();
    const options = {
      home: папка.путь,
      outputDir: папка.путь,
      lectureLanguage: 'he',
      notesLanguage: 'ru' as const,
      mainEndpoint: () => слух.адрес,
      decode: (file: string, onPart: (samples: Float32Array, rate: number) => void) => readWavParts(file, onPart, 10).then(() => undefined),
      trash: async () => undefined,
    };
    try {
      const курс = await курсНаАнглийском(папка.путь, "расписание: 'пн 10:00-13:00'\n");
      const запись = path.join(папка.путь, 'Запись.wav');
      await writeFile(запись, encodeWav16(речь(40), 16_000));
      // Телефон кончил писать в понедельник 19.10.2026 в 11:00 — пара курса.
      const конец = new Date(2026, 9, 19, 11, 0);
      await utimes(запись, конец, конец);
      expect(await lectureFromFile(запись, options)).toMatch(/English Literature/u);
      expect(new Set(слух.языки)).toEqual(new Set(['en']));
      const заметки = (await readdir(курс)).filter((f) => f.endsWith('.md') && !f.startsWith('English') && !f.includes(' — transcript'));
      expect(заметки).toHaveLength(1);
      expect(await readFile(path.join(курс, заметки[0] as string), 'utf8')).toMatch(/^## Notes$/mu);
    } finally {
      await слух.закрыть();
    }
  });
});
