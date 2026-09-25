// Отдать CodeRabbit ВСЮ кодовую базу, а не только последний diff.
//
//   node scripts/coderabbit-full-review.mjs
//
// Главная грабля: GitHub считает diff НЕ от кончика базовой ветки, а от
// ОБЩЕГО ПРЕДКА. Поэтому веток на кусок две — основание без файлов куска и
// голова, которая их возвращает, растущая из основания. Тогда общий предок
// совпадает с основанием, и diff равен ровно куску. Первая версия делала одну
// ветку, и в каждом куске оказалось по четыре файла вместо девяноста.
//
// Зачем это вообще нужно. Бот смотрит только diff и берёт не больше ста
// файлов за раз: цельный PR на весь проект он отверг прямо — «Review skipped:
// 2060 files exceed the limit of 100». Поэтому база режется на куски, и для
// каждого делается своё основание — `main` без файлов этого куска. Тогда diff
// равен ровно куску.
//
// Три грабли, на которых это строилось, — чтобы не наступать заново:
//
//   1. PR между ветками без общей истории GitHub не открывает вовсе:
//      «no history in common».
//   2. Если основание сделать потомком головы main, GitHub отвечает
//      «No commits between …»: main оказывается предком, сравнивать нечего.
//      Поэтому родитель основания — ПРЕДЫДУЩИЙ коммит main.
//   3. Автоматический разбор идёт только для PR в ветку по умолчанию, а на
//      бесплатном плане — только для репозиториев от десяти звёзд. И то и
//      другое обходится одним комментарием `@coderabbitai review`, который
//      скрипт и пишет.
//
// Всё делается через API: рабочее дерево не трогается, `git clean` не
// запускается (он снёс бы не отслеживаемые папки).
//
// PR помечены «НЕ СЛИВАТЬ» и закрываются после разбора. Забрать замечания:
// `bash scripts/coderabbit.sh <номер>`.

import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const РЕПО = 'aisarus/Rujarvis';
const ПРЕДЕЛ = 90; // с запасом к сотне
const ждать = (мс) => new Promise((r) => setTimeout(r, мс));

async function api(путь, метод = 'GET', тело = null) {
  const аргументы = ['api', `repos/${РЕПО}/${путь}`];
  if (метод !== 'GET') {
    const файл = path.join(mkdtempSync(path.join(tmpdir(), 'gh-body-')), 'body.json');
    writeFileSync(файл, JSON.stringify(тело ?? {}), 'utf8');
    аргументы.push('--method', метод, '--input', файл);
  }
  const { stdout } = await run('gh', аргументы, { maxBuffer: 1 << 26 });
  return stdout.trim() ? JSON.parse(stdout) : null;
}

// Что не смотрим: чужой код, сборки, двоичное и замки версий.
const МИМО = [
  /^submodules\//u,
  /^dist(-electron)?\//u,
  /^node_modules\//u,
  /^resources\//u,
  /^apps\//u,
  /\.(png|ico|icns|jpg|jpeg|gif|webp|wav|mp3|zip|blend|blend1|onnx)$/iu,
  /pnpm-lock\.yaml$/u,
];

const главная = await api('git/ref/heads/main');
const головаSha = главная.object.sha;
const коммитГлавной = await api(`git/commits/${головаSha}`);
const деревоGlavnoy = коммитГлавной.tree.sha;

const дерево = await api(`git/trees/${деревоGlavnoy}?recursive=1`);
if (дерево.truncated) console.log('ВНИМАНИЕ: дерево обрезано, часть файлов не попадёт');

const файлы = дерево.tree
  .filter((узел) => узел.type === 'blob')
  .map((узел) => узел.path)
  .filter((путь) => !МИМО.some((правило) => правило.test(путь)))
  .sort();

console.log(`к разбору: ${файлы.length} файлов, головa main ${головаSha.slice(0, 8)}`);

const куски = [];
for (let i = 0; i < файлы.length; i += ПРЕДЕЛ) куски.push(файлы.slice(i, i + ПРЕДЕЛ));
console.log(`кусков: ${куски.length}`);

