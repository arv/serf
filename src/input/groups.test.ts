import { describe, expect, it } from 'vitest';
import { groupEmpty, keyDigit, matchingGroup, type ControlGroup, ControlGroupKind } from './groups';

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
});

describe('groupEmpty', () => {
  it('is what an untouched number and a wiped squad have in common', () => {
    expect(groupEmpty(undefined)).toBe(true);
    expect(groupEmpty({ kind: ControlGroupKind.units, ids: new Set() })).toBe(true);
  });

  it('is not a squad that still has someone, or a building at all', () => {
    expect(groupEmpty({ kind: ControlGroupKind.units, ids: new Set([7]) })).toBe(false);
    // A building group is its building or it has been dropped whole —
    // there is no emptied-by-casualties middle for it to sit in.
    expect(groupEmpty({ kind: ControlGroupKind.building, id: 7 })).toBe(false);
  });
});

describe('matchingGroup', () => {
  const groups = (entries: [number, number[]][]): Map<number, ControlGroup> =>
    new Map(entries.map(([d, ids]) => [d, { kind: ControlGroupKind.units, ids: new Set(ids) }]));
  const halls = (entries: [number, number][]): Map<number, ControlGroup> =>
    new Map(entries.map(([d, id]) => [d, { kind: ControlGroupKind.building, id }]));

  it('names the group a selection is exactly', () => {
    expect(matchingGroup(groups([[1, [4, 5, 6]]]), new Set([6, 5, 4]), null)).toBe(1);
  });

  it('says nothing about a selection that merely overlaps one', () => {
    const g = groups([[1, [4, 5, 6]]]);
    expect(matchingGroup(g, new Set([4, 5]), null)).toBeNull();
    expect(matchingGroup(g, new Set([4, 5, 6, 7]), null)).toBeNull();
    expect(matchingGroup(g, new Set([4, 5, 7]), null)).toBeNull();
  });

  it('is nobody’s group when nothing is selected', () => {
    // Not even a group that has been emptied by casualties: the badge would
    // then be claiming a squad that no longer exists.
    expect(matchingGroup(groups([[1, []]]), new Set(), null)).toBeNull();
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
        null,
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
        null,
      ),
    ).toBe(9);
    expect(matchingGroup(groups([[0, [3]]]), new Set([3]), null)).toBe(0);
  });

  it('names the group an open building card is', () => {
    expect(matchingGroup(halls([[4, 88]]), new Set(), 88)).toBe(4);
    expect(matchingGroup(halls([[4, 88]]), new Set(), 89)).toBeNull();
  });

  it('prefers the lower number for a building on two of them too', () => {
    expect(
      matchingGroup(
        halls([
          [7, 88],
          [2, 88],
        ]),
        new Set(),
        88,
      ),
    ).toBe(2);
  });

  it('never reads one kind of group as the other', () => {
    // Units and buildings draw ids from one pool, so a barracks can share a
    // number with a soldier — and a card open on #12 must not light up the
    // group that holds soldier #12.
    const mixed = new Map<number, ControlGroup>([
      [1, { kind: ControlGroupKind.units, ids: new Set([12]) }],
      [2, { kind: ControlGroupKind.building, id: 12 }],
    ]);
    expect(matchingGroup(mixed, new Set(), 12)).toBe(2);
    expect(matchingGroup(mixed, new Set([12]), null)).toBe(1);
  });

  it('is the card’s group while a card is open, whatever else is held', () => {
    // The two selections are mutually exclusive on screen: with a card
    // open the selection set is empty, and it is the card that is asked
    // about — a stale unit group can never answer for it.
    const mixed = new Map<number, ControlGroup>([
      [1, { kind: ControlGroupKind.units, ids: new Set([4, 5]) }],
      [3, { kind: ControlGroupKind.building, id: 90 }],
    ]);
    expect(matchingGroup(mixed, new Set(), 90)).toBe(3);
  });
});
