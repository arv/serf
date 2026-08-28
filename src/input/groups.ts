import type {Enum} from '../shared/enum.ts';
import * as ControlGroupKindNs from './controlGroupKindEnum.ts';

export type ControlGroupKind = Enum<typeof ControlGroupKindNs>;

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
export function keyDigit(
  e: Pick<KeyboardEvent, 'code' | 'key'>,
): number | null {
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

/**
 * What a number holds. A group is people *or* a building, never both,
 * because the selection it stamps is: this game selects a band of people or
 * a single building, and no gesture produces both at once. Recall has to
 * know which it is answering with — one path sets the selection, the other
 * opens a card — so the two are told apart here rather than guessed at from
 * an id, even though units and buildings do draw from one id pool.
 *
 * The building case is the one the number row was missing. A barracks, a
 * smithy or the castle is a place a player goes back to over and over to
 * spend what the economy just made, and walking the camera back to it every
 * time is the tax this lifts: Ctrl+4 on the barracks, and from then on 4
 * opens its card wherever the fighting has taken the view.
 */
export type ControlGroup =
  | {readonly kind: ControlGroupKindNs.units; readonly ids: Set<number>}
  | {readonly kind: ControlGroupKindNs.building; readonly id: number};

/**
 * A group nobody would miss — never stamped, or emptied by casualties.
 *
 * Two bindings ask: recall, which refuses rather than answer with nothing,
 * and Shift's stamp, which will take a free number but not overwrite a
 * taken one. A building group is never empty; it is either its building or
 * it has been dropped whole.
 */
export function groupEmpty(group: ControlGroup | undefined): boolean {
  return (
    group === undefined ||
    (group.kind === ControlGroupKindNs.units && group.ids.size === 0)
  );
}

/** Group numbers in the order a player reads them: 1 first, 0 last. */
function digitRank(d: number): number {
  return d === 0 ? 10 : d;
}

/**
 * Which group this selection *is* — the lowest-numbered one it matches
 * exactly, or null. `building` is the id of the open building card, when
 * one is open, and then it is the whole selection: the two are mutually
 * exclusive on screen, so a building card can only ever be a building
 * group, and a band of people can only ever be a unit group.
 *
 * Recomputed from scratch on every selection change rather than remembered,
 * so a selection edited after the fact — a shift-click, a casualty, a band
 * drag over the same ground — stops claiming to be a group it is no longer
 * equal to. An empty selection with no card open is nobody's group,
 * whatever the groups hold.
 */
export function matchingGroup(
  groups: ReadonlyMap<number, ControlGroup>,
  selection: ReadonlySet<number>,
  building: number | null,
): number | null {
  let match: number | null = null;
  // Groups are stamped in press order, so the map's iteration order is not
  // the player's: 1 wins over 5 however they came to be made.
  const better = (digit: number) =>
    match === null || digitRank(digit) < digitRank(match);
  if (building !== null) {
    for (const [digit, group] of groups) {
      if (
        group.kind === ControlGroupKindNs.building &&
        group.id === building &&
        better(digit)
      )
        match = digit;
    }
    return match;
  }
  if (selection.size === 0) return null;
  for (const [digit, group] of groups) {
    if (
      group.kind !== ControlGroupKindNs.units ||
      group.ids.size !== selection.size
    )
      continue;
    let same = true;
    for (const id of group.ids) {
      if (!selection.has(id)) {
        same = false;
        break;
      }
    }
    if (same && better(digit)) match = digit;
  }
  return match;
}
