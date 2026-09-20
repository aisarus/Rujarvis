/**
 * Сквозная проверка ВСЕХ прямых команд из каталога.
 *
 * ## Зачем отдельно от `проверка-команд.ts`
 *
 * Там проверяется путь фразы через все слои — но фраз тридцать, выбранных
 * руками. Здесь другое: берётся каталог целиком, то есть ровно то, что Джарвис
 * обещает человеку вслух на «что ты умеешь», и каждое обещание проверяется.
 *
 * Список, который лжёт, хуже отсутствующего: человек скажет обещанное, ничего
 * не произойдёт, и он перестанет верить всему списку целиком.
 *
 * ## Чем это отличается от теста каталога
 *
 * `catalogue.vitest.test.ts` спрашивает «разобралось ли хоть во что-то».
 * Этого мало: «разверни» могло бы разобраться в клик по кнопке «разверни» —
 * тест зелёный, человек в недоумении. Поэтому здесь для каждой фразы записано,
 * ВО ЧТО она обязана разобраться, вплоть до сочетания клавиш.
 *
 * ## Почему трижды
 *
 * Человек не говорит как в справочнике. Он говорит «Джарвис, сохрани» и «ну
 * прокрути вниз пожалуйста». Все три вида обязаны работать, и ровно на этом
 * стыке 20.09.2026 сломалось всё сразу: имя оставалось в тексте, ни одна
 * команда не совпадала, и каждая фраза уходила агенту на тридцать секунд.
 *
 *   npx tsx scripts/проверка-прямых-команд.ts
 */

import { commandCatalogue } from '../jarvis/control/catalogue';
import { parseDirectCommand } from '../jarvis/control/commands';
import { parseDictationEdit } from '../jarvis/control/dictationEdits';
import { matchVoiceControl } from '../jarvis/voice/interrupts';
import { isSilenceRequest, meaningfulSpeech } from '../jarvis/voice/noise';
import { findWakeWord } from '../jarvis/voice/wakeWord';

/**
 * Три исхода, а не два.
 *
 * Прибор, который кричит по пустякам, хуже отсутствующего: «нечем проверить»
 * оставлено для случаев, где поломки нет, а проверить нечем.
 */
type Verdict = null | string | { нечем: string };

/** Так фразу видит мост: имя убрано, шум отсеян. */
function asBridgeSees(said: string): string | null {
  const heard = meaningfulSpeech(said);
  if (!heard) return null;
  const found = findWakeWord(heard);
  // Имя — обращение только в начале. Внутри фразы это содержание.
  if (!found || found.index !== 0) return heard;
  return found.command || heard;
}

/** Во что обязана разобраться фраза. Проверяется только то, что названо. */
interface Expect {
  kind: string;
  fields?: Record<string, unknown>;
}

/**
 * Обещанное каталогом — и что за этим стоит на самом деле.
 *
 * Ключ — фраза из каталога слово в слово. Если каталог пополнят, а сюда не
 * допишут, проверка скажет об этом вслух: необъяснённое обещание — это
 * обещание, которое никто не проверял.
 */
