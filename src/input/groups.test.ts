import { describe, expect, it } from 'vitest';
import { keyDigit, matchingGroup } from './groups';

/** A keydown as the DOM reports it — only the two fields keyDigit reads. */
const key = (code: string, k: string) => ({ code, key: k });

describe('keyDigit', () => {
  it('reads the number row', () => {
    expect(keyDigit(key('Digit1', '1'))).toBe(1);
    expect(keyDigit(key('Digit9', '9'))).toBe(9);
    expect(keyDigit(key('Digit0', '0'))).toBe(0);
  });

  it('still reads it with Shift held', () => {
    // The whole reason this function prefers `code`: Shift+1 is `!` on a US
    // layout, and Shift+N is half of the control-group binding.
    expect(keyDigit(key('Digit1', '!'))).toBe(1);
    expect(keyDigit(key('Digit2', '@'))).toBe(2);
  });

  it('reads a number the layout only prints under Shift', () => {
    // AZERTY: the key that says 1 sends `&` on its own and `1` shifted.
    expect(keyDigit(key('Digit1', '&'))).toBe(1);
    expect(keyDigit(key('Digit1', '1'))).toBe(1);
  });

  it('takes the numpad too', () => {
    expect(keyDigit(key('Numpad4', '4'))).toBe(4);
    // NumLock off: the same keys report arrows and Home, and mean them.
    expect(keyDigit(key('NumpadEnter', 'Enter'))).toBeNull();
    expect(keyDigit(key('NumpadAdd', '+'))).toBeNull();
  });

  it('says nothing about anything else', () => {
    expect(keyDigit(key('KeyA', 'a'))).toBeNull();
    expect(keyDigit(key('Escape', 'Escape'))).toBeNull();
    expect(keyDigit(key('Minus', '-'))).toBeNull();
    expect(keyDigit(key('F1', 'F1'))).toBeNull();
  });

  it('falls back to the keycap where there is no code at all', () => {
    // Some synthetic and remote input paths report an empty `code`; a
    // binding that quietly stops existing there is the worse failure.
    expect(keyDigit(key('', '7'))).toBe(7);
    expect(keyDigit(key('', 'a'))).toBeNull();
  });

  it('reads the shifted US row in that fallback too', () => {
    // Otherwise the backstop is only half of one: bare N and Ctrl+N both
    // arrive as a plain digit, so recall and stamp would work there while
    // Shift+N — add to the group — silently did nothing.
    expect(keyDigit(key('', '!'))).toBe(1);
    expect(keyDigit(key('', ')'))).toBe(0);
    expect(keyDigit(key('', '('))).toBe(9);
    expect(keyDigit(key('', '$'))).toBe(4);
    expect(keyDigit(key('', '-'))).toBeNull();
  });

  it('never guesses the shifted row when there is a code to read', () => {
    // The guess is US-only and wrong on other layouts, so it must stay
    // sealed inside the codeless path: a German Shift+7 is `/`, and a
    // French one is `è`, and neither is the 6 this table would read.
    expect(keyDigit(key('Slash', '/'))).toBeNull();
    expect(keyDigit(key('Digit7', '/'))).toBe(7);
  });
});

describe('matchingGroup', () => {
  const groups = (entries: [number, number[]][]) =>
    new Map(entries.map(([d, ids]) => [d, new Set(ids)]));

  it('names the group a selection is exactly', () => {
    expect(matchingGroup(groups([[1, [4, 5, 6]]]), new Set([6, 5, 4]))).toBe(1);
  });

  it('says nothing about a selection that merely overlaps one', () => {
    const g = groups([[1, [4, 5, 6]]]);
    expect(matchingGroup(g, new Set([4, 5]))).toBeNull();
    expect(matchingGroup(g, new Set([4, 5, 6, 7]))).toBeNull();
    expect(matchingGroup(g, new Set([4, 5, 7]))).toBeNull();
  });

  it('is nobody’s group when nothing is selected', () => {
    // Not even a group that has been emptied by casualties: the badge would
    // then be claiming a squad that no longer exists.
    expect(matchingGroup(groups([[1, []]]), new Set())).toBeNull();
  });

  it('prefers the lower number when two groups hold the same squad', () => {
    // Stamped 5 first, then 1 — the map's order is not the player's.
    expect(
      matchingGroup(
        groups([
          [5, [1, 2]],
          [1, [1, 2]],
        ]),
        new Set([1, 2]),
      ),
    ).toBe(1);
  });

  it('reads group 0 as the last one, not the first', () => {
    // 0 sits at the right-hand end of the number row and is pressed as the
    // tenth group, so a tie with 9 goes to 9.
    expect(
      matchingGroup(
        groups([
          [0, [3]],
          [9, [3]],
        ]),
        new Set([3]),
      ),
    ).toBe(9);
    expect(matchingGroup(groups([[0, [3]]]), new Set([3]))).toBe(0);
  });
});
