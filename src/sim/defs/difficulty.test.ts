import {describe, expect, it} from 'vitest';
import {ADVICE_RANGES} from '../../ai/advice.ts';
import {AI_PACING, AI_INTEL} from '../systems/ai.ts';
import {
  AI_STRATEGIES,
  AI_STRATEGY_ORDER,
  type AiStrategy,
} from './aiStrategies.ts';
import {
  applyDifficulty,
  DEFAULT_SCOUT_REFRESH,
  DIFFICULTIES,
  DIFFICULTY_KEYS,
  DIFFICULTY_ORDER,
  difficultyOf,
  parseDifficultyId,
  scaleDecisionInterval,
  scaleFirstRaidTick,
  scaleStartSerfs,
  scaleStartStock,
  type DifficultyId,
} from './difficulty.ts';
import * as DifficultyIdNs from './difficultyEnum.ts';
import * as GoodId from './goodIdEnum.ts';

const PLAYBOOKS = AI_STRATEGY_ORDER.map(id => AI_STRATEGIES[id]);
const TIERS: DifficultyId[] = DIFFICULTY_ORDER;

describe('the difficulty table', () => {
  it('leaves a normal match byte-for-byte the printed game', () => {
    for (const s of PLAYBOOKS) {
      // Reference equality, not deep equality: the whole promise of the
      // default tier is that nothing happens to it, and a fresh object
      // with the same numbers in it is a chance for something to.
      expect(applyDifficulty(s, DifficultyIdNs.normal)).toBe(s);
      expect(applyDifficulty(s, undefined)).toBe(s);
    }
    expect(scaleStartStock({[GoodId.wood]: 36}, undefined)).toEqual({
      [GoodId.wood]: 36,
    });
    expect(scaleStartSerfs(8, undefined)).toBe(8);
    expect(scaleFirstRaidTick(16_200, undefined)).toBe(16_200);
    expect(scaleDecisionInterval(20, undefined)).toBe(20);
  });

  it('orders the tiers by the knobs that decide a march', () => {
    for (const s of PLAYBOOKS) {
      const easy = applyDifficulty(s, DifficultyIdNs.easy);
      const hard = applyDifficulty(s, DifficultyIdNs.hard);
      // Easy musters later and marches less often than hard, on every
      // playbook — the one ordering a difficulty setting has to keep.
      expect(easy.armyAttackSize).toBeGreaterThan(hard.armyAttackSize);
      expect(easy.attackCooldown).toBeGreaterThan(hard.attackCooldown);
      expect(easy.serfTarget).toBeLessThan(hard.serfTarget);
      expect(easy.marchConfidence).toBeGreaterThan(hard.marchConfidence);
      expect(easy.harass).toBeUndefined();
    }
  });

  it('only ever slows a seat down, never speeds one up', () => {
    // The stagger invariant: two brains must never think on the same tick,
    // which holds for any interval at or above the printed one and breaks
    // below it (seats 0 and 2 collide at 10). See
    // Difficulty.decisionIntervalPct.
    const {decisionInterval, seatStagger} = AI_PACING;
    for (const tier of TIERS) {
      const interval = scaleDecisionInterval(decisionInterval, tier);
      expect(interval).toBeGreaterThanOrEqual(decisionInterval);
      const offsets = new Set(
        [0, 1, 2, 3].map(seat => (seat * seatStagger) % interval),
      );
      expect(offsets.size).toBe(4);
    }
    expect(scaleDecisionInterval(20, DifficultyIdNs.easy)).toBe(40);
  });

  it('never lets hard delete a playbook’s refusals', () => {
    // The table's stated rule: easy may soften anything, hard may only
    // sharpen what a playbook already does. The abbot refuses to harass
    // and the steward turns a losing march for home; both refusals are
    // meant to read through the fog, so the hardest setting in the game
    // keeps them.
    for (const s of PLAYBOOKS) {
      const hard = applyDifficulty(s, DifficultyIdNs.hard);
      expect(hard.retreats).toBe(s.retreats);
      expect(hard.prefersRivals).toBe(s.prefersRivals);
      if (!s.harass) expect(hard.harass).toBeUndefined();
      else expect(hard.harass!.size).toBeGreaterThan(s.harass.size);
    }
  });

  it('keeps every knob inside the ranges an advisor is held to', () => {
    // Not the same table (see CLAMP's note), but they agree where they
    // overlap, and a tier that walked outside them would be steering the
    // brain somewhere no advisor is allowed to.
    const numeric = [
      'serfTarget',
      'armyAttackSize',
      'attackCooldown',
      'homeGuard',
      'barracksQueueDepth',
      'houseLimit',
      'housingHeadroom',
      'researchReserve',
    ] as const;
    for (const s of PLAYBOOKS) {
      for (const tier of TIERS) {
        const out = applyDifficulty(s, tier);
        for (const key of numeric) {
          const [lo, hi] = ADVICE_RANGES[key];
          expect(
            out[key],
            `${DIFFICULTY_KEYS[tier]}/${key}`,
          ).toBeGreaterThanOrEqual(lo);
          expect(
            out[key],
            `${DIFFICULTY_KEYS[tier]}/${key}`,
          ).toBeLessThanOrEqual(hi);
        }
        // A village told to keep fewer hands than its own panic floor is
        // not an easier opponent, it is an incoherent one.
        expect(out.serfTarget).toBeGreaterThanOrEqual(out.survivalFloor);
        expect(out.marchConfidence).toBeGreaterThanOrEqual(0);
        expect(out.marchConfidence).toBeLessThanOrEqual(90);
        // Only off the default tier: `normal` hands the playbook straight
        // back, so a playbook that prints no re-scout clock still has none
        // — which is the identity promise, not a gap.
        if (tier !== DifficultyIdNs.normal) {
          expect(out.scoutRefreshAfter).toBeGreaterThan(0);
        } else {
          expect(out.scoutRefreshAfter).toBe(s.scoutRefreshAfter);
        }
      }
    }
  });

  it('pins the scout-refresh default it copies out of the brain', () => {
    // defs/ cannot import systems/ai.ts (that file reads this one), so the
    // constant is copied. This is the pin that keeps the copy honest.
    expect(DEFAULT_SCOUT_REFRESH).toBe(AI_INTEL.refreshAfter);
  });

  it('scales a commission’s opening without emptying it', () => {
    const larder = {[GoodId.wood]: 36, [GoodId.hammer]: 1, [GoodId.gold]: 0};
    const easy = scaleStartStock(larder, DifficultyIdNs.easy);
    const hard = scaleStartStock(larder, DifficultyIdNs.hard);
    expect(easy[GoodId.wood]!).toBeGreaterThan(36);
    expect(hard[GoodId.wood]!).toBeLessThan(36);
    // A good the recipe lists at all still arrives: a commission teaches
    // the same lesson at every tier, it just gives less room to learn it.
    expect(hard[GoodId.hammer]).toBe(1);
    // ...and one it lists as nothing stays nothing.
    expect(hard[GoodId.gold]).toBe(0);
    expect(scaleStartSerfs(6, DifficultyIdNs.hard)).toBe(5);
    expect(scaleStartSerfs(2, DifficultyIdNs.hard)).toBe(2);
    expect(scaleFirstRaidTick(1000, DifficultyIdNs.easy)).toBe(1500);
    expect(scaleFirstRaidTick(1000, DifficultyIdNs.hard)).toBe(700);
  });

  it('reads a tier off the wire and refuses everything else', () => {
    expect(parseDifficultyId('hard')).toBe(DifficultyIdNs.hard);
    expect(parseDifficultyId(DifficultyIdNs.easy)).toBe(DifficultyIdNs.easy);
    expect(parseDifficultyId('nonesuch')).toBeUndefined();
    expect(parseDifficultyId(99)).toBeUndefined();
    expect(parseDifficultyId(null)).toBeUndefined();
    expect(parseDifficultyId('constructor')).toBeUndefined();
    expect(difficultyOf(undefined)).toBe(DIFFICULTIES[DifficultyIdNs.normal]);
  });

  it('spells every tier and lists them easiest first', () => {
    expect(DIFFICULTY_ORDER).toEqual([
      DifficultyIdNs.easy,
      DifficultyIdNs.normal,
      DifficultyIdNs.hard,
    ]);
    for (const id of DIFFICULTY_ORDER) {
      expect(DIFFICULTY_KEYS[id]).toBeTruthy();
      expect(DIFFICULTIES[id].id).toBe(id);
      expect(parseDifficultyId(DIFFICULTY_KEYS[id])).toBe(id);
    }
  });

  it('applies over a stance rather than under it', () => {
    // The ordering applyDifficulty exists for: the five knobs a stance sets
    // are the five a tier most wants to move, so the tier scales the mood
    // the seat is actually in. Standing in for the brain's compose here —
    // a siege mood over the steward, then the tier.
    const s = AI_STRATEGIES[AI_STRATEGY_ORDER[0]!];
    const mood: AiStrategy = {...s, armyAttackSize: 12, attackCooldown: 400};
    expect(applyDifficulty(mood, DifficultyIdNs.easy).armyAttackSize).toBe(15);
    expect(applyDifficulty(mood, DifficultyIdNs.hard).armyAttackSize).toBe(10);
    expect(applyDifficulty(mood, DifficultyIdNs.easy).attackCooldown).toBe(700);
  });
});
