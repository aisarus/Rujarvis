/**
 * PDF для Codex на маке: `pnpm jarvis:pdfkit-check`.
 *
 * Codex сам PDF не читает, и на маке текст и страницы-сканы достаёт PDFKit
 * через `osascript -l JavaScript` (`jarvis/documents/codexAgent.ts`). Сценарий
 * JXA не проверить ни тестом, ни на Windows — только на настоящей macOS.
 * Проверка собирает PDF на две страницы — с текстом и без — и смотрит, что
 * текст пришёл со своей страницы, а страница без текста стала картинкой PNG.
 *
 * Отвечает: прошло / не прошло / нечем мерить (не мак). Окон не открывает.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { gatherInputs, readPdfMac } from '../../jarvis/documents/codexAgent';

const ПРИМЕТА = 'Lecture notes check 42';

/** PDF на две страницы руками: текст Helvetica на первой, синий прямоугольник без текста — на второй. */
function маленькийPdf(): Buffer {
  const поток1 = `BT /F1 24 Tf 72 720 Td (${ПРИМЕТА}) Tj ET`;
  const поток2 = '0 0 1 rg 100 300 400 300 re f';
  const объекты = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 6 0 R >> >> >>',
    `<< /Length ${поток1.length} >>\nstream\n${поток1}\nendstream`,
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 7 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${поток2.length} >>\nstream\n${поток2}\nendstream`,
  ];
  let pdf = '%PDF-1.4\n';
  const смещения: number[] = [];
  объекты.forEach((объект, i) => {
    смещения.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += `${i + 1} 0 obj\n${объект}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${объекты.length + 1}\n0000000000 65535 f \n${смещения.map((с) => `${String(с).padStart(10, '0')} 00000 n \n`).join('')}`;
  pdf += `trailer\n<< /Size ${объекты.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

async function main(): Promise<number> {
  if (process.platform !== 'darwin') {
    console.log('НЕЧЕМ МЕРИТЬ: PDFKit есть только на маке');
    return 2;
  }
  const работа = mkdtempSync(path.join(os.tmpdir(), 'jarvis-pdfkit-'));
  try {
    const вход = path.join(работа, 'in');
    mkdirSync(вход);
    const файл = path.join(вход, 'проверка.pdf');
    writeFileSync(файл, маленькийPdf());
    const провалы: string[] = [];

    const pdf = await readPdfMac(файл, path.join(работа, 'pages'));
    console.log(`  страниц: ${pdf.pages.length}; текст первой: «${(pdf.pages[0] ?? '').trim()}»; картинок: ${pdf.images.length}`);
    if (pdf.pages.length !== 2) провалы.push(`страниц ${pdf.pages.length}, а не 2`);
    if (!(pdf.pages[0] ?? '').includes(ПРИМЕТА)) провалы.push('текст первой страницы не достался');
    if ((pdf.pages[1] ?? '').trim()) провалы.push('у страницы без текста нашёлся текст');
    const картинка = pdf.images[0];
    if (pdf.images.length !== 1 || !картинка || !existsSync(картинка)) {
      провалы.push(`страница без текста не стала картинкой: ${JSON.stringify(pdf.images)}`);
    } else {
      const байты = readFileSync(картинка);
      const png = байты.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
      console.log(`  картинка: ${path.basename(картинка)}, ${байты.length} байт, ${png ? 'PNG' : 'не PNG'}`);
      if (!png || байты.length < 1000) провалы.push('картинка страницы — не PNG или пустая');
    }

    // Так же, как это увидит Codex: текст файла в промпте, страница — картинкой.
    const входы = await gatherInputs(вход, работа);
    if (!входы.texts[0]?.text.includes(ПРИМЕТА) || входы.images.length !== 1) провалы.push('gatherInputs собрал не то');

    console.log(провалы.length === 0 ? 'ПРОШЛО' : `НЕ ПРОШЛО: ${провалы.join('; ')}`);
    return провалы.length === 0 ? 0 : 1;
  } finally {
    rmSync(работа, { recursive: true, force: true });
  }
}

main().then(
  (код) => {
    process.exitCode = код;
  },
  (беда: unknown) => {
    console.log(`НЕ ПРОШЛО: ${беда instanceof Error ? беда.message : String(беда)}`);
    process.exitCode = 1;
  },
);