const ссылки = [];
for (const [номер, кусок] of куски.entries()) {
  const имя = `coderabbit/slice-${номер + 1}`;
  const общее = кусок[0].split('/')[0];
  const последний = кусок[кусок.length - 1].split('/')[0];
  const подпись = общее === последний ? общее : `${общее} … ${последний}`;

  // Дерево main БЕЗ файлов этого куска: sha: null удаляет запись.
  const дерево2 = await api('git/trees', 'POST', {
    base_tree: деревоGlavnoy,
    tree: кусок.map((путь) => ({ path: путь, mode: '100644', type: 'blob', sha: null })),
  });

  const основание = await api('git/commits', 'POST', {
    message: `Основание куска ${номер + 1}: ${подпись} — без этих файлов\n\nВетка не для слияния.`,
    tree: дерево2.sha,
    parents: [головаSha],
  });

  // Голова растёт ИЗ основания и возвращает файлы куска обратно.
  //
  // Только так общий предок совпадает с основанием, и diff равен ровно
  // куску. Первая версия делала одну ветку с удалёнными файлами и брала
  // головой сам main — и diff считался от общего предка где-то позади, а
  // удаления в него не попадали вовсе. В каждом куске оказалось по четыре
  // файла вместо девяноста.
  //
  // Заодно голова заморожена: то, что вливают в main позже, в разбор уже не
  // подмешается.
  const голова = await api('git/commits', 'POST', {
    message: `Кусок ${номер + 1} на разбор: ${подпись}\n\nВетка не для слияния.`,
    tree: деревоGlavnoy,
    parents: [основание.sha],
  });

  const имяГоловы = `${имя}-head`;
  for (const [ссылка, sha] of [[имя, основание.sha], [имяГоловы, голова.sha]]) {
    try {
      await api('git/refs', 'POST', { ref: `refs/heads/${ссылка}`, sha });
    } catch {
      await api(`git/refs/heads/${ссылка}`, 'PATCH', { sha, force: true });
    }
  }

  const заголовок = `НЕ СЛИВАТЬ: разбор ${номер + 1}/${куски.length} — ${подпись}`;
  const тело = [
    `Кусок ${номер + 1} из ${куски.length}: **${кусок.length} файлов**.`,
    '',
    'PR не для слияния. У CodeRabbit предел в сто файлов на разбор, поэтому кодовая база нарезана: основание — это `main` без файлов этого куска, значит diff равен ровно ему.',
    '',
    'Правила проекта — в `.coderabbit.yaml`, взяты из `AGENTS.md`. Самое дорогое: код, который отчитывается успехом, не проверив результата; три ответа проверок (`!gate.passed` ошибочно, `!null` даёт истину); комментарии объясняют зачем, а не что.',
    '',
    '🤖 Generated with [Claude Code](https://claude.com/claude-code)',
  ].join('\n');

  const файлТела = path.join(mkdtempSync(path.join(tmpdir(), 'pr-body-')), 'body.md');
  writeFileSync(файлТела, тело, 'utf8');

  const { stdout } = await run('gh', [
    'pr', 'create',
    '--base', имя,
    '--head', имяГоловы,
    '--title', заголовок,
    '--body-file', файлТела,
  ], { maxBuffer: 1 << 22 });

  const ссылка = stdout.trim().split('\n').pop();
  const номерPR = ссылка.split('/').pop();
  ссылки.push({ номер: номерPR, подпись, файлов: кусок.length, ссылка });
  console.log(`кусок ${номер + 1}: ${кусок.length} файлов (${подпись}) → PR №${номерPR}`);

  await run('gh', ['pr', 'comment', номерPR, '--body', '@coderabbitai review']);
  await ждать(2000);
}

console.log('\nзапрошен разбор:');
for (const с of ссылки) console.log(`  PR №${с.номер}: ${с.файлов} файлов — ${с.подпись}`);
