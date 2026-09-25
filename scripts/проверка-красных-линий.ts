/**
 * Проверка красных линий голоса на живом коде.
 *
 * ## Зачем
 *
 * Человек сформулировал требование сам: «идеально должны работать команды
 * стоп и тишина». Это то, что обязано срабатывать всегда и мгновенно — даже
 * когда не работает больше ничего.
 *
 * 20.09.2026 не работало ни то, ни другое, и обе поломки были невидимы для
 * полутора тысяч модульных тестов:
 *
 *   - слова «тишина» не было ни в одном списке команд, хотя справочник
 *     обещал его человеку прямым текстом;
 *   - заглушение, даже когда срабатывало, ничего не останавливало.
 *
 * Модульный тест проверяет функцию. Здесь проверяется ПУТЬ целиком: фраза
 * проходит фильтр шума, эхо-страж, разбор — и доходит до действия. Отдельно
 * проверяется, что справочник не обещает ничего, чего система не понимает.
 *
 * ## Чего здесь нет
 *
 * Голоса, микрофона и колонок. Всё остальное — тот же код, что и в живом
 * Джарвисе.
 *
 *   npx tsx scripts/проверка-красных-линий.ts
 */

import { commandCatalogue } from '../jarvis/control/catalogue';
import { parseDirectCommand } from '../jarvis/control/commands';
import { parseDictationEdit } from '../jarvis/control/dictationEdits';
import { spokenCloseTarget, spokenTarget } from '../jarvis/apps/launch';
import { EchoGuard } from '../jarvis/voice/echo';
import {
  applyVoiceControl,
  matchVoiceControl,
  type ControlTarget,
  type VoiceControl,
} from '../jarvis/voice/interrupts';
import { isSilenceRequest, looksLikeChatter, meaningfulSpeech } from '../jarvis/voice/noise';
import { findWakeWord } from '../jarvis/voice/wakeWord';

/**
 * Три исхода, а не два.
 *
 * «Нечем проверить» — не поломка, и записывать это провалом значит приучить
 * всех не смотреть на проверку. Прибор, который кричит по пустякам, хуже
 * отсутствующего.
 */
type Verdict = null | string | { нечем: string };

interface Case {
  said: string;
  check: () => Verdict;
}

/** Подставное «что умеет Джарвис»: записывает, что позвали. */
function spyTarget(): { target: ControlTarget; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    target: {
      cancelForeground: () => {
        calls.push('cancelForeground');
        return true;
      },
      pauseForeground: () => {
        calls.push('pauseForeground');
        return true;
      },
      resumeLast: () => {
        calls.push('resumeLast');
        return true;
      },
      stopSpeaking: () => {
        calls.push('stopSpeaking');
      },
    },
  };
}

interface RedLine {
  said: string;
  control: VoiceControl;
  /** Что обязано быть позвано, в этом порядке. */
  must: string[];
}

const RED_LINES: RedLine[] = [
  { said: 'стоп', control: 'stop', must: ['stopSpeaking', 'cancelForeground'] },
  { said: 'стой', control: 'stop', must: ['stopSpeaking', 'cancelForeground'] },
  { said: 'хватит', control: 'stop', must: ['stopSpeaking', 'cancelForeground'] },
  { said: 'останови всё', control: 'stop', must: ['stopSpeaking', 'cancelForeground'] },
  { said: 'тишина', control: 'mute', must: ['stopSpeaking'] },
  { said: 'тихо', control: 'mute', must: ['stopSpeaking'] },
  { said: 'помолчи', control: 'mute', must: ['stopSpeaking'] },
  { said: 'замолкни', control: 'mute', must: ['stopSpeaking'] },
  { said: 'пауза', control: 'pause', must: ['stopSpeaking', 'pauseForeground'] },
  { said: 'продолжай', control: 'resume', must: ['resumeLast'] },
];

/**
 * Весь путь от микрофона до дела.
 *
 * Именно стык и проверяется: каждый слой по отдельности был прав, а вместе
 * они человека не слышали.
 */
function wholePath(said: string, control: VoiceControl, must: string[]): Verdict {
  const heard = meaningfulSpeech(said);
  if (!heard) return 'съедено фильтром шума';

  if (looksLikeChatter(heard)) return 'отсеяно как болтовня';

  // Джарвис говорит, человек перебивает. Эхо-страж обязан пропустить —
  // проверяем в худшем случае: Джарвис только что сказал то же самое.
  const echo = new EchoGuard();
  echo.spoke(said);
  if (echo.isOwnVoice(heard)) return 'принято за собственный голос';

  const match = matchVoiceControl(heard);
  if (!match) return 'не понято как управление';
  if (match.control !== control) return `понято как «${match.control}», ожидали «${control}»`;

  const { target, calls } = spyTarget();
  const outcome = applyVoiceControl(match, target);
  if (calls.join(',') !== must.join(',')) {
    return `сделало [${calls.join(', ') || 'ничего'}], ожидали [${must.join(', ')}]`;
  }
  if (outcome.action === 'nothing') return 'отчиталось бездействием';
  return null;
}

