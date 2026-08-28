/**
 * Where a shortcut letter goes inside its own label.
 *
 * Split out of shortcut.tsx so it can be tested at all: that file reaches
 * for `hasKeyboard()`, which reads `window.matchMedia` at module load, and
 * the suite runs headless node. This half is the half with a decision in
 * it, and it is now pinned.
 */
export type ShortcutLabel =
  /** No shortcut to show — render the label and nothing else. */
  | {kind: 'none'}
  /** The letter lives in the label: bold it where it stands. */
  | {kind: 'split'; before: string; letter: string; after: string}
  /** A key the label does not contain — append it in parentheses: "Foo (Q)". */
  | {kind: 'appended'; key: string};

export function shortcutLabel(label: string, k: string): ShortcutLabel {
  // The empty key is how buildKey/trainKey say "this thing has no
  // shortcut", and it has to be caught before indexOf ever sees it:
  // `'House'.indexOf('')` is 0, not -1, so the naive check reads a missing
  // key as a letter found at position zero and boldly highlights the H of a
  // shortcut that does not exist. Worse than showing nothing, because it
  // teaches a keypress that does nothing.
  if (k === '') return {kind: 'none'};
  const at = label.toLowerCase().indexOf(k.toLowerCase());
  if (at < 0) return {kind: 'appended', key: k.toUpperCase()};
  return {
    kind: 'split',
    before: label.slice(0, at),
    letter: label.slice(at, at + 1),
    after: label.slice(at + 1),
  };
}