const EXPECTED: Record<string, Expect> = {
  // Программы.
  'переключись на блендер': { kind: 'focus', fields: { title: 'блендер' } },
  'разверни': { kind: 'key', fields: { keys: 'win+up' } },
  'сверни': { kind: 'key', fields: { keys: 'win+down' } },
  'закрой окно': { kind: 'key', fields: { keys: 'alt+f4' } },
  'покажи рабочий стол': { kind: 'key', fields: { keys: 'win+d' } },

  // Мышь и точка на экране.
  'кликни войти': { kind: 'clickNamed', fields: { query: 'войти' } },
  'кликни': { kind: 'click', fields: { button: 'left' } },
  'правый клик': { kind: 'click', fields: { button: 'right' } },
  'двойной клик': { kind: 'click', fields: { button: 'left', double: true } },
  'сетка': { kind: 'grid', fields: { on: true } },
  'клик сорок пять': { kind: 'gridClick', fields: { cell: 45 } },
  'точнее пять': { kind: 'gridRefine', fields: { sub: 5 } },
  'убери сетку': { kind: 'grid', fields: { on: false } },

  // Прокрутка.
  'прокрути вниз': { kind: 'scroll', fields: { amount: -3 } },
  'прокрути вверх': { kind: 'scroll', fields: { amount: 3 } },
  'в самый низ': { kind: 'key', fields: { keys: 'ctrl+end' } },
  'в самый верх': { kind: 'key', fields: { keys: 'ctrl+home' } },
  'страница вниз': { kind: 'key', fields: { keys: 'pagedown' } },
  'прокрути вниз три раза': {
    kind: 'repeat',
    fields: { times: 3, command: { kind: 'scroll', amount: -3 } },
  },

  // Текст.
  'режим диктовки': { kind: 'dictation', fields: { on: true } },
  'конец диктовки': { kind: 'dictation', fields: { on: false } },
  'напечатай привет': { kind: 'type', fields: { text: 'привет' } },
  'скопируй': { kind: 'key', fields: { keys: 'ctrl+c' } },
  'вставь': { kind: 'key', fields: { keys: 'ctrl+v' } },
  'вырежи': { kind: 'key', fields: { keys: 'ctrl+x' } },
  'выдели все': { kind: 'key', fields: { keys: 'ctrl+a' } },
  'отмени действие': { kind: 'key', fields: { keys: 'ctrl+z' } },
  'удали': { kind: 'key', fields: { keys: 'backspace' } },

  // Клавиши. «Отмены» здесь нет нарочно: она разбирается раньше как отмена
  // задачи, и каталог её больше не обещает — обещает «эскейп».
  'enter': { kind: 'key', fields: { keys: 'enter' } },
  'эскейп': { kind: 'key', fields: { keys: 'escape' } },
  'таб': { kind: 'key', fields: { keys: 'tab' } },
  'пробел': { kind: 'key', fields: { keys: 'space' } },
  'вниз': { kind: 'key', fields: { keys: 'down' } },
  'вверх': { kind: 'key', fields: { keys: 'up' } },
  'сохрани': { kind: 'key', fields: { keys: 'ctrl+s' } },
  'найди': { kind: 'key', fields: { keys: 'ctrl+f' } },
  'обнови': { kind: 'key', fields: { keys: 'f5' } },

  // Вкладки.
  'новая вкладка': { kind: 'key', fields: { keys: 'ctrl+t' } },
  'закрой вкладку': { kind: 'key', fields: { keys: 'ctrl+w' } },
  'верни вкладку': { kind: 'key', fields: { keys: 'ctrl+shift+t' } },
  'следующая вкладка': { kind: 'key', fields: { keys: 'ctrl+tab' } },

  // Звук.
  'громче': { kind: 'key', fields: { keys: 'volumeup' } },
  'тише звук': { kind: 'key', fields: { keys: 'volumedown' } },
  'выключи звук': { kind: 'key', fields: { keys: 'volumemute' } },
  // «Паузы» здесь нет по той же причине: это просьба отложить работу.
  'играй': { kind: 'key', fields: { keys: 'playpause' } },
  'следующий трек': { kind: 'key', fields: { keys: 'nexttrack' } },

  // Разговор.
  'что ты умеешь': { kind: 'help', fields: { on: true } },
  'что ты делаешь': { kind: 'log', fields: { on: true } },
  'где ты': { kind: 'where' },
  'диктую': { kind: 'longSpeech' },
  'работай в фоне': { kind: 'mode', fields: { show: false } },
  'показывай всё': { kind: 'mode', fields: { show: true } },
  'закрой лог': { kind: 'log', fields: { on: false } },

  // Правка прямо во время диктовки — другой слой, другой разбор.
  'удали последнее слово': { kind: 'key', fields: { keys: 'ctrl+backspace' } },
  'удали строку': { kind: 'keys', fields: { keys: ['home', 'shift+end', 'backspace'] } },
  'новая строка': { kind: 'key', fields: { keys: 'enter' } },
  'исправь на встречу': { kind: 'replace', fields: { text: 'встречу' } },
};

/**
 * Живая речь — то, как эти же команды звучат у человека.
 *
 * Каждая строка здесь была сломана на 20.09.2026, и почти все — от одного
 * лишнего слова рядом с командой из каталога. Список разросся не от фантазии:
 * так говорят, и цена несовпадения — тридцать секунд через агента вместо
 * трёхсот миллисекунд, а иногда и чужое действие вместо нужного.
 */
