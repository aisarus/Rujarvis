/**
 * Hearing «да» and «нет».
 *
 * Sensitive work asks before it proceeds, and the whole point of this build is
 * that the person may have no hands free — so a dialog box with buttons is not
 * an answer, it is a dead end. The question is spoken and the answer is
 * listened for.
 *
 * Unrecognised is a third outcome on purpose. Treating «подожди, я сейчас
 * посмотрю» as consent because it was not a clear «нет» is exactly the mistake
 * that makes a confirmation worthless.
 */

export type Confirmation = 'yes' | 'no' | 'unclear';

// Оба языка сразу: ответ на вопрос о красной линии не должен зависеть от
// выбранного режима. Человек, переключившийся на русский, всё равно скажет
// «no», и это обязано быть отказом.
const YES = [
  'да', 'ага', 'угу', 'давай', 'давайте', 'можно', 'конечно', 'разрешаю',
  'подтверждаю', 'согласен', 'согласна', 'ок', 'окей', 'валяй', 'вперед',
  'делай', 'сделай', 'йес',
  'yes', 'yeah', 'yep', 'yup', 'sure', 'ok', 'okay', 'go', 'proceed', 'confirm',
  'confirmed', 'approve', 'approved', 'allow', 'affirmative', 'absolutely',
];

const NO = [
  'нет', 'не', 'неа', 'отмена', 'отставить', 'стоп', 'хватит', 'погоди',
  'подожди', 'не надо', 'не разрешаю', 'запрещаю', 'ни в коем случае',
  'no', 'nope', 'nah', 'not', 'dont', 'do not', 'never', 'cancel', 'stop',
  'wait', 'hold', 'deny', 'denied', 'negative', 'abort',
];

function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/ё/gu, 'е')
    // «Don't» без апострофа — одно слово: иначе от отказа остаётся «t».
    .replace(/['’]/gu, '')
    .replace(/[^\p{L}\s]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

/**
 * Reads an answer to a yes-or-no question.
 *
 * A negation anywhere wins: «да не надо» is a refusal, and the safe reading of
 * a sentence containing both is the one that does nothing.
 */
export function readConfirmation(transcript: string): Confirmation {
  const text = normalise(transcript);
  if (!text) return 'unclear';

  const words = text.split(' ');
  const hasNo = NO.some((word) => text.startsWith(`${word} `) || text === word || words.includes(word));
  if (hasNo) return 'no';

  const hasYes = YES.some((word) => words.includes(word));
  if (hasYes) return 'yes';

  return 'unclear';
}
