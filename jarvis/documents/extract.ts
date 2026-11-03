/**
 * Текст из Word и PowerPoint — без сторонних библиотек.
 *
 * PDF и картинки модель читает сама (Claude Code открывает их своим
 * инструментом чтения), а `.docx` и `.pptx` — нет: это zip с XML внутри.
 * Тащить ради двух форматов парсер с зависимостями незачем: zip читается
 * по центральному каталогу, сжатие — deflate из `node:zlib`, а текст в XML
 * Word лежит в `<w:t>`, у PowerPoint — в `<a:t>`.
 *
 * Модуль не знает про Электрон.
 */

import { inflateRawSync } from 'node:zlib';

/** Файлы архива: имя → содержимое. Читаются только те, что пропускает `нужен`. */
export function readZip(buffer: Buffer, нужен: (name: string) => boolean = () => true): Map<string, Buffer> {
  const файлы = new Map<string, Buffer>();
  // Конец центрального каталога — сигнатура 0x06054b50 в последних 64 КБ.
  let конец = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65_557); i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      конец = i;
      break;
    }
  }
  if (конец < 0) throw new Error('это не zip-архив');
  const записей = buffer.readUInt16LE(конец + 10);
  let p = buffer.readUInt32LE(конец + 16);
  for (let n = 0; n < записей; n += 1) {
    if (buffer.readUInt32LE(p) !== 0x02014b50) throw new Error('испорченный каталог архива');
    const метод = buffer.readUInt16LE(p + 10);
    const сжато = buffer.readUInt32LE(p + 20);
    const длинаИмени = buffer.readUInt16LE(p + 28);
    const длинаДоп = buffer.readUInt16LE(p + 30);
    const длинаКоммент = buffer.readUInt16LE(p + 32);
    const смещение = buffer.readUInt32LE(p + 42);
    const имя = buffer.toString('utf8', p + 46, p + 46 + длинаИмени);
    p += 46 + длинаИмени + длинаДоп + длинаКоммент;
    if (!нужен(имя)) continue;
    // Локальный заголовок: свои длины имени и доп. поля.
    const начало = смещение + 30 + buffer.readUInt16LE(смещение + 26) + buffer.readUInt16LE(смещение + 28);
    const данные = buffer.subarray(начало, начало + сжато);
    if (метод === 0) файлы.set(имя, Buffer.from(данные));
    else if (метод === 8) файлы.set(имя, inflateRawSync(данные));
    // Прочие методы в документах Office не встречаются — пропускаем.
  }
  return файлы;
}

const СУЩНОСТИ: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function раскрыть(текст: string): string {
  return текст.replace(/&(#x[0-9a-f]+|#\d+|\w+);/giu, (всё, код: string) => {
    if (код.startsWith('#x') || код.startsWith('#X')) return String.fromCodePoint(Number.parseInt(код.slice(2), 16));
    if (код.startsWith('#')) return String.fromCodePoint(Number(код.slice(1)));
    return СУЩНОСТИ[код] ?? всё;
  });
}

/** Текст абзаца: все `<w:t>`/`<a:t>`, табуляции и переносы внутри абзаца. */
function текстАбзаца(xml: string, префикс: 'w' | 'a'): string {
  const куски: string[] = [];
  const re = new RegExp(`<${префикс}:t(?:\\s[^>]*)?>([^<]*)</${префикс}:t>|<${префикс}:(tab|br)\\b[^>]*/>`, 'gu');
  for (const m of xml.matchAll(re)) {
    if (m[1] !== undefined) куски.push(раскрыть(m[1]));
    else куски.push(m[2] === 'tab' ? '\t' : '\n');
  }
  return куски.join('');
}

/**
 * Текст документа Word: абзацы по строкам, таблицы — строками через « | ».
 * Нумерация списков и стили теряются — модели нужен смысл, а не вёрстка.
 */
export function docxText(buffer: Buffer): string {
  const xml = readZip(buffer, (имя) => имя === 'word/document.xml').get('word/document.xml')?.toString('utf8');
  if (!xml) throw new Error('в файле Word нет основного текста (word/document.xml)');
  const тело = xml.replace(/<w:tbl\b[\s\S]*?<\/w:tbl>/gu, (таблица) =>
    [...таблица.matchAll(/<w:tr\b[\s\S]*?<\/w:tr>/gu)]
      .map((строка) =>
        [...строка[0].matchAll(/<w:tc\b[\s\S]*?<\/w:tc>/gu)]
          .map((ячейка) => [...ячейка[0].matchAll(/<w:p\b[\s\S]*?<\/w:p>/gu)].map((p) => текстАбзаца(p[0], 'w')).join(' ').trim())
          .join(' | '),
      )
      .map((строка) => `<w:p><w:t>${строка.replace(/[<&]/gu, (c) => (c === '<' ? '&lt;' : '&amp;'))}</w:t></w:p>`)
      .join(''),
  );
  return [...тело.matchAll(/<w:p\b[\s\S]*?<\/w:p>/gu)]
    .map((p) => текстАбзаца(p[0], 'w').trimEnd())
    .join('\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
}

/** Текст презентации: слайды по порядку, у каждого заголовок «Слайд N». */
export function pptxText(buffer: Buffer, слайд = 'Слайд'): string {
  const файлы = readZip(buffer, (имя) => /^ppt\/(slides\/slide\d+|notesSlides\/notesSlide\d+)\.xml$/u.test(имя));
  const номер = (имя: string) => Number(/(\d+)\.xml$/u.exec(имя)?.[1] ?? 0);
  const слайды = [...файлы.keys()].filter((и) => и.startsWith('ppt/slides/')).sort((a, b) => номер(a) - номер(b));
  if (слайды.length === 0) throw new Error('в презентации нет слайдов');
  return слайды
    .map((имя) => {
      const абзацы = (xml: string) =>
        [...xml.matchAll(/<a:p\b[\s\S]*?<\/a:p>/gu)].map((p) => текстАбзаца(p[0], 'a').trim()).filter(Boolean);
      const текст = абзацы(файлы.get(имя)?.toString('utf8') ?? '');
      const заметки = файлы.get(`ppt/notesSlides/notesSlide${номер(имя)}.xml`)?.toString('utf8');
      // В заметках к слайду PowerPoint повторяет номер слайда — его отбрасываем.
      const свои = заметки ? абзацы(заметки).filter((с) => !/^\d+$/u.test(с)) : [];
      return [`## ${слайд} ${номер(имя)}`, ...текст, ...(свои.length ? ['', '> ' + свои.join('\n> ')] : [])].join('\n');
    })
    .join('\n\n');
}
