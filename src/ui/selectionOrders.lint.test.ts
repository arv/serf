import {describe, expect, it} from 'vitest';

/**
 * Every order on the selection card is somebody's to give.
 *
 * This was a free property for as long as the pointer could only reach
 * your own things: a card was on screen because you had selected one of
 * your buildings, so a Train button on it was yours by construction, and
 * only the repair/pause/sell row ever said `mine()` out loud. Watching a
 * replay the card may be the Warlord's barracks or the bandits' camp, and
 * a row that never asked whose it is would offer orders that were never on
 * the table — the castle's Hire is the sharpest case, since onHire carries
 * no building id at all and would spend YOUR silver from a rival's card.
 *
 * So it is checked rather than remembered. The rule: every props.on*
 * handler in SelectionPanel sits inside a guard that is either `mine()`
 * (a building of yours) or `!replayMode()` (a squad you can still order).
 * `onDeselect` is exempt — letting go is an order to nobody.
 *
 * Ancestry is read off the indentation, which oxfmt fixes. If this ever
 * fails on a row that IS properly guarded, the guard is probably spelled
 * some third way; add it to GUARDS rather than deleting the case.
 */
const SOURCES = import.meta.glob('./SelectionPanel.tsx', {
  query: '?raw',
  import: 'default',
  eager: true,
});

/** A guard that answers "may this client give this order at all?" */
const GUARDS = /\bmine\(\)|\bhasOrders\(\)|!replayMode\(\)/;
/** Letting go is not an order. */
const EXEMPT = new Set(['onDeselect']);

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

/**
 * The source with every wrapped `<Show …>` tag collapsed onto its opening
 * line, the lines it spanned left blank.
 *
 * Without this the walk below reads a wrapped tag's closing `>` — which
 * oxfmt puts back at the tag's own indent — as the nearest ancestor, and
 * then skips the `<Show` sitting at that same indent one line further up:
 * the guard is right there and goes unseen. Collapsing first means an
 * opening tag is exactly one line wherever it appears.
 */
function collapseTags(lines: readonly string[]): string[] {
  const out = [...lines];
  for (let i = 0; i < out.length; i++) {
    const line = out[i]!;
    if (!line.trimStart().startsWith('<Show') || line.trimEnd().endsWith('>'))
      continue;
    const indent = indentOf(line);
    const parts = [line];
    for (let k = i + 1; k < out.length; k++) {
      parts.push(out[k]!);
      const done = indentOf(out[k]!) <= indent && out[k]!.trim().endsWith('>');
      out[k] = '';
      if (done) break;
    }
    out[i] = parts.join(' ');
  }
  return out;
}

describe('selection card order lint', () => {
  it('offers no order without asking whose it is', () => {
    const raw = Object.values(SOURCES)[0] as string;
    expect(raw, 'SelectionPanel.tsx not found').toBeTruthy();
    const lines = raw.split('\n');
    const tags = collapseTags(lines);
    const offenders: string[] = [];

    for (const [i, line] of lines.entries()) {
      const m = /props\.(on[A-Z]\w*)\(/.exec(line);
      if (!m || EXEMPT.has(m[1]!)) continue;
      // Walk out through the enclosing <Show …> tags — each at a shallower
      // indent than the last — and see whether any of them asks whose
      // this is.
      let indent = indentOf(line);
      let guarded = false;
      for (let j = i - 1; j >= 0 && !guarded; j--) {
        const outer = tags[j]!;
        if (outer.trim() === '') continue;
        const oi = indentOf(outer);
        if (oi >= indent) continue;
        indent = oi;
        if (outer.includes('<Show')) guarded = GUARDS.test(outer);
      }
      if (!guarded) offenders.push(`${i + 1}: ${line.trim()}`);
    }

    expect(offenders, offenders.join('\n')).toEqual([]);
  });
});
