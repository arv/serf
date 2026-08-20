import { describe, expect, it } from 'vitest';
import {
  ALL_ECONOMY_RULES,
  ECONOMY_RULES,
  runEconomyRules,
  type EconomyRule,
  type EconomyRuleId,
  type RuleContext,
} from './economyRules.ts';
import type { SimCommand } from './commands.ts';

/**
 * The rules themselves are covered where they can be seen working — against
 * a real world, in ai.test.ts. What is covered here is the runner, because
 * composition is the whole reason this layer exists and the two things that
 * keep composition honest (claims and groups) have no other home.
 */

const ctx = {} as RuleContext;
const all = new Set<EconomyRuleId>(ALL_ECONOMY_RULES);

/** A stand-in rule: fires unconditionally, claims what it is told to. */
function stub(id: string, claims: number[], group?: string): EconomyRule {
  return {
    id: id as EconomyRuleId,
    when: 'always, for the test',
    ...(group !== undefined ? { group } : {}),
    fire: () => ({
      commands: [{ kind: 'sellBuilding', buildingId: claims[0] ?? 0 } as SimCommand],
      claims,
    }),
  };
}

/** The real runner over a table of stand-ins — the point being that this
 * exercises `runEconomyRules` rather than a second copy of its logic. */
function runTable(table: EconomyRule[], enabled?: EconomyRuleId[]) {
  const on = new Set<EconomyRuleId>((enabled ?? table.map((r) => r.id)) as EconomyRuleId[]);
  return runEconomyRules(ctx, on, table);
}

describe('the rule table', () => {
  it('names every rule it can run, so nothing fires unablatable', () => {
    expect([...ALL_ECONOMY_RULES].sort()).toEqual(ECONOMY_RULES.map((r) => r.id).sort());
  });

  it('has no duplicate ids — an id is how a sweep addresses a rule', () => {
    expect(new Set(ALL_ECONOMY_RULES).size).toBe(ALL_ECONOMY_RULES.length);
  });

  it('gives every rule a one-line situation', () => {
    for (const rule of ECONOMY_RULES) {
      expect(rule.when.length, `${rule.id} needs a when`).toBeGreaterThan(0);
    }
  });
});

describe('composition', () => {
  it('lets rules in different groups answer the same beat', () => {
    // The point of the layer: a cascade would have run only the first.
    const { fired } = runTable([stub('a', [1]), stub('b', [2])]);
    expect(fired).toEqual(['a', 'b']);
  });

  it('keeps one rule per group, so alternatives stay alternatives', () => {
    // How the two stall-recovery rules keep the first-wins behaviour they
    // were measured with.
    const { fired } = runTable([stub('a', [1], 'g'), stub('b', [2], 'g'), stub('c', [3])]);
    expect(fired).toEqual(['a', 'c']);
  });

  it('will not let two rules order the same building in one beat', () => {
    const { fired } = runTable([stub('a', [7]), stub('b', [7])]);
    expect(fired).toEqual(['a']);
  });

  it('yields only the conflicting rule, not the ones after it', () => {
    const { fired } = runTable([stub('a', [7]), stub('b', [7]), stub('c', [9])]);
    expect(fired).toEqual(['a', 'c']);
  });

  it('orders commands by the table, not by when a rule happened to fire', () => {
    const { commands } = runTable([stub('a', [1]), stub('b', [2])]);
    expect(commands.map((c) => (c.kind === 'sellBuilding' ? c.buildingId : -1))).toEqual([1, 2]);
  });
});

describe('the ablation handle', () => {
  it('runs nothing at all when the set is empty', () => {
    const out = runEconomyRules({ ...ctx, stalled: true } as RuleContext, new Set());
    expect(out.commands).toEqual([]);
    expect(out.fired).toEqual([]);
  });

  it('runs only what it is given', () => {
    const { fired } = runTable([stub('a', [1]), stub('b', [2])], ['b' as EconomyRuleId]);
    expect(fired).toEqual(['b']);
  });

  it('reports which rules fired, so a null result is diagnosable', () => {
    // A rule that never fires and a rule that fires without helping produce
    // the same win rate — telling them apart is what this is for.
    const { fired } = runTable([stub('a', [1], 'g'), stub('b', [2], 'g')]);
    expect(fired).toEqual(['a']);
  });
});

describe('the real rules stay quiet on a healthy seat', () => {
  it('fires nothing when the watchdog reads no stall', () => {
    // Both shipped rules are stall-gated, which is what keeps an unstalled
    // game byte-identical to the one before this layer existed.
    const healthy = {
      world: { units: new Map(), map: {} },
      owner: 0,
      mine: [],
      stock: {},
      serfCount: 3,
      stalled: false,
    } as unknown as RuleContext;
    expect(runEconomyRules(healthy, all).fired).toEqual([]);
  });
});
