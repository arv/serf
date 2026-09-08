import {describe, expect, it} from 'vitest';
import * as GoodId from '../sim/defs/goodIdEnum.ts';
import {GOODS, type GoodAmounts} from '../sim/defs/goods.ts';
import * as TechId from '../sim/defs/techIdEnum.ts';
import {TECH_DEFS, TECH_IDS} from '../sim/defs/techs.ts';
import {
  type ActiveStudy,
  hauledIn,
  hauledTotal,
  studyProgress01,
} from './techProgress.ts';

// Irrigation: 5 wheat + 3 silver = 8 loads, 15s of reading.
const TECH = TechId.irrigation;
const BILL = 8;

const hauling = (needs: ActiveStudy['needs']): ActiveStudy => ({
  tech: TECH,
  ticksLeft: TECH_DEFS[TECH].durationTicks,
  totalTicks: TECH_DEFS[TECH].durationTicks,
  started: false,
  needs,
});

const studying = (ticksLeft: number): ActiveStudy => ({
  tech: TECH,
  ticksLeft,
  totalTicks: TECH_DEFS[TECH].durationTicks,
  started: true,
});

describe("a study's bill", () => {
  it('is counted off the tech price, not off what the snapshot sent', () => {
    expect(hauledTotal(TECH)).toBe(BILL);
  });

  it('counts loads in as the bill comes down', () => {
    expect(hauledIn(hauling({[GoodId.wheat]: 5, [GoodId.silver]: 3}))).toBe(0);
    expect(hauledIn(hauling({[GoodId.wheat]: 2, [GoodId.silver]: 1}))).toBe(5);
    expect(hauledIn(hauling({}))).toBe(BILL);
  });

  it('counts nothing in when the Abbey holding the bill cannot be read', () => {
    // No `needs` before the books open is the roof coming down mid-haul
    // (snapPlayers), not a bill paid: an unknown read as "nothing left"
    // would report a finished haul on the frame the Abbey fell.
    expect(hauledIn(hauling(undefined))).toBe(0);
  });

  it('is wholly in once the books are open, bill or no bill', () => {
    // The snapshot drops `needs` when the study starts.
    expect(hauledIn(studying(1))).toBe(BILL);
  });
});

describe('the study bar', () => {
  it('spends its first half on the haul', () => {
    expect(
      studyProgress01(hauling({[GoodId.wheat]: 5, [GoodId.silver]: 3})),
    ).toBe(0);
    expect(
      studyProgress01(hauling({[GoodId.wheat]: 2, [GoodId.silver]: 1})),
    ).toBeCloseTo(5 / 8 / 2);
    expect(studyProgress01(hauling({}))).toBe(0.5);
  });

  it('spends its second half on the reading', () => {
    const total = TECH_DEFS[TECH].durationTicks;
    expect(studyProgress01(studying(total))).toBe(0.5);
    expect(studyProgress01(studying(total / 2))).toBe(0.75);
    expect(studyProgress01(studying(0))).toBe(1);
  });

  it('never goes backwards when the last load lands', () => {
    // The whole point of the split: the bar used to fill on loads, drop to
    // nothing, and fill again on ticks — which reads as the haul being
    // thrown away rather than handed over.
    const lastLoad = studyProgress01(hauling({}));
    const firstTick = studyProgress01(studying(TECH_DEFS[TECH].durationTicks));
    expect(firstTick).toBeGreaterThanOrEqual(lastLoad);
  });

  it('holds at nothing while the Abbey is unreadable', () => {
    expect(studyProgress01(hauling(undefined))).toBe(0);
  });

  it('is monotonic across every tech, load by load and tick by tick', () => {
    for (const tech of TECH_IDS) {
      const def = TECH_DEFS[tech];
      const bill = hauledTotal(tech);
      let prev = -1;
      // Walk the bill down one load at a time, in whatever order the
      // goods happen to come off it — the bar counts loads, not kinds.
      const left: GoodAmounts = {...def.cost};
      for (let carried = 0; carried <= bill; carried++) {
        const p = studyProgress01({
          tech,
          ticksLeft: def.durationTicks,
          totalTicks: def.durationTicks,
          started: false,
          needs: {...left},
        });
        expect(p).toBeGreaterThanOrEqual(prev);
        prev = p;
        const g = GOODS.find(k => (left[k] ?? 0) > 0);
        if (g !== undefined) left[g] = left[g]! - 1;
      }
      // Half the bar is the haul, so a delivered bill is exactly half.
      expect(prev).toBe(0.5);
      for (let t = def.durationTicks; t >= 0; t--) {
        const p = studyProgress01({
          tech,
          ticksLeft: t,
          totalTicks: def.durationTicks,
          started: true,
        });
        expect(p).toBeGreaterThanOrEqual(prev);
        prev = p;
      }
      expect(prev).toBe(1);
    }
  });
});
