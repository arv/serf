import {describe, expect, it} from 'vitest';
import {ADVICE_RANGES} from '../../ai/advice.ts';
import {AI_INTEL, AI_PACING, AI_STANCE, beatOffset} from '../systems/ai.ts';
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
  scaleIntelTrust,
  scaleMinSighting,
  scaleRaidCap,
  scaleRaidInterval,
  scaleStanceClock,
  scaleStartSerfs,
  scaleStartStock,
  type DifficultyId,
} from './difficulty.ts';
import * as DifficultyIdNs from './difficultyEnum.ts';
import * as GoodId from './goodIdEnum.ts';
import * as UnitTypeId from './unitTypeIdEnum.ts';

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
      expect(easy.houseLimit).toBeLessThan(hard.houseLimit);
      expect(easy.barracksQueueDepth).toBeLessThan(hard.barracksQueueDepth);
      // Easy arms everyone with the cheapest weapon in the game and waits
      // for a muster its own house limit will not let it reach — so it
      // never leaves its opening for the stance that takes a castle.
      expect(easy.trainPreference).toEqual([UnitTypeId.spearman]);
      expect(easy.stances.foundAfterArmy).toBeGreaterThan(
        hard.stances.foundAfterArmy ?? 0,
      );
    }
  });

  it('keeps two brains off the same tick at every tier', () => {
    // The invariant the beat stagger exists for. It used to hold only at or
    // above the printed cadence — a fixed stride wraps, and seats 0 and 2
    // collide at an interval of 10 — which is why the offsets are now
    // spread across whatever interval a tier sets (AI_PACING.seatSlots).
    // Checked over a range well past what any tier asks for, so the next
    // one cannot quietly break it.
    for (const tier of TIERS) {
      const interval = scaleDecisionInterval(AI_PACING.decisionInterval, tier);
      const offsets = new Set(
        [0, 1, 2, 3].map(seat => beatOffset(seat, interval)),
      );
      expect(offsets.size, `tier ${DIFFICULTY_KEYS[tier]}`).toBe(4);
    }
    for (let interval = 8; interval <= 80; interval++) {
      const offsets = new Set(
        [0, 1, 2, 3].map(seat => beatOffset(seat, interval)),
      );
      expect(offsets.size, `interval ${interval}`).toBe(4);
    }
    // The shipped tiers: easy is late, and nobody else moves.
    expect(scaleDecisionInterval(20, DifficultyIdNs.easy)).toBe(40);
    expect(scaleDecisionInterval(20, DifficultyIdNs.normal)).toBe(20);
    expect(scaleDecisionInterval(20, DifficultyIdNs.hard)).toBe(20);
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
      // Its arms and its stance cascade are its own, whole: `spearsOnly`
      // and `foundAfterArmy` are softening levers, and hard has neither.
      // (The Abbot's "wait for ten before you go" is exactly the kind of
      // trait hard would flatten, and it measured worse for doing it.)
      expect(hard.trainPreference).toEqual(s.trainPreference);
      expect(hard.weaponMix).toEqual(s.weaponMix);
      expect(hard.stances).toEqual(s.stances);
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

  it('slows what a seat remembers, and never what it can see', () => {
    // Memory and inference, never vision — the line that keeps `hard` from
    // being a cheat. Easy forgets a sighting sooner and needs a bigger
    // force before it believes in an army; hard remembers longer and acts
    // on thinner evidence. Neither sees one tile further than the other.
    const easy = DifficultyIdNs.easy;
    const hard = DifficultyIdNs.hard;
    expect(scaleIntelTrust(AI_INTEL.trustFor, easy)).toBeLessThan(
      AI_INTEL.trustFor,
    );
    expect(scaleIntelTrust(AI_INTEL.trustFor, hard)).toBeGreaterThan(
      AI_INTEL.trustFor,
    );
    expect(scaleMinSighting(AI_INTEL.minSighting, easy)).toBeGreaterThan(
      scaleMinSighting(AI_INTEL.minSighting, hard),
    );
    // Never below one: a seat that cannot believe in a single soldier has
    // no picture at all.
    expect(scaleMinSighting(1, easy)).toBeGreaterThanOrEqual(1);
    expect(scaleMinSighting(1, hard)).toBeGreaterThanOrEqual(1);
    // Normal is the printed game, here as everywhere.
    for (const printed of [AI_INTEL.trustFor, 1234]) {
      expect(scaleIntelTrust(printed, DifficultyIdNs.normal)).toBe(printed);
      expect(scaleIntelTrust(printed, undefined)).toBe(printed);
    }
    expect(scaleMinSighting(3, undefined)).toBe(3);
  });

  it('makes a mood slower to turn, without slowing the alarm', () => {
    // Both stance clocks move together — a mood re-read more often but held
    // just as long is a mood that still cannot change. The fortify break-in
    // is exempt inside the engine itself (systems/ai.ts #updateStance), so
    // even the sluggish tier still answers a hostile in the yard on the
    // beat; what gets slow is noticing that the situation has TURNED.
    for (const printed of [AI_STANCE.evalPeriod, AI_STANCE.dwell]) {
      expect(scaleStanceClock(printed, DifficultyIdNs.easy)).toBeGreaterThan(
        printed,
      );
      expect(scaleStanceClock(printed, DifficultyIdNs.hard)).toBeLessThan(
        printed,
      );
      expect(scaleStanceClock(printed, DifficultyIdNs.normal)).toBe(printed);
      expect(scaleStanceClock(printed, undefined)).toBe(printed);
    }
  });

  it('scales a commission’s raid pressure, floors included', () => {
    const easy = DifficultyIdNs.easy;
    const hard = DifficultyIdNs.hard;
    expect(scaleRaidInterval(1000, easy)).toBeGreaterThan(1000);
    expect(scaleRaidInterval(1000, hard)).toBeLessThan(1000);
    expect(scaleRaidInterval(1000, undefined)).toBe(1000);
    expect(scaleRaidCap(8, easy)).toBeLessThan(scaleRaidCap(8, hard));
    expect(scaleRaidCap(8, undefined)).toBe(8);
    // A "wave" of one is a straggler, not a raid.
    expect(scaleRaidCap(2, easy)).toBeGreaterThanOrEqual(2);
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
