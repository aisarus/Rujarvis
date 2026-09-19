/**
 * Навыки, которые Джарвис пишет себе сам.
 *
 * До сих пор каждый навык писал человек. Это значит, что всё выясненное с
 * трудом — где у программы нужная кнопка, каким флагом её запускать, какой
 * оператор в этой версии переименовали — живёт ровно до конца задачи, а в
 * следующий раз выясняется заново.
 *
 * Здесь Джарвис получает право записать найденное. Не заметку на полях, а
 * настоящий навык рядом с написанными вручную: в следующем запуске он
 * подхватится сам и будет прочитан до начала работы.
 *
 * ## Что защищено
 *
 * **Имя не может увести из папки навыков.** Оно попадает в путь, и запись по
 * произвольному пути — это запись куда угодно на диске.
 *
 * **Чужое не перезаписывается молча.** Написанные человеком навыки помечены
 * отсутствием метки; переписать их можно только по прямому требованию. Иначе
 * однажды исчезнет чья-то работа, и никто не поймёт куда.
 */

import path from 'node:path';

/** Метка в заголовке: этот навык записал Джарвис, а не человек. */
const MARKER = 'author: jarvis';

/** Имя попадает в путь, поэтому допускается только безопасный набор. */
const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,48}$/u;

export interface SkillDraft {
  name: string;
  /** Одна строка: по ней Клод решает, открывать ли навык. */
  description: string;
  /** Тело в Markdown, как в написанных вручную навыках. */
  body: string;
}

export function isValidSkillName(name: string): boolean {
  return NAME_PATTERN.test(name.trim());
}

export function skillPath(root: string, name: string): string {
  const clean = name.trim();
  if (!isValidSkillName(clean)) {
    throw new Error(`Недопустимое имя навыка: «${name}». Только строчные латинские буквы, цифры и дефис.`);
  }

  const file = path.join(root, clean, 'SKILL.md');
  // Проверка пути, а не только имени: пояс поверх подтяжек, потому что цена
  // ошибки здесь — запись в произвольное место файловой системы.
  const inside = path.resolve(file).startsWith(path.resolve(root) + path.sep);
  if (!inside) throw new Error(`Имя навыка уводит за пределы папки: «${name}».`);

  return file;
}

export function buildSkillFile(draft: SkillDraft): string {
  // Описание уходит в YAML одной строкой: перенос внутри него разрушил бы
  // весь заголовок, и навык перестал бы читаться целиком.
  const description = draft.description.replace(/\s+/gu, ' ').trim();
  const body = draft.body.trim();

  return [
    '---',
    `name: ${draft.name.trim()}`,
    `description: ${description}`,
    MARKER,
    '---',
    '',
    body,
    '',
  ].join('\n');
}

/** Записан ли этот навык Джарвисом. Чужой перезаписывать нельзя. */
export function isSelfAuthored(content: string): boolean {
  const header = content.split('---')[1];
  if (!header) return false;
  return header.split('\n').some((line) => line.trim() === MARKER);
}
