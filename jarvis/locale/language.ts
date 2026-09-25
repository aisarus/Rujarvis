/**
 * Язык, на котором Джарвис говорит и ждёт команд.
 *
 * Один на процесс: мост задаёт его при запуске, смена языка перезапускает
 * мост. Поэтому язык не протаскивается через каждый вызов — модули, у которых
 * есть таблицы на двух языках, спрашивают его здесь.
 *
 * Слова остановки и ответы «да/нет» понимаются на обоих языках всегда:
 * красная линия не должна зависеть от того, какой режим выбран.
 */

export type Language = 'ru' | 'en';

let active: Language = 'ru';

export function currentLanguage(): Language {
  return active;
}

export function setLanguage(language: Language): void {
  active = language;
}

/** Фраза на текущем языке. Русский — первым: это язык, на котором проект думает. */
export function tr(ru: string, en: string): string {
  return active === 'en' ? en : ru;
}

/** Таблица на текущем языке. */
export function byLanguage<T>(table: Record<Language, T>): T {
  return table[active];
}

/** Название языка для промпта модели: «Write the final answer in …». */
export function languageName(language: Language = active): string {
  return language === 'en' ? 'English' : 'Russian';
}
