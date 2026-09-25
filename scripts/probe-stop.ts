/**
 * Работают ли «стоп» и «тишина» при идущей задаче.
 *
 * Человек назвал это отдельным требованием: остальное можно делать молча, но
 * остановить должно получаться всегда.
 */

import { matchVoiceControl } from '../jarvis/voice/interrupts';
import { isSilenceRequest, looksLikeChatter } from '../jarvis/voice/noise';
import { EchoGuard } from '../jarvis/voice/echo';
import { parseDirectCommand } from '../jarvis/control/commands';

const PHRASES = ['стоп', 'Стоп!', 'хватит', 'отмена', 'стой', 'тишина', 'замолчи', 'тише'];

const echo = new EchoGuard();
// Джарвис как раз говорит — самый опасный момент для команды остановки.
echo.spoke('Сейчас сделаю, это займёт около минуты.');

for (const phrase of PHRASES) {
  const control = matchVoiceControl(phrase);
  const silence = isSilenceRequest(phrase);
  const swallowedAsEcho = echo.isOwnVoice(phrase);
  const swallowedAsChatter = looksLikeChatter(phrase);
  const direct = parseDirectCommand(phrase);

  const reaches = !swallowedAsEcho && !swallowedAsChatter;
  const acts = Boolean(control) || silence;

  // Порядок как в мосте: слово остановки проверяется раньше прямых команд,
  // поэтому перехват клавишей больше не мешает — но показываем, что он был бы.
  const wouldBeIntercepted = !control && !silence && direct !== null;

  console.log(
    `«${phrase}»: доходит=${reaches ? 'да' : 'НЕТ'} ` +
      `останавливает=${acts ? (control ? 'задачу' : 'разговор') : 'НЕТ'}` +
      (wouldBeIntercepted ? ` (перехвачено как ${direct?.kind})` : ''),
  );
}
