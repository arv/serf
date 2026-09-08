import {describe, expect, it} from 'vitest';
import * as TechBranchNs from '../sim/defs/techBranchEnum.ts';
import * as TechNodeStateNs from '../ui/techNodeStateEnum.ts';

/**
 * The tech panel names its own states out loud.
 *
 * Both of this panel's vocabularies are JS enum modules, whose values are
 * numbers rather than the words — and both were once read as if they were
 * the words. `BRANCH_LABELS[branch]` was keyed by 'agriculture' and looked
 * up with 1, so every column heading rendered empty; the node's
 * `classList` spread the state value straight in, so a node went out
 * wearing `class="3 tech-node"` and NONE of the .tech-node.available /
 * .locked / .done / .researching / .delivering rules below it ever
 * matched. Nothing threw and nothing failed a typecheck: the panel simply
 * drew every node identically, the study in hand included.
 *
 * A Record over the enum (see TechTreePanel) makes the totality half of
 * that a compile error. This is the other half — that the class each state
 * maps to is a class the stylesheet actually styles, which no type can
 * say. Read off the source text, because the mapping and the rules are
 * both in this one file and neither is exported.
 */
const SOURCES = import.meta.glob('./TechTreePanel.tsx', {
  query: '?raw',
  import: 'default',
  eager: true,
});
const SRC = Object.values(SOURCES)[0] as string;

/** `[TechNodeStateNs.available]: 'available',` → available → 'available' */
function mapping(record: string): Map<string, string> {
  const body = SRC.split(`const ${record}: Record<`)[1] ?? '';
  const out = new Map<string, string>();
  for (const m of body
    .slice(0, body.indexOf('};'))
    .matchAll(/\[\w+\.(\w+)\]:\s*'([^']+)'/g)) {
    out.set(m[1]!, m[2]!);
  }
  return out;
}

describe('the tech panel’s enum-to-CSS mapping', () => {
  it('gives every node state a class the stylesheet styles', () => {
    const map = mapping('NODE_CLASS');
    expect([...map.keys()].sort()).toEqual(Object.keys(TechNodeStateNs).sort());
    for (const [state, cls] of map) {
      expect(
        SRC.includes(`.tech-node.${cls}`),
        `${state} maps to .${cls}, which no rule in TechTreePanel styles`,
      ).toBe(true);
    }
  });

  it('gives every branch a heading with words in it', () => {
    const map = mapping('BRANCH_LABELS');
    expect([...map.keys()].sort()).toEqual(Object.keys(TechBranchNs).sort());
    for (const label of map.values()) expect(label.trim()).not.toBe('');
  });

  it('never spreads a raw enum value into a class list', () => {
    // `[state(id)]: true` is the shape of the original bug: a numeric key
    // stringifies to "3" and quietly becomes a class nothing selects.
    expect(SRC).not.toMatch(/\[state\(\w+\)\]:/);
  });
});