const ЖИВАЯ_РЕЧЬ: { said: string; expect: Expect }[] = [
  // Окно. «Сверни окно» доходило до слоя закрытия и ЗАКРЫВАЛО окно: просили
  // свернуть, а теряли работу.
  { said: 'сверни окно', expect: { kind: 'key', fields: { keys: 'win+down' } } },
  { said: 'разверни окно', expect: { kind: 'key', fields: { keys: 'win+up' } } },
  { said: 'закрой это окно', expect: { kind: 'key', fields: { keys: 'alt+f4' } } },

  // Вкладки. «Открой новую вкладку» уходило в слой запуска, и Джарвис искал в
  // меню «Пуск» программу с названием «новую вкладку».
  { said: 'открой новую вкладку', expect: { kind: 'key', fields: { keys: 'ctrl+t' } } },
  { said: 'закрой эту вкладку', expect: { kind: 'key', fields: { keys: 'ctrl+w' } } },
  {
    said: 'вернись на предыдущую вкладку',
    expect: { kind: 'key', fields: { keys: 'ctrl+shift+tab' } },
  },

  // Мышь. Названное целиком уходило искать кнопку с надписью «правой кнопкой».
  { said: 'кликни правой кнопкой', expect: { kind: 'click', fields: { button: 'right' } } },
  { said: 'правой кнопкой мыши', expect: { kind: 'click', fields: { button: 'right' } } },
  {
    said: 'двойной щелчок',
    expect: { kind: 'click', fields: { button: 'left', double: true } },
  },

  // Клавиши, названные вслух.
  { said: 'нажми стрелку вниз', expect: { kind: 'key', fields: { keys: 'down' } } },
  { said: 'стрелка вверх', expect: { kind: 'key', fields: { keys: 'up' } } },
  { said: 'страницу вниз', expect: { kind: 'key', fields: { keys: 'pagedown' } } },

  // Прокрутка и повтор.
  { said: 'прокрути страницу вниз', expect: { kind: 'scroll', fields: { amount: -3 } } },
  { said: 'пролистай вниз', expect: { kind: 'scroll', fields: { amount: -3 } } },
  { said: 'прокрути вниз ещё раз', expect: { kind: 'scroll', fields: { amount: -3 } } },
  { said: 'вниз ещё раз', expect: { kind: 'key', fields: { keys: 'down' } } },
  { said: 'кликни ещё раз', expect: { kind: 'click', fields: { button: 'left' } } },

  // Мелочи, каждая из которых молчала.
  { said: 'обнови страницу', expect: { kind: 'key', fields: { keys: 'f5' } } },
  { said: 'отмени последнее действие', expect: { kind: 'key', fields: { keys: 'ctrl+z' } } },
  { said: 'скопируй это', expect: { kind: 'key', fields: { keys: 'ctrl+c' } } },
  { said: 'вставь сюда', expect: { kind: 'key', fields: { keys: 'ctrl+v' } } },

  // Вопросы о работе человек задаёт со словом «ты».
  { said: 'чем ты занят', expect: { kind: 'log', fields: { on: true } } },
  { said: 'покажи что ты делаешь', expect: { kind: 'log', fields: { on: true } } },
  { said: 'на каком ты шаге', expect: { kind: 'where' } },
  { said: 'далеко ещё', expect: { kind: 'where' } },
  { said: 'что умеешь', expect: { kind: 'help', fields: { on: true } } },
  { said: 'не показывай окна', expect: { kind: 'mode', fields: { show: false } } },
];

/**
 * Просьбы, которые ОБЯЗАНЫ уходить агенту.
 *
 * Перехватить просьбу таблицей — значит сделать половину дела и отчитаться
 * целым. Каждая фраза здесь начинается со слова команды и командой не
 * является, и каждая новая строка в таблицах проверяется в том числе этим.
 */
const ГРАНИЦЫ = [
  'найди отчёт за март',
  'открой блендер и сделай ракету',
  'сохрани отчёт в папку загрузки',
  'удали этот файл завтра',
  'напиши письмо маме',
  'вставь картинку в презентацию',
  'обнови данные в таблице',
  'выдели все файлы в папке',
  'прокрути вниз и найди цену',
  'кликни туда где написано что доставка бесплатная',
  'громче говори',
  'пауза на минуту',
  'открой новую вкладку и найди билеты',
];

function matches(command: Record<string, unknown> | null, expect: Expect): string | null {
  if (!command) return 'не разобрано как команда (ушло бы агенту)';
  if (command.kind !== expect.kind) {
    return `разобрано как «${String(command.kind)}», ожидали «${expect.kind}»`;
  }
  for (const [field, want] of Object.entries(expect.fields ?? {})) {
    const got = JSON.stringify(command[field]);
    if (got !== JSON.stringify(want)) {
      return `${field}: ${got ?? 'ничего'}, ожидали ${JSON.stringify(want)}`;
    }
  }
  return null;
}

/**
 * Прямая команда: как её увидит мост, так и разбираем.
 *
 * Слова остановки разбираются РАНЬШЕ таблицы команд, и фраза, попавшая в них,
 * до таблицы не доезжает никогда. Так справочник врал про «отмену» и «паузу»:
 * обещал клавишу, а срабатывала отмена задачи. Разбирать таблицу в одиночку
 * значит не увидеть этого и тут.
 */
