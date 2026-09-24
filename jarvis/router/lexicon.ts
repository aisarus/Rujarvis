/**
 * Словарь маршрутизатора — оба языка разом.
 *
 * Русский и английский действуют одновременно, в любом режиме: русские
 * пользователи говорят английские технические слова постоянно, а английская
 * речь не содержит кириллических основ. Объединение ничего не стоит и не
 * требует помнить, какой язык выбран.
 */

import {
  BACKEND_MENTIONS,
  CAPABILITY_RULES as RU_RULES,
  CONTINUATION_PHRASES as RU_CONTINUATION,
  EMPHASIS_STEMS as RU_EMPHASIS,
  INSPECT_ONLY_PHRASES as RU_INSPECT,
  LEADING_FILLER_STEMS as RU_LEADING,
  NO_EXECUTE_PHRASES as RU_NO_EXECUTE,
  REFERENTIAL_STEMS as RU_REFERENTIAL,
  type CapabilityRule,
} from './lexicon.ru';
import {
  CAPABILITY_RULES_EN,
  CONTINUATION_PHRASES_EN,
  EMPHASIS_STEMS_EN,
  INSPECT_ONLY_PHRASES_EN,
  LEADING_FILLER_STEMS_EN,
  NO_EXECUTE_PHRASES_EN,
  REFERENTIAL_STEMS_EN,
} from './lexicon.en';

export { BACKEND_MENTIONS, type CapabilityRule };

/** Правила по способностям: основы и фразы обоих языков в одном правиле. */
export const CAPABILITY_RULES: CapabilityRule[] = RU_RULES.map((rule) => {
  const en = CAPABILITY_RULES_EN.find((entry) => entry.capability === rule.capability);
  if (!en) return rule;
  return {
    capability: rule.capability,
    stems: [...rule.stems, ...en.stems],
    phrases: [...(rule.phrases ?? []), ...(en.phrases ?? [])],
  };
});

export const REFERENTIAL_STEMS = [...RU_REFERENTIAL, ...REFERENTIAL_STEMS_EN];
export const INSPECT_ONLY_PHRASES = [...RU_INSPECT, ...INSPECT_ONLY_PHRASES_EN];
export const NO_EXECUTE_PHRASES = [...RU_NO_EXECUTE, ...NO_EXECUTE_PHRASES_EN];
export const LEADING_FILLER_STEMS = [...RU_LEADING, ...LEADING_FILLER_STEMS_EN];
export const CONTINUATION_PHRASES = [...RU_CONTINUATION, ...CONTINUATION_PHRASES_EN];
export const EMPHASIS_STEMS = [...RU_EMPHASIS, ...EMPHASIS_STEMS_EN];
