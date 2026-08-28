import {describe, expect, it} from 'vitest';
import type {Enum} from '../shared/enum.ts';
import {
  classHp,
  damagePerTick,
  headcount,
  powerOf,
  shouldCommit,
  survivingFraction,
  survivorsAfter,
  type Force,
} from './combatOdds.ts';
import {tallyClass} from './combatOdds.ts';
import * as UnitClass from './defs/unitClassEnum.ts';

type UnitClass = Enum<typeof UnitClass>;

/**
 * The predictor is judged against the game's own military triangle: the three
 * duels in combat.test.ts are ground truth for who beats whom, and a model
 * that disagrees with them is wrong no matter how tidy its algebra. The rest
 * covers the gate's edges — the cases where refusing a fight would be worse
 * than taking it.
 */

/** A force of one class at full health. */
function only(cls: UnitClass, n: number): Force {
  const force: Force = {heavy: 0, light: 0, ranged: 0, hp: n * classHp(cls)};
  for (let i = 0; i < n; i++) tallyClass(force, cls);
  return force;
}

function mixed(heavy: number, light: number, ranged: number): Force {
  return {
    heavy,
    light,
    ranged,
    hp:
      heavy * classHp(UnitClass.heavy) +
      light * classHp(UnitClass.light) +
      ranged * classHp(UnitClass.ranged),
  };
}

describe('the military triangle, as the predictor sees it', () => {
  it('gives heavy the edge over light', () => {
    const knights = only(UnitClass.heavy, 7);
    const spearmen = only(UnitClass.light, 7);
    expect(powerOf(knights, spearmen)).toBeGreaterThan(
      powerOf(spearmen, knights),
    );
  });

  it('gives light the edge over ranged', () => {
    const spearmen = only(UnitClass.light, 7);
    const archers = only(UnitClass.ranged, 7);
    expect(powerOf(spearmen, archers)).toBeGreaterThan(
      powerOf(archers, spearmen),
    );
  });

  it('gives ranged the edge over heavy, thin hit points and all', () => {
    const archers = only(UnitClass.ranged, 7);
    const knights = only(UnitClass.heavy, 7);
    expect(archers.hp).toBeLessThan(knights.hp); // 245 vs 560 — the table has to carry this
    expect(powerOf(archers, knights)).toBeGreaterThan(
      powerOf(knights, archers),
    );
  });

  it('still lets numbers tell against a kiting force', () => {
    // The kite correction must not make ranged unbeatable: enough heavy
    // soldiers run archers down, they just need a real edge to do it.
    const archers = only(UnitClass.ranged, 7);
    expect(shouldCommit(only(UnitClass.heavy, 7), archers, 30)).toBe(false);
    expect(shouldCommit(only(UnitClass.heavy, 16), archers, 30)).toBe(true);
  });

  it('calls a mirror match a coin flip', () => {
    for (const cls of [UnitClass.heavy, UnitClass.light, UnitClass.ranged]) {
      const a = only(cls, 7);
      expect(powerOf(a, a)).toBeCloseTo(powerOf(a, a));
      // A mirror match wins nothing: no survivors expected, so any appetite
      // above zero refuses it.
      expect(survivingFraction(a, a)).toBe(0);
      expect(shouldCommit(a, a, 1)).toBe(false);
      expect(shouldCommit(a, a, 0)).toBe(true);
    }
  });

  it('scales power with numbers, so eleven knights beat seven', () => {
    const few = only(UnitClass.heavy, 7);
    const many = only(UnitClass.heavy, 11);
    expect(powerOf(many, few)).toBeGreaterThan(powerOf(few, many));
    expect(shouldCommit(few, many, 30)).toBe(false);
    expect(shouldCommit(many, few, 30)).toBe(true);
  });
});

