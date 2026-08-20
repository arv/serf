import { describe, expect, it } from 'vitest';
import { ARCHETYPE, classifyRival, readOpponent } from './archetype.ts';
import type { AiWorldSummary, RivalSummary } from './summary.ts';

/**
 * The classifier is a pure function of one rival's line in the summary, and
 * these are literal objects — no world, no sim, no fixture. That is the
 * whole reason it is a separate module: what an archetype means can be
 * argued about in a test file instead of inside a 40-minute sweep.
 *
 * What is pinned here is the shape of the judgement, not its thresholds:
 * ignorance stays ignorance, a raid outranks everything, and a seat that
 * has not looked never gets to call an opponent peaceful.
 */

function rival(over: Partial<RivalSummary> = {}): RivalSummary {
  return {
    id: 1,
    alive: true,
    found: true,
    buildings: 12,
    distance: 40,
    intel: null,
    contact: { firstSoldierMin: -1, firstAttackMin: -1, buildingsAtFive: -1 },
    ...over,
  };
}

function intel(total: number, peak = total): RivalSummary['intel'] {
  return { ageTicks: 200, heavy: total, light: 0, ranged: 0, total, peak };
}

describe('classifyRival', () => {
  it('has no opinion before the seat has had time to look', () => {
    const seen = rival({ intel: intel(6) });
    expect(classifyRival(seen, ARCHETYPE.readableFrom - 1)).toBe('unknown');
    expect(classifyRival(seen, ARCHETYPE.readableFrom)).not.toBe('unknown');
  });

  it('has no opinion about a rival that is already dead', () => {
    expect(classifyRival(rival({ alive: false, intel: intel(9) }), 10)).toBe('unknown');
  });

  it('calls a force at the gates a rush, whatever else they were doing', () => {
    const raided = rival({
      buildings: 20,
      intel: intel(0),
      contact: { firstSoldierMin: 3, firstAttackMin: 6, buildingsAtFive: 14 },
    });
    expect(classifyRival(raided, 8)).toBe('rusher');
  });

  it('does not call a late march a rush — every seat attacks eventually', () => {
    const late = rival({
      intel: intel(0),
      contact: { firstSoldierMin: 3, firstAttackMin: ARCHETYPE.rushBefore + 1, buildingsAtFive: 14 },
    });
    expect(classifyRival(late, 20)).not.toBe('rusher');
  });

  it('reads soldiers without a village behind them as a rush', () => {
    const lean = rival({ buildings: ARCHETYPE.village - 1, intel: intel(ARCHETYPE.force) });
    expect(classifyRival(lean, 8)).toBe('rusher');
  });

  it('reads a village with no army as booming', () => {
    const fat = rival({ buildings: ARCHETYPE.village, intel: intel(ARCHETYPE.quiet) });
    expect(classifyRival(fat, 8)).toBe('booming');
  });

  it('reads an army that has never come at us as turtling', () => {
    const armed = rival({ buildings: ARCHETYPE.village + 4, intel: intel(ARCHETYPE.force + 2) });
    expect(classifyRival(armed, 8)).toBe('turtling');
  });

  it('refuses to call an unscouted rival peaceful — that is our ignorance, not their choice', () => {
    const hidden = rival({ found: false, buildings: 0, intel: null });
    expect(classifyRival(hidden, 12)).toBe('unknown');
  });

  it('reads a stale picture as no army rather than as no evidence', () => {
    // intel goes null once the last look outlives its trust window; with
    // their village on the map that is a quiet neighbour, not a mystery.
    const stale = rival({ intel: null, buildings: ARCHETYPE.village + 2 });
    expect(classifyRival(stale, 12)).toBe('booming');
  });

  it('uses the peak, not the fading roster — the peak is the accurate one', () => {
    const emptying = rival({ buildings: ARCHETYPE.village + 2, intel: intel(0, ARCHETYPE.force) });
    expect(classifyRival(emptying, 8)).toBe('turtling');
  });
});

describe('readOpponent', () => {
  function summary(rivals: RivalSummary[], minutes = 8): AiWorldSummary {
    return {
      tick: minutes * 60 * 20,
      minutes,
      explored: 0.4,
      seat: { id: 0, strategyId: 'steward', knobs: {} as AiWorldSummary['seat']['knobs'] },
      me: {
        stock: {},
        serfs: 12,
        pop: 20,
        popCap: 30,
        buildings: {},
        army: { knight: 4, spearman: 0, archer: 0 },
        researched: [],
        researching: null,
        underAttack: false,
      },
      rivals,
      bandits: { camps: 0, nearestCamp: -1 },
    };
  }

  it('is unknown on an empty board', () => {
    expect(readOpponent(summary([]))).toBe('unknown');
  });

  it('takes the loudest rival, not the first', () => {
    const quiet = rival({ id: 1, buildings: 14, intel: intel(0) });
    const armed = rival({ id: 2, buildings: 14, intel: intel(5) });
    expect(readOpponent(summary([quiet, armed]))).toBe('turtling');
    const rushing = rival({
      id: 3,
      contact: { firstSoldierMin: 2, firstAttackMin: 5, buildingsAtFive: 4 },
    });
    expect(readOpponent(summary([quiet, armed, rushing]))).toBe('rusher');
  });

  it('ignores the dead, however they played', () => {
    const corpse = rival({
      id: 1,
      alive: false,
      contact: { firstSoldierMin: 2, firstAttackMin: 4, buildingsAtFive: 2 },
    });
    expect(readOpponent(summary([corpse]))).toBe('unknown');
  });
});
