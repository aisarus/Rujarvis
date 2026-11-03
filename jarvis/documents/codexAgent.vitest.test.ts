import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { writeCourseInfo } from '../lecture/courses';
import { codexDocumentArgs, codexDocumentPrompt, createCodexDocumentAgent, gatherInputs, parseFileBlocks, type PdfReader } from './codexAgent';
import { processDocument } from './pipeline';

const папки: string[] = [];
afterEach(() => {
  for (const папка of папки.splice(0)) rmSync(папка, { recursive: true, force: true });
});

function временная(): string {
  const папка = mkdtempSync(path.join(tmpdir(), 'jarvis-codex-doc-test-'));
  папки.push(папка);
  return папка;
}

describe('ответ Codex — файлами', () => {
  it('блоки внутри out/ — файлы, всё прочее — мимо', () => {
    const ответ = [
      'Вот заметки:',
      '===FILE out/Путеводитель.md===',
      '# Путь',
      '',
      'текст',
      '===END===',
      '===FILE out/graphs/спрос.mmd===',
      'graph LR',
      '===END===',
      '===FILE out/../../.ssh/authorized_keys===',
      'ключ',
      '===END===',
      '===FILE /etc/passwd===',
      'x',
      '===END===',
      '===FILE out/manifest.json===',
      '{"kind":"assignment"}',
      '===END===',
    ].join('\n');
    expect(parseFileBlocks(ответ)).toEqual([
      { path: 'out/Путеводитель.md', content: '# Путь\n\nтекст' },
      { path: 'out/graphs/спрос.mmd', content: 'graph LR' },
      { path: 'out/manifest.json', content: '{"kind":"assignment"}' },
    ]);
  });

  it('ответ с переводами строк Windows разбирается так же', () => {
    expect(parseFileBlocks('===FILE out/a.md===\r\n# A\r\n===END===')).toEqual([{ path: 'out/a.md', content: '# A' }]);
  });
});

describe('что лежит в in/', () => {
  it('текст — текстом, картинки — картинками, PDF — страницами и сканами', async () => {
    const работа = временная();
    const вход = path.join(работа, 'in');
    mkdirSync(вход);
    writeFileSync(path.join(вход, 'מטלה.docx'), 'zip');
    writeFileSync(path.join(вход, 'מטלה.txt'), 'הגשה עד 25.10');
    writeFileSync(path.join(вход, 'доска.jpg'), 'jpg');
    writeFileSync(path.join(вход, 'статья.pdf'), 'pdf');
    const pdf: PdfReader = async (_файл, папка) => ({ pages: ['Глава 1', ''], images: [path.join(папка, 'page-002.png')] });
    const входы = await gatherInputs(вход, работа, pdf);
    // По имени: кириллица раньше иврита.
    expect(входы.texts.map((т) => т.name)).toEqual(['статья.pdf', 'מטלה.txt']);
    expect(входы.texts[0]?.text).toContain('[Страница 1]\nГлава 1');
    expect(входы.texts[0]?.text).toContain('[Страница 2]\n(текста нет');
    expect(входы.images).toEqual([path.join(вход, 'доска.jpg'), path.join(работа, 'pages', 'page-002.png')]);

    const промпт = codexDocumentPrompt('ДОКУМЕНТ: in/статья.pdf', входы);
    expect(промпт).toContain('===FILE out/имя-файла.md===');
    expect(промпт).toContain('ДОКУМЕНТ: in/статья.pdf');
    expect(промпт).toContain('----- in/מטלה.txt -----\nהגשה עד 25.10');
    expect(промпт).toContain('приложены изображениями (2)');
  });

  it('Codex — только чтение, без истории, картинки — ключом -i', () => {
    const args = codexDocumentArgs('/tmp/answer.md', ['/tmp/a.png']);
    expect(args).toEqual(expect.arrayContaining(['--sandbox', 'read-only', '--ephemeral', '-o', '/tmp/answer.md', '-i', '/tmp/a.png']));
    expect(args.at(-1)).toBe('-');
  });
});

describe('документ целиком через подставной Codex', () => {
  it('заметки из ответа легли в out/ и разложены по курсу', async () => {
    const root = временная();
    writeCourseInfo(root, 'Коммерческое право', { hebrew: 'דיני עסקים' });
    const документ = path.join(временная(), 'задание.txt');
    writeFileSync(документ, 'Сдать до 25.10');
    // Подставной Codex: читает промпт из stdin и отвечает блоками в файл -o.
    const скрипт = [
      "let t='';process.stdin.setEncoding('utf8');process.stdin.on('data',d=>t+=d);process.stdin.on('end',()=>{",
      "if(!t.includes('Сдать до 25.10'))process.exit(3);",
      "const m=JSON.stringify({kind:'assignment',course:'Коммерческое право',title:'Задание',main:'Путеводитель.md',notes:['Путеводитель.md'],summary:'Разобрал'});",
      "require('fs').writeFileSync(process.argv[1],'===FILE out/Путеводитель.md===\\n# Путь\\n===END===\\n===FILE out/manifest.json===\\n'+m+'\\n===END===');",
      '})',
    ].join('');
    const итог = await processDocument({
      file: документ,
      root,
      notes: 'ru',
      now: new Date(2026, 9, 20),
      agent: createCodexDocumentAgent({ command: process.execPath, args: (файл) => ['-e', скрипт, файл], env: process.env }),
    });
    expect(итог.filed.course).toBe('Коммерческое право');
    expect(existsSync(итог.filed.main)).toBe(true);
    expect(readFileSync(итог.filed.main, 'utf8')).toContain('# Путь');
  });

  it('Codex отказал — ошибка с причиной, а не пустой разбор', async () => {
    const root = временная();
    const документ = path.join(временная(), 'a.txt');
    writeFileSync(документ, 'x');
    await expect(
      processDocument({
        file: документ,
        root,
        notes: 'ru',
        agent: createCodexDocumentAgent({
          command: process.execPath,
          args: () => ['-e', "process.stdout.write('{\"type\":\"turn.failed\",\"error\":{\"message\":\"usage limit reached\"}}\\n');process.exit(1)"],
          env: process.env,
        }),
      }),
    ).rejects.toThrow(/usage limit reached/u);
  });
});
