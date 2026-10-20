/**
 * Как Джарвис оформляет заметки в Obsidian.
 *
 * Одно место для всех, кто кладёт текст в хранилище: конспект лекции сейчас,
 * конвейер документов (перевод, разбор, маршрут по заданию) потом. Правила —
 * строками для промпта модели плюс уборка её ответа, чтобы Obsidian показал
 * заметку без «Syntax error» и без перевёрнутого иврита.
 *
 * Только то, что Obsidian умеет сам, без плагинов: выноски (callout), в том
 * числе сворачиваемые, таблицы, формулы, Mermaid, задачи-галочки, ссылки.
 * Владелец видел три вида конспекта и попросил все — переключаемыми
 * (20.10.2026): «Разбор», «Сначала проверь себя», «Язык лекции рядом».
 */

export type NotesStyle = 'razbor' | 'questions' | 'bilingual';
export const NOTES_STYLES: readonly NotesStyle[] = ['razbor', 'questions', 'bilingual'];

type Lang = 'ru' | 'en';

/**
 * Заголовок выноски итога. По нему же узнаётся, что итог уже написан:
 * `finishFromTranscript` не должен дописывать его второй раз.
 */
export const SUMMARY_TITLE: Record<Lang, string> = { ru: 'Кратко', en: 'Summary' };

