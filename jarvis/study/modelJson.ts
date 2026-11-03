/**
 * JSON из ответа модели, в строках которого бывает LaTeX.
 *
 * Конспект пишется с формулами в `$…$` (03.11.2026), и модель несёт их в
 * вопросы и карточки. В JSON обратный слеш надо удваивать, а она делает это не
 * всегда. Неудвоенный ломает двумя способами: `\dfrac` — неверная
 * последовательность, и JSON.parse роняет всю пачку вопросов; `\frac`, `\times`,
 * `\neq`, `\rho` разбираются молча — как перевод страницы, табуляция, перенос
 * и возврат каретки плюс огрызок команды, и студент учит «imes». Поэтому чинится
 * до разбора, а не после ошибки.
 */

/**
 * Настоящий перенос или табуляция отличаются от команды LaTeX только именем:
 * `\neq` — команда, `\nВторая` — перенос. Остальные буквы спутать не с чем: `\d`
 * в JSON не бывает, а перевод страницы и забой в тексте вопроса не нужны.
 */
const КОМАНДЫ_N_R_T =
  /^(?:ne|neq|neg|nu|nabla|not|notin|nmid|nleq|ngeq|nexists|newline|right\w*|rho|rangle|rceil|rfloor|rbrace|rvert|rVert|rm|times|tau|theta|tan|tanh|tilde|top|to|text\w*|tfrac|therefore|triangle\w*)$/u;

function этоКоманда(имя: string): boolean {
  if (имя.length === 1 && 'bfnrt'.includes(имя)) return false;
  return !'nrt'.includes(имя[0] as string) || КОМАНДЫ_N_R_T.test(имя);
}

/** Удвоить обратные слеши LaTeX; настоящие последовательности JSON остаются как есть. */
export function latexSafeJson(json: string): string {
  return json.replace(/\\(?:["\\/]|u[0-9a-fA-F]{4}|([A-Za-z]+)|([\s\S]))/gu, (всё, имя: string | undefined, знак: string | undefined) => {
    if (имя !== undefined) return этоКоманда(имя) ? `\\${всё}` : всё;
    return знак !== undefined ? `\\${всё}` : всё;
  });
}

export function parseModelJson(json: string): unknown {
  return JSON.parse(latexSafeJson(json));
}
