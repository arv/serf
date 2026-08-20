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

/**
 * The 0–9 a keypress means, or null for anything else.
 *
 * `code` first here, which is the opposite of keyLetter's rule in
 * controls.ts and for the very reason keyLetter gives. Shift is half of
 * this binding, and Shift+1 arrives as `!` on a US layout, `1` on a French
 * one, `˘` on a Czech one: `key` stops being the number printed on the
 * keycap the moment a modifier joins in. `code` is that number, on every
 * layout that puts one on the number row. `key` still backstops it for the
 * input paths that report no `code` at all, and the numpad is taken too —
 * someone reaching for 1 with their right hand means the same 1.
 */
export function keyDigit(e: Pick<KeyboardEvent, 'code' | 'key'>): number | null {
  const c = e.code;
  const tail =
    c.length === 6 && c.startsWith('Digit')
      ? c[5]!
      : c.length === 7 && c.startsWith('Numpad')
        ? c[6]!
        : c === '' && e.key.length === 1
          ? e.key
          : '';
  return tail >= '0' && tail <= '9' ? tail.charCodeAt(0) - 48 : null;
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