/** Есть ли в заметке итог — выноской или прежним заголовком «## Кратко». */
export function hasSummary(text: string): boolean {
  return /^(?:## |> \[!abstract\][+-]?[ \t]*)(?:Кратко|Summary)[ \t]*$/mu.test(text);
}

/**
 * Итог — с выноски «Кратко»: слова модели перед ней («вот конспект:») в
 * заметку не идут. Нет выноски — текст как есть.
 */
export function fromSummary(text: string): string {
  const место = text.search(/^> \[!abstract\]/mu);
  return место > 0 ? text.slice(место) : text;
}

/**
 * Языки для правил: язык конспекта и название языка лекции на языке
 * конспекта («иврите» / «Hebrew»); `foreign` — null, если лекция на том же
 * языке, что и конспект.
 */
export interface NoteLanguages {
  notes: Lang;
  foreign: string | null;
}

/** Общие правила разметки — для любой заметки Джарвиса в Obsidian. */
export function obsidianRules({ notes, foreign }: NoteLanguages): string[] {
  if (notes === 'en') {
    return [
      'Obsidian markdown only: headings, lists, tables, callouts, $…$ formulas, Mermaid. No HTML, no plugins.',
      'A callout starts with "> [!type] Title"; every following line of it also starts with "> ". Leave an empty line between callouts. "> [!type]- Title" is folded: use it to hide answers.',
      'Callout types: abstract — the short summary; question — a question with the answer inside, folded; tip — how to remember or not get it wrong; quote — the lecturer\'s words; example — a problem solved step by step; warning — course logistics (deadlines, exam); failure — a common mistake; info — how the exam will ask it.',
      ...(foreign
        ? [
            `Text in ${foreign} goes on its own line; the translation is the next paragraph of the same callout (a line with only ">" between them), in italics.`,
            `No ${foreign} words in "###" headings and never next to numbers or times on one line: mixed directions get scrambled.`,
          ]
        : []),
      'Formulas: $…$ inline, $$…$$ on their own line.',
      'A table when there are calculation steps or a comparison; no more than 6 columns.',
      'Mermaid only when it truly helps, and only these kinds, exactly in this shape:',
      '```mermaid\nxychart-beta\n  title "Title"\n  x-axis "X axis" [0, 50, 100]\n  y-axis "Y axis" 0 --> 260\n  line [250, 200, 150]\n```',
      '  — only for concrete numbers from the lecture; as many values in "line" as labels on "x-axis".',
      '```mermaid\nflowchart LR\n  A["…"] --> B["…"]\n```',
      '```mermaid\nmindmap\n  root((Topic))\n    Branch\n      leaf\n```',
      '  — every flowchart label in double quotes; no brackets of any kind inside mindmap labels.',
      'Make nothing up: numbers, formulas and examples come from the lecture only.',
    ];
  }
  return [
    'Только разметка Obsidian: заголовки, списки, таблицы, выноски, формулы $…$, Mermaid. Никакого HTML и плагинов.',
    'Выноска начинается строкой «> [!тип] Заголовок», и каждая её строка тоже начинается с «> ». Между выносками — пустая строка. «> [!тип]- Заголовок» — свёрнутая: так прячут ответы.',
    'Типы выносок: abstract — кратко; question — вопрос, ответ внутри, свёрнуто; tip — как запомнить или не ошибиться; quote — слова лектора; example — задача с решением по шагам; warning — организационное (сроки, экзамен); failure — частая ошибка; info — как спросят на экзамене.',
    ...(foreign
      ? [
          `Текст на ${foreign} — отдельной строкой; перевод — следующим абзацем той же выноски (между ними строка из одного «>»), курсивом.`,
          `В заголовках «###» — ни слова на ${foreign}, и никогда рядом с числами и временем в одной строке: разные направления письма перемешаются.`,
        ]
      : []),
    'Формулы — $…$ в строке и $$…$$ отдельной строкой.',
    'Таблица — когда есть шаги расчёта или сравнение; не больше 6 столбцов.',
    'Mermaid — только если он правда помогает, и только эти виды, ровно в такой форме:',
    '```mermaid\nxychart-beta\n  title "Название"\n  x-axis "Ось X" [0, 50, 100]\n  y-axis "Ось Y" 0 --> 260\n  line [250, 200, 150]\n```',
    '  — только для конкретных чисел из лекции; значений в «line» столько же, сколько подписей у «x-axis».',
    '```mermaid\nflowchart LR\n  A["…"] --> B["…"]\n```',
    '```mermaid\nmindmap\n  root((Тема))\n    Ветка\n      лист\n```',
    '  — подписи flowchart всегда в двойных кавычках; в подписях mindmap никаких скобок.',
    'Ничего не выдумывать: числа, формулы, примеры — только из лекции.',
  ];
}

/** Как писать раздел конспекта (кусок лекции за несколько минут). */
export function sectionStyleRules(style: NotesStyle, { notes, foreign }: NoteLanguages): string[] {
  const en = notes === 'en';
  const logistics = en
    ? '- course logistics that matter to the student (exam format, deadlines, required reading, office hours) go into a separate section "### Course logistics": a "> [!warning]" callout, and what the student has to do as "- [ ] …" items.'
    : '- организационное, важное студенту (формат экзамена, сроки, обязательная литература, часы приёма), — отдельным разделом «### Организационное»: выноска «> [!warning]», а что студенту сделать — пунктами «- [ ] …».';
  if (style === 'questions') {
    return en
      ? [
          '- then 2–4 folded callouts "> [!question]- Question?", each checking one idea of this chunk; the answer inside, 1–3 lines, with the numbers and terms from the lecture;',
          '- if a problem is solved in the chunk — "> [!example]- Step by step" with numbered steps;',
          '- if the lecturer warns about a mistake — an open "> [!failure] Trap: …" callout;',
          logistics,
        ]
      : [
          '- дальше 2–4 свёрнутые выноски «> [!question]- Вопрос?», каждая проверяет одну мысль куска; ответ внутри, 1–3 строки, с числами и терминами из лекции;',
          '- если в куске решается задача — «> [!example]- Решение по шагам» с нумерованными шагами;',
          '- если лектор предупреждает об ошибке — открытая выноска «> [!failure] Ловушка: …»;',
          logistics,
        ];
  }
  if (style === 'bilingual') {
    if (foreign) {
      return en
        ? [
            `- the lecturer's key sentence of the chunk — "> [!quote] mm:ss" (the minute from the transcript marks): the sentence in ${foreign} as the lecturer said it, recognition errors fixed, then its translation as a separate paragraph;`,
            `- 3–6 bullet points in English; terms as "term (the lecturer's term in ${foreign})";`,
            `- the chunk's new terms (2–5) — a table "| ${foreign} | English |";`,
            `- "> [!info]- How the exam will ask it" — an exam-style question in ${foreign}, its translation as a separate paragraph, and a short answer;`,
            logistics,
          ]
        : [
            `- главная фраза лектора в куске — «> [!quote] мм:сс» (минута — по меткам расшифровки): фраза на ${foreign}, как он её сказал, с исправленными ошибками распознавания, затем перевод отдельным абзацем;`,
            `- 3–6 пунктов на русском; термины — «термин по-русски (термин лектора на ${foreign})»;`,
            `- новые термины куска (2–5) — таблица «| На ${foreign} | По-русски |»;`,
            `- «> [!info]- Как это спросят на экзамене» — вопрос в духе экзамена на ${foreign}, перевод отдельным абзацем и короткий ответ;`,
            logistics,
          ];
    }
    return en
      ? [
          '- the lecturer\'s key sentence of the chunk — "> [!quote] mm:ss" (the minute from the transcript marks), as the lecturer said it, recognition errors fixed;',
          '- 3–6 bullet points; terms exactly as the lecturer named them;',
          '- the chunk\'s new terms (2–5) — a table "| Term | Meaning |";',
          '- "> [!info]- How the exam will ask it" — an exam-style question and a short answer;',
          logistics,
        ]
      : [
          '- главная фраза лектора в куске — «> [!quote] мм:сс» (минута — по меткам расшифровки), как он её сказал, с исправленными ошибками распознавания;',
          '- 3–6 пунктов; термины — так, как их назвал лектор;',
          '- новые термины куска (2–5) — таблица «| Термин | Значение |»;',
          '- «> [!info]- Как это спросят на экзамене» — вопрос в духе экзамена и короткий ответ;',
          logistics,
        ];
  }
  // «Разбор» — как разборы занятий, которые владелец делал руками.
  return en
    ? [
        '- then 3–8 bullet points "- …" with the essentials: definitions, formulas, examples, what the lecturer stressed;',
        foreign ? `- terms in English with the lecturer's own word in ${foreign} in parentheses;` : '- terms as the lecturer said them;',
        `- if the lecturer said a key sentence (a definition, a rule) — one "> [!quote] Lecturer, mm:ss" callout (the minute from the transcript marks) with the lecturer's words${foreign ? ` in ${foreign} and the translation as a separate paragraph` : ''};`,
        '- a calculation or a problem — a table of steps or "> [!example]- Step by step";',
        '- at most one "> [!tip]" — how not to get it wrong;',
        '- end with one folded "> [!question]- Check yourself: …" with the answer inside;',
        logistics,
      ]
    : [
        '- дальше 3–8 пунктов «- …» с главным: определения, формулы, примеры, что лектор подчеркнул;',
        foreign ? `- термины — по-русски и в скобках на ${foreign}, как их сказал лектор;` : '- термины — как их сказал лектор;',
        `- если лектор сказал ключевую фразу (определение, правило) — одна выноска «> [!quote] Лектор, мм:сс» (минута — по меткам расшифровки) с его словами${foreign ? ` на ${foreign} и переводом отдельным абзацем` : ''};`,
        '- расчёт или задача — таблица шагов или «> [!example]- Решение по шагам»;',
        '- не больше одной «> [!tip]» — как не ошибиться;',
        '- в конце — одна свёрнутая «> [!question]- Проверь себя: …» с ответом внутри;',
        logistics,
      ];
}

/** Как писать итог лекции — он стоит над разделами. */
export function finalStyleRules(style: NotesStyle, { notes, foreign }: NoteLanguages): string[] {
  const en = notes === 'en';
  const s = SUMMARY_TITLE[notes];
  const concepts = en ? '## Concepts' : '## Понятия';
  const exam = en ? '## Exam questions' : '## Вопросы к экзамену';
  if (style === 'questions') {
    return en
      ? [
          `"> [!abstract]+ ${s}" — 2–4 sentences: what the lecture is about and the main conclusion.`,
          '"**After this lecture I can:**" and 3–5 items "- [ ] …" — skills, not topics.',
          'A mind map of the lecture: Mermaid mindmap, the root is the topic, 3–5 branches, 2–3 leaves each, 1–4 words per label.',
          `${concepts} — 5–15 lines like "- term${foreign ? ` (the lecturer's term in ${foreign})` : ''} — one line of explanation".`,
          `${exam} — 5–7 folded "> [!question]- N. question" callouts with the answer inside.`,
          '## Traps — 2–4 "> [!failure] …" callouts: mistakes that are easy to make on this material, only if the lecture gives grounds.',
        ]
      : [
          `«> [!abstract]+ ${s}» — 2–4 предложения: о чём лекция и главный вывод.`,
          '«**После этой лекции я умею:**» и 3–5 пунктов «- [ ] …» — умения, а не темы.',
          'Карта лекции: Mermaid mindmap, корень — тема, 3–5 веток, по 2–3 листа, в подписи 1–4 слова.',
          `${concepts} — 5–15 строк вида «- термин${foreign ? ` (термин лектора на ${foreign})` : ''} — одна строка объяснения».`,
          `${exam} — 5–7 свёрнутых выносок «> [!question]- N. вопрос» с ответом внутри.`,
          '## Ловушки — 2–4 выноски «> [!failure] …»: ошибки, которые легко сделать на этом материале, только если для них есть основания в лекции.',
        ];
  }
  if (style === 'bilingual') {
    const quotes = en
      ? `## How the lecturer said it — 2–4 "> [!quote] mm:ss" callouts with key sentences${foreign ? ` in ${foreign}, each with the translation as a separate paragraph` : ''}.`
      : `## Как это сказал лектор — 2–4 выноски «> [!quote] мм:сс» с ключевыми фразами${foreign ? ` на ${foreign}, у каждой перевод отдельным абзацем` : ''}.`;
    const table = foreign
      ? en
        ? `${concepts} — a table "| ${foreign} | English | In short |", 5–15 rows.`
        : `${concepts} — таблица «| На ${foreign} | По-русски | Коротко |», 5–15 строк.`
      : en
        ? `${concepts} — a table "| Term | In short |", 5–15 rows.`
        : `${concepts} — таблица «| Термин | Коротко |», 5–15 строк.`;
    return en
      ? [
          `"> [!abstract] ${s}" — 3–6 sentences: what the lecture is about and the main conclusion.`,
          quotes,
          table,
          `## The chain of reasoning — Mermaid flowchart LR, 3–6 nodes${foreign ? `, each label "term in ${foreign}<br/>translation"` : ''}.`,
          `${exam} — 3–7 folded "> [!question]- N. …" callouts${foreign ? ` with the question in ${foreign}; inside — the translation as a separate paragraph and the answer` : ' with the answer inside'}.`,
        ]
      : [
          `«> [!abstract] ${s}» — 3–6 предложений: о чём лекция и главный вывод.`,
          quotes,
          table,
          `## Цепочка рассуждения — Mermaid flowchart LR, 3–6 узлов${foreign ? `, подпись узла «термин на ${foreign}<br/>перевод»` : ''}.`,
          `${exam} — 3–7 свёрнутых выносок «> [!question]- N. …»${foreign ? ` с вопросом на ${foreign}; внутри — перевод отдельным абзацем и ответ` : ' с ответом внутри'}.`,
        ];
  }
  const table = foreign
    ? en
      ? `${concepts} — a table "| Term | In ${foreign} | In short |", 5–15 rows.`
      : `${concepts} — таблица «| Понятие | На ${foreign} | Коротко |», 5–15 строк.`
    : en
      ? `${concepts} — a table "| Term | In short |", 5–15 rows.`
      : `${concepts} — таблица «| Понятие | Коротко |», 5–15 строк.`;
  return en
    ? [
        `"> [!abstract] ${s}" — 3–6 sentences: what the lecture is about and the main conclusion.`,
        table,
        `${exam} — 3–7 folded "> [!question]- N. question" callouts with the answer inside.`,
        '## Cheat sheet — the essentials on one screen: formulas and rules, as a table or a list, up to 12 lines.',
      ]
    : [
        `«> [!abstract] ${s}» — 3–6 предложений: о чём лекция и главный вывод.`,
        table,
        `${exam} — 3–7 свёрнутых выносок «> [!question]- N. вопрос» с ответом внутри.`,
        '## Шпаргалка — главное на один экран: формулы и правила, таблицей или списком, до 12 строк.',
      ];
}

// ——— Уборка ответа модели ———

const MERMAID_KINDS = /^(xychart-beta|flowchart (?:LR|TD|TB|RL)|graph (?:LR|TD|TB|RL)|mindmap)\s*$/u;

/**
 * Пройдёт ли диаграмма в Obsidian. Проверка грубая, но ловит то, на чём
 * модель ошибается чаще всего: неизвестный вид, слова в ряду чисел, скобки в
 * подписях карты, неравные ряды графика. Лучше заметка без схемы, чем
 * заметка с красным «Syntax error» посередине.
 */
export function mermaidLooksValid(body: string): boolean {
  const строки = body.split(/\r?\n/u).map((l) => l.trimEnd()).filter((l) => l.trim());
  const вид = (строки[0] ?? '').trim();
  if (!MERMAID_KINDS.test(вид)) return false;
  if (/[<>]\s*script|<\/?(?!br\s*\/?>)[a-z]/iu.test(body)) return false;
  if (вид === 'xychart-beta') {
    const подписи = /x-axis\s+(?:"[^"]*"\s+)?\[([^\]]*)\]/u.exec(body);
    const ряды = [...body.matchAll(/^\s*(?:line|bar)\s+\[([^\]]*)\]\s*$/gmu)];
    if (ряды.length === 0) return false;
    for (const ряд of ряды) {
      const числа = (ряд[1] ?? '').split(',').map((s) => s.trim());
      if (числа.some((n) => !/^-?\d+(?:\.\d+)?$/u.test(n))) return false;
      if (подписи && числа.length !== (подписи[1] ?? '').split(',').length) return false;
    }
    return true;
  }
  if (вид === 'mindmap') {
    return строки.slice(1).every((l, i) => (i === 0 ? /^\s+root\(\([^()[\]{}]+\)\)\s*$/u.test(l) || /^\s+\S/u.test(l) : /^\s+[^()[\]{}]+$/u.test(l)));
  }
  // flowchart: подписи только в кавычках, кавычки парные.
  for (const l of строки.slice(1)) {
    if ((l.match(/"/gu) ?? []).length % 2 !== 0) return false;
    const безКавычек = l.replace(/"[^"]*"/gu, '""');
    if (/[[({]\s*[^"\s\])}]/u.test(безКавычек)) return false;
  }
  return true;
}

/**
 * Привести ответ модели к разметке, которую Obsidian покажет без ошибок:
 * сломанные диаграммы — прочь, выноски — через пустую строку, лишние пустые
 * строки — схлопнуть.
 */
export function tidyNoteMarkdown(text: string): string {
  let out = text.replace(/\r\n/gu, '\n');
  out = out.replace(/```mermaid\n([\s\S]*?)```\n?/gu, (блок, тело: string) => (mermaidLooksValid(тело) ? блок : ''));
  // Две выноски подряд без пустой строки Obsidian склеивает в одну.
  out = out.replace(/^(>.*)\n(?=> \[!)/gmu, '$1\n\n');
  return out.replace(/\n{3,}/gu, '\n\n').trim();
}

// ——— Правила для конвейера документов ———

/**
 * Правила для конвейера документов (`jarvis/documents/pipeline.ts`) — одним
 * текстом для промпта. Конспект лекции берёт правила кусками выше, по виду.
 *
 * Правила взяты не из головы, а из того, что владелец уже читал и оценил,
 * когда разборы делались для него руками (октябрь 2026):
 * - «очень обрывисто и очень мало переводов» — поэтому подробно, с полными
 *   переводами, а не пунктиром;
 * - «напиши вначале просто по-русски как историю» — поэтому сначала связный
 *   рассказ, потом разбор;
 * - «не сразу всё, по темам, от простого к сложному» — поэтому части по
 *   порядку, каждая на одну мысль;
 * - сворачиваемые вопросы для самопроверки, таблицы, графики и шпаргалка в
 *   конце — то, к чему он возвращался.
 *
 * Только средства самого Obsidian, без плагинов: у студента их может не быть.
 * Текст — для промпта модели, поэтому по-русски (инструкции модели в
 * Джарвисе пишутся на русском, язык ответа задаётся отдельно).
 */

export const NOTE_STYLE = `ОФОРМЛЕНИЕ ЗАМЕТОК (Obsidian, без плагинов)

Читатель — студент, который учится на неродном языке. Ему тяжело, поэтому:
- Пиши ПОДРОБНО и связно, а не пунктиром. Каждая мысль — полными предложениями.
- Переводи ПОЛНОСТЬЮ: цитата на языке оригинала — и сразу целиком её перевод, а не пара слов.
- Сначала просто и по-человечески, потом сложнее. Новый термин — только после того, как объяснено, что он значит.
- Термин — на языке заметки, а в скобках — как он звучит в оригинале: «альтернативная стоимость (עלות אלטרנטיבית)».

Средства (используй, где они помогают, а не ради украшения):
- Заголовки «##» — части, «###» — подчасти. Одна часть — одна мысль.
- Цитата оригинала: строка «> **текст оригинала**», под ней строка из одного «>», под ней «> *перевод*» — оригинал и перевод разными абзацами, иначе Obsidian уводит весь абзац справа налево. Текст справа налево (иврит, арабский) оставляй как есть.
- Словарик после трудной цитаты или в конце части — таблица «| Оригинал | Перевод | Что значит |».
- Выноски: «> [!tip] Подсказка», «> [!warning] Ловушка», «> [!info] Важно», «> [!example] Пример».
- Самопроверка — сворачиваемая выноска, ответ открывается щелчком:
  > [!question]- Вопрос?
  > Ответ с объяснением.
- Таблицы — для сравнений, расчётов по шагам, сроков, критериев.
- Формулы — LaTeX: $x$ в строке, $$...$$ отдельной строкой.
- Чек-лист — «- [ ] шаг» (студент отмечает сделанное прямо в заметке).
- Схема связей или порядка — блок \`\`\`mermaid (flowchart, timeline).
- График, если в материале есть график или его легко построить по числам: файл SVG в папке graphs/ с понятным уникальным именем
  (например graphs/<коротко-о-документе>-<что-на-графике>.svg), встраивание «![[graphs/имя.svg]]».
  SVG простой: белый фон, оси с подписями и делениями, подписанные точки и линии, шрифт sans-serif, размер около 640×440.
  На одном графике — одна шкала: не рисуй на одной оси величины разного смысла (например, веса в процентах и баллы из 100).
  Подпись на иврите или арабском — отдельным элементом <text> с direction="rtl", не в одной строке с русским или английским.
- Ссылки на другие заметки этого же разбора — [[Имя заметки]].

Структура почти любой заметки:
1. «## Коротко» — 3–6 предложений: о чём это и зачем студенту.
2. Основные части от простого к сложному.
3. «## Проверь себя» — 4–8 сворачиваемых вопросов с ответами.
4. «## Шпаргалка» — самое нужное одной таблицей или коротким списком.`;
