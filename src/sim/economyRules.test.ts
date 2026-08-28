import type { Enum } from '../shared/enum.ts';
import { describe, expect, it } from 'vitest';
import {
  ALL_ECONOMY_RULES,
  ECONOMY_RULES,
  runEconomyRules,
  type EconomyRule,
  type RuleContext,
} from './economyRules.ts';
import type { SimCommand } from './commands.ts';
import * as EconomyRuleId from './economyRuleIdEnum.ts';
import * as CommandKind from './commandKindEnum.ts';
import * as RulePhase from './rulePhaseEnum.ts';

type EconomyRuleId = Enum<typeof EconomyRuleId>;

/**
 * The rules themselves are covered where they can be seen working — against
 * a real world, in ai.test.ts. What is covered here is the runner, because
 * composition is the whole reason this layer exists and the two things that
 * keep composition honest (claims and groups) have no other home.
 */

const ctx = {} as RuleContext;
const all = new Set<EconomyRuleId>(ALL_ECONOMY_RULES);

/** Three real rule ids, standing in as 'a', 'b' and 'c' did while an id was
 * a free-form string. Which three does not matter — the table machinery
 * only ever compares them. */
const A = EconomyRuleId.resiteExtractor;
const B = EconomyRuleId.freeCappedHauler;
const C = EconomyRuleId.resumeDrainedPost;

/** A stand-in rule: fires unconditionally, claims what it is told to. */
function stub(id: EconomyRuleId, claims: number[], group?: string): EconomyRule {
  return {
    id,
    when: 'always, for the test',
    phase: RulePhase.recovery,
    ...(group !== undefined ? { group } : {}),
    fire: () => ({
      commands: [{ kind: CommandKind.sellBuilding, buildingId: claims[0] ?? 0 } as SimCommand],
      claims,
    }),
  };
}

/** The real runner over a table of stand-ins — the point being that this
 * exercises `runEconomyRules` rather than a second copy of its logic. */
function runTable(table: EconomyRule[], enabled?: EconomyRuleId[]) {
  const on = new Set<EconomyRuleId>((enabled ?? table.map((r) => r.id)) as EconomyRuleId[]);
  return runEconomyRules(ctx, on, RulePhase.recovery, table);
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

  it('runs only the phase it is asked for', () => {
    // Phases exist because command order inside a tick is load-bearing, so a
    // rule leaking into the wrong one is a real bug, not a tidiness issue.
    const table = [stub(A, [1]), { ...stub(B, [2]), phase: RulePhase.production }];
    expect(runTable(table).fired).toEqual([A]);
  });
});

describe('composition', () => {
  it('lets rules in different groups answer the same beat', () => {
    // The point of the layer: a cascade would have run only the first.
    const { fired } = runTable([stub(A, [1]), stub(B, [2])]);
    expect(fired).toEqual([A, B]);
  });

  it('keeps one rule per group, so alternatives stay alternatives', () => {
    // How the two stall-recovery rules keep the first-wins behaviour they
    // were measured with.
    const { fired } = runTable([stub(A, [1], 'g'), stub(B, [2], 'g'), stub(C, [3])]);
    expect(fired).toEqual([A, C]);
  });

  it('will not let two rules order the same building in one beat', () => {
    const { fired } = runTable([stub(A, [7]), stub(B, [7])]);
    expect(fired).toEqual([A]);
  });

  it('yields only the conflicting rule, not the ones after it', () => {
    const { fired } = runTable([stub(A, [7]), stub(B, [7]), stub(C, [9])]);
    expect(fired).toEqual([A, C]);
  });

  it('orders commands by the table, not by when a rule happened to fire', () => {
    const { commands } = runTable([stub(A, [1]), stub(B, [2])]);
    expect(commands.map((c) => (c.kind === CommandKind.sellBuilding ? c.buildingId : -1))).toEqual([
      1, 2,
    ]);
  });
});

describe('the ablation handle', () => {
  it('runs nothing at all when the set is empty', () => {
    const out = runEconomyRules(
      { ...ctx, stalled: true } as RuleContext,
      new Set(),
      RulePhase.recovery,
    );
    expect(out.commands).toEqual([]);
    expect(out.fired).toEqual([]);
  });

  it('runs only what it is given', () => {
    const { fired } = runTable([stub(A, [1]), stub(B, [2])], [B]);
    expect(fired).toEqual([B]);
  });

  it('reports which rules fired, so a null result is diagnosable', () => {
    // A rule that never fires and a rule that fires without helping produce
    // the same win rate — telling them apart is what this is for.
    const { fired } = runTable([stub(A, [1], 'g'), stub(B, [2], 'g')]);
    expect(fired).toEqual([A]);
  });
});

describe('the real rules stay quiet on a healthy seat', () => {
  /** A seat with its people, its buildings, and nothing wrong. */
  const healthy = {
    world: { units: new Map(), map: {} },
    owner: 0,
    mine: [],
    stock: {},
    serfCount: 3,
    stalled: false,
    strategy: { survivalFloor: 3 },
  } as unknown as RuleContext;

  it('fires nothing when the watchdog reads no stall', () => {
    // What keeps an unstalled game byte-identical to the one before this
    // layer existed. Two of the rules are not stall-gated any more — a
    // village short of hands is a dead end rather than evidence of one — so
    // the guard that has to hold here is theirs: a seat with its people is
    // never taken apart for a hauler, and its barracks is never stood down.
    // Which side of THAT gate a reading falls on is covered against a real
    // world in ai.test.ts, where there are buildings to order around.
    expect(runEconomyRules(healthy, all, RulePhase.recovery).fired).toEqual([]);
    expect(runEconomyRules(healthy, all, RulePhase.production).fired).toEqual([]);
  });
});
