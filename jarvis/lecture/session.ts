/**
 * Конспект лекции на ходу: звук → расшифровка → разделы конспекта → итог.
 *
 * Решение владельца 29.09.2026: лекции на иврите в аудитории, конспект — на
 * русском с терминами на иврите в скобках, рядом дословная расшифровка, звук
 * сохраняется рядом. Конспект пишется в Obsidian и виден, пока идёт лекция.
 *
 * ## Две очереди
 *
 * Расшифровка кусок за куском дописывается сразу: это то, что человек видит
 * живым. Разделы конспекта делает модель, и каждый — десятки секунд: в одной
 * очереди с расшифровкой они задерживали бы её на всё это время. Поэтому у
 * разделов своя очередь, а расшифровка их не ждёт.
 *
 * ## Что здесь не делается
 *
 * Звук не распознаётся и модель не зовётся — это приходит снаружи
 * (`transcribe`, `summarize`): мост подставляет сервер whisper.cpp с моделью
 * для иврита и Claude Code по подписке, проверки — подделки.
 */

import { appendFile, mkdir, open, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { lectureFileBase } from './vault';

export interface LectureDeps {
  transcribe(samples: Float32Array, sampleRate: number): Promise<string>;
  summarize(prompt: string): Promise<string>;
  now?(): number;
  /** Не чаще, чем раз в столько, — раздел конспекта. */
  sectionEveryMs?: number;
  /** И не меньше стольких новых слов расшифровки. */
  sectionMinWords?: number;
  log?(line: string): void;
}

export interface LectureResult {
  notesFile: string;
  transcriptFile: string;
  audioFile: string;
  words: number;
  sections: number;
}

const ПРОПУСК = 'ПРОПУСК';
const ЗАГОЛОВОК_КОНСПЕКТА = '## Конспект';

function слова(текст: string): number {
  return текст.split(/\s+/u).filter(Boolean).length;
}

function метка(мс: number): string {
  const всего = Math.max(0, Math.floor(мс / 1000));
  const часы = Math.floor(всего / 3600);
  const минуты = Math.floor((всего % 3600) / 60);
  const секунды = всего % 60;
  const мм = `${String(минуты).padStart(2, '0')}:${String(секунды).padStart(2, '0')}`;
  return часы > 0 ? `${часы}:${мм}` : мм;
}

export function sectionPrompt(кусок: string, subject: string, заголовки: readonly string[]): string {
  return [
    'Ты конспектируешь лекцию на иврите для студента, который читает по-русски.',
    `Предмет: ${subject || 'не назван'}.`,
    'Ниже — новый кусок дословной расшифровки. Распознавание автоматическое, в нём бывают ошибки: восстанавливай смысл, а не буквы.',
    '',
    'Сделай ОДИН раздел конспекта на русском:',
    '- первая строка — заголовок вида «### Тема куска»;',
    '- дальше 3–8 пунктов «- …» с главным: определения, формулы, примеры, что лектор подчеркнул;',
    '- термины — по-русски и в скобках на иврите, как их сказал лектор: «производная (נגזרת)»;',
    '- без вступлений, без пересказа прошлых разделов, без выдуманного;',
    '- кусок режется по времени и может начинаться и кончаться на полуслове: оборванное по краям просто опусти, не помечай.',
    `Если в куске нет содержания лекции (организационное, шум, разговоры) — ответь одним словом: ${ПРОПУСК}`,
    '',
    `Уже написанные разделы: ${заголовки.length > 0 ? заголовки.join('; ') : 'ещё нет'}.`,
    '',
    'Расшифровка:',
    кусок,
  ].join('\n');
}

export function finalPrompt(расшифровка: string, subject: string): string {
  return [
    'Ниже — вся расшифровка лекции на иврите (распознавание автоматическое, с ошибками).',
    `Предмет: ${subject || 'не назван'}.`,
    'Напиши на русском три части в markdown, без вступлений и без выдуманного:',
    '## Кратко — 3–6 предложений: о чём лекция и главный вывод.',
    '## Понятия — 5–15 строк вида «- термин по-русски (על עברית) — одна строка объяснения».',
    '## Вопросы к экзамену — 3–7 вопросов по материалу лекции.',
    '',
    'Расшифровка:',
    расшифровка,
  ].join('\n');
}

/** Ответ модели → раздел: заголовок обязателен, «ПРОПУСК» — ничего. */
export function sectionFromReply(ответ: string, номер: number): string | null {
  const текст = ответ.trim();
  if (!текст || текст.toUpperCase().startsWith(ПРОПУСК)) return null;
  return текст.startsWith('### ') ? текст : `### Раздел ${номер}\n${текст}`;
}

export class LectureSession {
  readonly notesFile: string;
  readonly transcriptFile: string;
  readonly audioFile: string;

  private readonly начало: number;
  private readonly now: () => number;
  private расшифровка: Promise<void> = Promise.resolve();
  private разделы: Promise<void> = Promise.resolve();
  private копится: string[] = [];
  private readonly вся: string[] = [];
  private readonly заголовки: string[] = [];
  private последнийРаздел: number;
  private номерРаздела = 0;
  private байтЗвука = 0;
  private частотаЗвука = 16_000;
  private закончена = false;

  constructor(
    private readonly folder: string,
    private readonly subject: string,
    private readonly deps: LectureDeps,
    when: Date = new Date(),
  ) {
    const base = lectureFileBase(subject, when);
    this.notesFile = path.join(folder, `${base}.md`);
    this.transcriptFile = path.join(folder, `${base} — расшифровка.md`);
    this.audioFile = path.join(folder, `${base}.wav`);
    this.now = deps.now ?? Date.now;
    this.начало = this.now();
    this.последнийРаздел = this.начало;
  }

  async start(): Promise<void> {
    await mkdir(this.folder, { recursive: true });
    const base = path.basename(this.notesFile, '.md');
    const предмет = this.subject || 'Лекция';
    await writeFile(
      this.notesFile,
      [
        `# ${предмет}`,
        '',
        `Расшифровка: [[${base} — расшифровка]] · звук: ${path.basename(this.audioFile)}`,
        '',
        ЗАГОЛОВОК_КОНСПЕКТА,
        '',
        '',
      ].join('\n'),
      'utf8',
    );
    await writeFile(this.transcriptFile, `# Расшифровка — ${предмет}\n\nКонспект: [[${base}]]\n\n`, 'utf8');
    await writeFile(this.audioFile, wavHeader(0, this.частотаЗвука));
  }

  /**
   * Кусок звука лекции: в запись, в расшифровку, и — когда накопилось — в раздел.
   *
   * Кусок приходит, когда кончился, а метка — на его начало: иначе у
   * 28-секундного куска она на полминуты позже сказанного.
   */
  addAudio(samples: Float32Array, sampleRate: number): void {
    if (this.закончена) return;
    const когда = this.now() - this.начало - (samples.length / sampleRate) * 1000;
    this.расшифровка = this.расшифровка.then(async () => {
      if (this.байтЗвука === 0) this.частотаЗвука = sampleRate;
      const pcm = pcm16(samples);
      await appendFile(this.audioFile, pcm);
      this.байтЗвука += pcm.length;

      let текст = '';
      try {
        текст = (await this.deps.transcribe(samples, sampleRate)).trim();
      } catch (error) {
        this.deps.log?.(`кусок не распознан: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
      if (!текст) return;
      await appendFile(this.transcriptFile, `**[${метка(когда)}]** ${текст}\n\n`, 'utf8');
      this.копится.push(текст);
      this.вся.push(текст);
      this.deps.log?.(`кусок ${метка(когда)}: ${слова(текст)} слов`);
      this.maybeSection(false);
    });
  }

  /** Раздел, когда накопилось достаточно и прошло достаточно; `всё` — при завершении. */
  private maybeSection(всё: boolean): void {
    const накоплено = this.копится.join(' ');
    if (!накоплено.trim()) return;
    const порогСлов = this.deps.sectionMinWords ?? 120;
    const порогВремени = this.deps.sectionEveryMs ?? 5 * 60_000;
    if (!всё && (слова(накоплено) < порогСлов || this.now() - this.последнийРаздел < порогВремени)) return;

    this.копится = [];
    this.последнийРаздел = this.now();
    const номер = ++this.номерРаздела;
    const заголовки = [...this.заголовки];
    this.разделы = this.разделы.then(async () => {
      let раздел: string | null;
      try {
        раздел = sectionFromReply(await this.deps.summarize(sectionPrompt(накоплено, this.subject, заголовки)), номер);
      } catch (error) {
        const причина = error instanceof Error ? error.message : String(error);
        this.deps.log?.(`раздел ${номер} не собрался: ${причина}`);
        раздел = `### Раздел ${номер}\n> Раздел не собрался (${причина.slice(0, 120)}). Текст — в расшифровке.`;
      }
      if (!раздел) return;
      this.заголовки.push(раздел.split('\n')[0]?.replace(/^###\s*/u, '') ?? `Раздел ${номер}`);
      await appendFile(this.notesFile, `${раздел}\n\n`, 'utf8');
    });
  }

  /** Дописать последний раздел, итог — над разделами, и закрыть запись звука. */
  async finish(): Promise<LectureResult> {
    this.закончена = true;
    await this.расшифровка;
    this.maybeSection(true);
    await this.разделы;

    const расшифровка = this.вся.join('\n');
    if (расшифровка.trim()) {
      try {
        const итог = (await this.deps.summarize(finalPrompt(расшифровка, this.subject))).trim();
        if (итог) {
          const заметка = await readFile(this.notesFile, 'utf8');
          const место = заметка.indexOf(ЗАГОЛОВОК_КОНСПЕКТА);
          const новая = место >= 0 ? `${заметка.slice(0, место)}${итог}\n\n${заметка.slice(место)}` : `${заметка}\n${итог}\n`;
          await writeFile(this.notesFile, новая, 'utf8');
        }
      } catch (error) {
        this.deps.log?.(`итог не собрался: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    const файл = await open(this.audioFile, 'r+');
    try {
      await файл.write(wavHeader(this.байтЗвука, this.частотаЗвука), 0, 44, 0);
    } finally {
      await файл.close();
    }
    return {
      notesFile: this.notesFile,
      transcriptFile: this.transcriptFile,
      audioFile: this.audioFile,
      words: слова(расшифровка),
      sections: this.заголовки.length,
    };
  }
}

function pcm16(samples: Float32Array): Buffer {
  const buffer = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i += 1) {
    const s = Math.max(-1, Math.min(1, samples[i] ?? 0));
    buffer.writeInt16LE(Math.round(s * 0x7fff), i * 2);
  }
  return buffer;
}

/** Заголовок WAV: 16 бит, моно. Размеры дописываются в конце лекции. */
function wavHeader(dataBytes: number, rate: number): Buffer {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'ascii');
  h.writeUInt32LE(36 + dataBytes, 4);
  h.write('WAVE', 8, 'ascii');
  h.write('fmt ', 12, 'ascii');
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36, 'ascii');
  h.writeUInt32LE(dataBytes, 40);
  return h;
}
