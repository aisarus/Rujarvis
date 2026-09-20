import { describe, expect, it } from 'vitest';

import { spokenCloseTarget, spokenTarget } from '../apps/launch';
import { findWakeWord } from '../voice/wakeWord';
import { matchVoiceControl } from '../voice/interrupts';
import { isSilenceRequest } from '../voice/noise';
import { commandCatalogue } from './catalogue';
import { parseDictationEdit } from './dictationEdits';
import { parseDirectCommand } from './commands';

const catalogue = commandCatalogue();
const everyPhrase = catalogue.flatMap((group) => group.items.map((item) => item.say));

describe('commandCatalogue', () => {
  it('разложен по понятным разделам', () => {
    expect(catalogue.length).toBeGreaterThan(4);
    for (const group of catalogue) {
      expect(group.title.length).toBeGreaterThan(2);
      expect(group.items.length).toBeGreaterThan(0);
    }
  });

  it('каждая обещанная фраза действительно работает', () => {
    // Список, обещающий несуществующую команду, хуже отсутствия списка:
    // человек скажет её, ничего не произойдёт, и он перестанет верить всему.
    // Каждый пункт проверяется тем слоем, который его и обрабатывает.
    for (const group of catalogue) {
      for (const item of group.items) {
        const handled =
          item.layer === 'direct'
            ? parseDirectCommand(item.say) !== null
            : item.layer === 'launch'
              ? spokenTarget(item.say) !== null
              : item.layer === 'close'
                ? spokenCloseTarget(item.say) !== null
                : item.layer === 'wake'
                  ? findWakeWord(item.say) !== null
                  : item.layer === 'dictation'
                    ? parseDictationEdit(item.say) !== null
                    : item.layer === 'control'
                      ? matchVoiceControl(item.say) !== null
                      : isSilenceRequest(item.say);

        expect(handled, `«${item.say}» не разбирается слоем «${item.layer}»`).toBe(true);
      }
    }
  });

  it('у каждой фразы сказано, что она делает', () => {
    for (const group of catalogue) {
      for (const item of group.items) {
        expect(item.does.length, `«${item.say}» без объяснения`).toBeGreaterThan(3);
      }
    }
  });

  it('покрывает все виды команд, а не только клавиши', () => {
    const kinds = new Set(
      everyPhrase.map((phrase) => parseDirectCommand(phrase)?.kind).filter(Boolean),
    );
    for (const kind of ['key', 'scroll', 'click', 'focus', 'dictation', 'grid', 'clickNamed']) {
      expect(kinds.has(kind as never), `нет примера для «${kind}»`).toBe(true);
    }
  });

  it('не повторяет одну фразу дважды', () => {
    expect(new Set(everyPhrase).size).toBe(everyPhrase.length);
  });
});
