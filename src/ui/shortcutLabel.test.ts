import {describe, expect, it} from 'vitest';
import {shortcutLabel} from './shortcutLabel';

describe('a label with its shortcut in it', () => {
  it('bolds the letter where it stands', () => {
    expect(shortcutLabel('Build', 'B')).toEqual({
      kind: 'split',
      before: '',
      letter: 'B',
      after: 'uild',
    });
    expect(shortcutLabel('Well', 'L')).toEqual({
      kind: 'split',
      before: 'We',
      letter: 'l',
      after: 'l',
    });
  });

  it('keeps the label’s own casing, not the key’s', () => {
    // We**l**l is lowercase in the word and uppercase in the table; the
    // word is what the player is reading, so the word wins.
    expect(shortcutLabel('Well', 'L')).toMatchObject({letter: 'l'});
    expect(shortcutLabel('Silver Mine', 'v')).toMatchObject({letter: 'v'});
  });

  it('takes the first occurrence', () => {
    expect(shortcutLabel('Barracks', 'A')).toMatchObject({
      before: 'B',
      letter: 'a',
    });
  });

  it('falls back to a parenthesised key when the label has no such letter', () => {
    expect(shortcutLabel('Muster', 'Q')).toEqual({kind: 'appended', key: 'Q'});
  });

  /**
   * The bug this module exists for. `'House'.indexOf('')` is 0, not -1, so
   * the obvious implementation reads "no shortcut" as "found it at the
   * front" and bolds the H of a key nobody can press. Both buildKey() and
   * trainKey() return '' for a thing with no shortcut, so this is one
   * unlettered building away from shipping.
   */
  it('shows nothing at all for an empty key', () => {
    expect(shortcutLabel('House', '')).toEqual({kind: 'none'});
    expect(shortcutLabel('', '')).toEqual({kind: 'none'});
  });
});
