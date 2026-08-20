/**
 * The pure half of the control-group bindings: reading a number off a
 * keypress, and deciding which group a selection currently *is*.
 *
 * Split out of controls.ts so it can be tested at all — that file reaches
 * three.js and the HUD store the moment it is imported, neither of which
 * exists in a headless test. The stateful half (the groups themselves, and
 * weeding the dead out of them) stays there, beside the selection it
 * shadows.
 */

/** The digit a single character spells, or null. */
function digitOf(ch: string): number | null {
  return ch >= '0' && ch <= '9' ? ch.charCodeAt(0) - 48 : null;
}

/**
 * The US number row as Shift prints it, indexed by the digit underneath:
 * `)` is 0, `!` is 1, and so on. Consulted only where there is no `code` to
 * read — see keyDigit.
 */
const US_SHIFTED_ROW = ')!@#$%^&*(';

/**
 * The 0–9 a keypress means, or null for anything else.
 *
 * `code` first here, which is the opposite of keyLetter's rule in
 * controls.ts and for the very reason keyLetter gives. Shift is half of
 * this binding, and Shift+1 arrives as `!` on a US layout, `1` on a French
 * one, `˘` on a Czech one: `key` stops being the number printed on the
 * keycap the moment a modifier joins in. `code` is that number, on every
 * layout that puts one on the number row. The numpad is taken too — someone
 * reaching for 1 with their right hand means the same 1.
 *
 * `key` backstops it for the input paths that report no `code` at all, and
 * that backstop has to answer for Shift as well, or it is only half a
 * backstop: bare N and Ctrl+N both arrive there as a plain digit (Ctrl does
 * not shift the keycap), so recall and stamp would work while add-to-group
 * silently did nothing. Hence the US row — a guess, and knowingly the wrong
 * one on a German keyboard, where Shift+9 prints the `)` this table reads
 * as 0. Two things make that guess worth making rather than returning
 * nothing. It is reached only when the layout-independent answer is already
 * missing, so there is nothing better to consult. And it can only ever
 * misfire on Shift+N, never Ctrl+N, so the worst case is a squad added to
 * the wrong group — an annoyance one Ctrl+N puts right — and never a group
 * silently overwritten.
 */
export function keyDigit(e: Pick<KeyboardEvent, 'code' | 'key'>): number | null {
  const c = e.code;
  if (c.length === 6 && c.startsWith('Digit')) return digitOf(c[5]!);
  if (c.length === 7 && c.startsWith('Numpad')) return digitOf(c[6]!);
  if (c !== '' || e.key.length !== 1) return null;
  const bare = digitOf(e.key);
  if (bare !== null) return bare;
  const shifted = US_SHIFTED_ROW.indexOf(e.key);
  return shifted >= 0 ? shifted : null;
}

/** Group numbers in the order a player reads them: 1 first, 0 last. */
function digitRank(d: number): number {
  return d === 0 ? 10 : d;
}

/**
 * Which group this selection *is* — the lowest-numbered one it matches
 * exactly, or null.
 *
 * Recomputed from scratch on every selection change rather than remembered,
 * so a selection edited after the fact — a shift-click, a casualty, a band
 * drag over the same ground — stops claiming to be a group it is no longer
 * equal to. An empty selection is nobody's group, whatever the groups hold.
 */
export function matchingGroup(
  groups: ReadonlyMap<number, ReadonlySet<number>>,
  selection: ReadonlySet<number>,
): number | null {
  if (selection.size === 0) return null;
  let match: number | null = null;
  for (const [digit, group] of groups) {
    if (group.size !== selection.size) continue;
    let same = true;
    for (const id of group) {
      if (!selection.has(id)) {
        same = false;
        break;
      }
    }
    // Groups are stamped in press order, so the map's iteration order is
    // not the player's: 1 wins over 5 however they came to be made.
    if (same && (match === null || digitRank(digit) < digitRank(match))) match = digit;
  }
  return match;
}