function checkDirect(said: string, expect: Expect): Verdict {
  const heard = asBridgeSees(said);
  if (heard === null) return 'съедено как шум — до разбора не дошло';

  if (isSilenceRequest(heard)) return 'перехвачено раньше как просьба замолчать';
  const control = matchVoiceControl(heard);
  if (control) return `перехвачено раньше как слово остановки («${control.control}»)`;

  return matches(parseDirectCommand(heard) as Record<string, unknown> | null, expect);
}

/**
 * Как человек это скажет на самом деле.
 *
 * Имя в начале — самая дорогая поломка дня 20.09.2026. Вежливость — вторая по
 * дороговизне: «ну сохрани пожалуйста» это та же команда, и отправлять её
 * агенту на полминуты нельзя.
 */
function variants(said: string): { label: string; text: string }[] {
  return [
    { label: 'как в списке', text: said },
    { label: 'с именем', text: `Джарвис, ${said}` },
    { label: 'с вежливостью', text: `ну ${said} пожалуйста` },
  ];
}

interface Row {
  label: string;
  text: string;
  verdict: Verdict;
}

/**
 * Правка во время диктовки проверяется иначе, и это не поблажка.
 *
 * В режиме диктовки всё сказанное печатается буква в букву, поэтому разбирается
 * только точная фраза — иначе продиктованное слово исчезнет из текста, а
 * человек этого не увидит, потому что смотрит не в экран. Значит, «как в
 * списке» обязано сработать, а имя и вежливость обязаны НЕ сработать: это
 * слова, и они должны напечататься.
 */
function checkDictation(said: string, expect: Expect, label: string, text: string): Verdict {
  const edit = parseDictationEdit(text) as Record<string, unknown> | null;
  if (label === 'как в списке') return matches(edit, expect);
  if (!edit) return null;
  return `разобрано как правка «${String(edit.kind)}», а это диктуемый текст`;
}

function main(): void {
  const items = commandCatalogue()
    .flatMap((group) => group.items)
    .filter((item) => item.layer === 'direct' || item.layer === 'dictation');

  const rows: Row[] = [];
  const unexplained: string[] = [];

  for (const item of items) {
    const expect = EXPECTED[item.say];
    if (!expect) {
      unexplained.push(item.say);
      continue;
    }
    for (const variant of variants(item.say)) {
      rows.push({
        label: variant.label,
        text: variant.text,
        verdict:
          item.layer === 'dictation'
            ? checkDictation(item.say, expect, variant.label, variant.text)
            : checkDirect(variant.text, expect),
      });
    }
  }

  const fromCatalogue = rows.length;

  for (const item of ЖИВАЯ_РЕЧЬ) {
    for (const variant of variants(item.said)) {
      rows.push({
        label: variant.label,
        text: variant.text,
        verdict: checkDirect(variant.text, item.expect),
      });
    }
  }

  for (const said of ГРАНИЦЫ) {
    const heard = asBridgeSees(said);
    const command = heard === null ? null : parseDirectCommand(heard);
    rows.push({
      label: 'граница',
      text: said,
      verdict: command ? `перехвачено таблицей как «${command.kind}»` : null,
    });
  }

  const eol = String.fromCharCode(10);
  console.log(
    `Каталог: ${items.length} команд, ${fromCatalogue} проверок.` +
      ` Живая речь: ${ЖИВАЯ_РЕЧЬ.length * 3}. Границы: ${ГРАНИЦЫ.length}.${eol}`,
  );

  let bad = 0;
  let skipped = 0;
  for (const row of rows) {
    if (row.verdict === null) {
      console.log(`  ок   ${row.text}`);
    } else if (typeof row.verdict === 'object') {
      skipped += 1;
      console.log(`нечем  ${row.text.padEnd(40)} ${row.verdict.нечем}`);
    } else {
      bad += 1;
      console.log(`ПЛОХО  ${row.text.padEnd(40)} [${row.label}] ${row.verdict}`);
    }
  }

  if (unexplained.length > 0) {
    console.log('');
    console.log('Обещано каталогом, но здесь не сказано, во что это обязано разобраться:');
    for (const say of unexplained) console.log(`       ${say}`);
  }

  console.log('');
  const tail = skipped > 0 ? `, нечем проверить: ${skipped}` : '';
  const broken = bad + unexplained.length;
  console.log(
    broken === 0
      ? `Всё прошло: ${rows.length} проверок${tail}.`
      : `Не прошло: ${bad} из ${rows.length}${tail}.`,
  );
  process.exit(broken === 0 ? 0 : 1);
}

main();