const CASES: Case[] = [];

for (const line of RED_LINES) {
  // Каждое слово отдельно.
  CASES.push({ said: line.said, check: () => wholePath(line.said, line.control, line.must) });

  // И то же слово с обращением по имени: человек говорит «Джарвис, стоп».
  const withName = `джарвис ${line.said}`;
  CASES.push({ said: withName, check: () => wholePath(withName, line.control, line.must) });

  // И криком: у человека музыка за окном, и он повышает голос.
  const shouted = line.said.toUpperCase();
  CASES.push({ said: shouted, check: () => wholePath(shouted, line.control, line.must) });
}

// Заглушение обязано молчать в ответ. Отвечать голосом на просьбу замолчать —
// издевательство, и человек это уже слышал.
CASES.push({
  said: 'тишина (и ни звука в ответ)',
  check: () => {
    const match = matchVoiceControl('тишина');
    if (!match) return 'не понято';
    const { target } = spyTarget();
    const outcome = applyVoiceControl(match, target);
    return outcome.spoken === '' ? null : `ответило вслух: «${outcome.spoken}»`;
  },
});

// «Тишина» закрывает ещё и окно слушателя — это отдельный слой и отдельная
// дырка: справочник спрашивал его, а разбор команд не спрашивал никто.
for (const said of ['тишина', 'Тишина!', 'джарвис тишина', 'ТИШИНА']) {
  CASES.push({
    said: `${said} → закрыть разговор`,
    check: () => (isSilenceRequest(said) ? null : 'разговор не закрывается'),
  });
}

// Шум за окном красной линией не становится.
for (const noise of ['ДИНАМИЧНАЯ МУЗЫКА', 'МУЗЫКА', 'АПЛОДИСМЕНТЫ', 'СМЕХ ЗА КАДРОМ', '[музыка]']) {
  CASES.push({
    said: noise,
    check: () => (meaningfulSpeech(noise) === null ? null : 'прошло как речь'),
  });
}

// Работа остановкой не считается: перехватить просьбу значит сделать половину
// дела и отчитаться целым.
for (const work of [
  'останови сервис после тестов',
  'найди стоп слово в тексте',
  'поставь паузу между кадрами в анимации',
]) {
  CASES.push({
    said: work,
    check: () => (matchVoiceControl(work) ? 'перехвачено как остановка' : null),
  });
}

/** Тот слой, который в живой системе и обрабатывает эту фразу. */
function handledByLayer(say: string, layer: string): boolean {
  switch (layer) {
    case 'direct':
      return parseDirectCommand(say) !== null;
    case 'launch':
      return spokenTarget(say) !== null;
    case 'close':
      return spokenCloseTarget(say) !== null;
    case 'wake':
      return findWakeWord(say) !== null;
    case 'dictation':
      return parseDictationEdit(say) !== null;
    case 'control':
      return matchVoiceControl(say) !== null;
    case 'silence':
      return isSilenceRequest(say);
    default:
      return false;
  }
}

// Справочник: всё обещанное обязано разбираться и доезжать. Список, который
// лжёт, хуже отсутствующего — человек скажет обещанное, ничего не произойдёт,
// и он перестанет верить всему списку целиком.
for (const group of commandCatalogue()) {
  for (const item of group.items) {
    CASES.push({
      said: `${item.say} (${item.layer})`,
      check: () => {
        if (!meaningfulSpeech(item.say)) return 'съедено фильтром шума';
        if (!handledByLayer(item.say, item.layer)) {
          return `обещано, но слой «${item.layer}» её не разбирает`;
        }
        if (item.layer === 'direct') {
          const intercepted = matchVoiceControl(item.say);
          if (intercepted) return `обещано как «${item.does}», перехвачено как «${intercepted.control}»`;
          if (isSilenceRequest(item.say)) return `обещано как «${item.does}», перехвачено как тишина`;
        }
        if (item.layer === 'silence' && matchVoiceControl(item.say)?.control !== 'mute') {
          return 'закрывает разговор, но речь не заглушает';
        }
        return null;
      },
    });
  }
}

function main(): void {
  let bad = 0;
  let skipped = 0;
  console.log(`Красные линии: ${CASES.length} проверок${String.fromCharCode(10)}`);

  for (const item of CASES) {
    let verdict: Verdict;
    try {
      verdict = item.check();
    } catch (error) {
      verdict = error instanceof Error ? error.message : String(error);
    }

    if (verdict === null) {
      console.log(`  ок   ${item.said}`);
    } else if (typeof verdict === 'object') {
      skipped += 1;
      console.log(`нечем  ${item.said.padEnd(34)} ${verdict.нечем}`);
    } else {
      bad += 1;
      console.log(`ПЛОХО  ${item.said.padEnd(34)} ${verdict}`);
    }
  }

  console.log('');
  const tail = skipped > 0 ? `, нечем проверить: ${skipped}` : '';
  console.log(bad === 0 ? `Всё прошло${tail}.` : `Не прошло: ${bad} из ${CASES.length}${tail}.`);
  process.exit(bad === 0 ? 0 : 1);
}

main();