describe('composition weighting', () => {
  it('rates our knights higher the more of the enemy is light', () => {
    const knights = only(UnitClass.heavy, 8);
    // Same headcount and the same hp pool each time; only the mix moves.
    const mostlyRanged = mixed(0, 2, 6);
    const mostlyLight = mixed(0, 6, 2);
    expect(damagePerTick(knights, mostlyLight)).toBeGreaterThan(
      damagePerTick(knights, mostlyRanged),
    );
  });

  it('moves monotonically as the enemy mix shifts toward what we counter', () => {
    const knights = only(UnitClass.heavy, 8);
    let previous = -1;
    // Light is countered by heavy at 1.5; ranged resists it at 0.67. Trading
    // ranged for light should raise our damage at every step.
    for (let light = 0; light <= 8; light++) {
      const dps = damagePerTick(knights, mixed(0, light, 8 - light));
      expect(dps).toBeGreaterThan(previous);
      previous = dps;
    }
  });

  it('reads a force with no soldiers as harmless', () => {
    const knights = only(UnitClass.heavy, 7);
    const nobody: Force = {heavy: 0, light: 0, ranged: 0, hp: 0};
    expect(damagePerTick(nobody, knights)).toBe(0);
    expect(damagePerTick(knights, nobody)).toBe(0);
    expect(headcount(nobody)).toBe(0);
  });
});

describe('shouldCommit', () => {
  it('commits to anything at zero, which is every playbook default', () => {
    const doomed = only(UnitClass.light, 1);
    const host = only(UnitClass.heavy, 16);
    expect(shouldCommit(doomed, host, 0)).toBe(true);
  });

  it('commits against an undefended target rather than standing about', () => {
    const army = only(UnitClass.heavy, 3);
    const nobody: Force = {heavy: 0, light: 0, ranged: 0, hp: 0};
    expect(shouldCommit(army, nobody, 90)).toBe(true);
  });

  it('refuses the fight it would lose, and takes the one it would win', () => {
    const spearmen = only(UnitClass.light, 7);
    const knights = only(UnitClass.heavy, 7);
    expect(shouldCommit(spearmen, knights, 30)).toBe(false);
    expect(shouldCommit(knights, spearmen, 30)).toBe(true);
  });

  it('gets choosier as the appetite rises', () => {
    // Nine knights against seven: a real but not overwhelming edge, and the
    // scale should say so rather than reporting a landslide.
    const mine = only(UnitClass.heavy, 9);
    const theirs = only(UnitClass.heavy, 7);
    const share = survivingFraction(mine, theirs) * 100;
    expect(share).toBeGreaterThan(50);
    expect(share).toBeLessThan(70);
    expect(shouldCommit(mine, theirs, 50)).toBe(true);
    expect(shouldCommit(mine, theirs, 70)).toBe(false);
  });

  it('reads in headcount-shaped units, not squared ones', () => {
    // The whole reason the gate thresholds on survivors: power is quadratic,
    // so a 2:1 edge in bodies is 4:1 in power and no honest bar could be set
    // on it. As a surviving share the same fight lands somewhere sayable.
    const share =
      survivingFraction(only(UnitClass.heavy, 14), only(UnitClass.heavy, 7)) *
      100;
    expect(share).toBeGreaterThan(80);
    expect(share).toBeLessThan(100);
  });

  it('never refuses more as the odds improve', () => {
    const theirs = mixed(3, 3, 3);
    for (const odds of [10, 30, 50, 70, 90]) {
      let sawCommit = false;
      for (let n = 1; n <= 20; n++) {
        const commit = shouldCommit(only(UnitClass.heavy, n), theirs, odds);
        // Once it commits at some size it must commit at every larger one.
        if (commit) sawCommit = true;
        else
          expect(
            sawCommit,
            `odds ${odds} flipped back to refusing at ${n}`,
          ).toBe(false);
      }
    }
  });
});

describe('survivorsAfter', () => {
  it('reports nothing standing when the fight is lost', () => {
    expect(
      survivorsAfter(only(UnitClass.light, 7), only(UnitClass.heavy, 7)),
    ).toBe(0);
  });

  it('reports fewer survivors than went in, and more from a bigger edge', () => {
    const theirs = only(UnitClass.light, 7);
    const close = survivorsAfter(only(UnitClass.heavy, 8), theirs);
    const easy = survivorsAfter(only(UnitClass.heavy, 16), theirs);
    expect(close).toBeGreaterThan(0);
    expect(close).toBeLessThan(only(UnitClass.heavy, 8).hp);
    expect(easy).toBeGreaterThan(close);
  });

  it('leaves an unopposed force untouched', () => {
    const army = only(UnitClass.heavy, 5);
    const nobody: Force = {heavy: 0, light: 0, ranged: 0, hp: 0};
    // No enemy hp means no damage dealt either way; the model has nothing to
    // chew, so it reports no survivors rather than inventing a number.
    expect(survivorsAfter(army, nobody)).toBe(0);
  });
});
