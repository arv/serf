import { describe, expect, it } from 'vitest';
import { parseAdvice, toOverride, ADVICE_RANGES } from './advice.ts';
import {
  choosePosture,
  choosePostureBlind,
  isPostureId,
  POSTURES,
  POSTURE_JSON_SCHEMA,
  POSTURE_ORDER,
  postureAdvice,
  type PostureId,
} from './posture.ts';
import type { AiWorldSummary } from './summary.ts';

/**
 * Postures are the strategist's whole vocabulary now, so what is covered
 * here is the two properties the design leans on: every stance names the
 * same knobs (or switching leaves a blend of two behind), and every stance
 * is inside the ranges the parser would clamp it to anyway (or the table
 * is quietly lying about what it sets).
 */

/** A summary with nothing going on; each test bends the field it is about. */
function summary(over: Partial<AiWorldSummary> = {}): AiWorldSummary {
  return {
    tick: 10_000,
    minutes: 8,
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
    rivals: [],
    bandits: { camps: 0, nearestCamp: -1 },
    ...over,
  };
}

function rival(over: Partial<AiWorldSummary['rivals'][number]> = {}): AiWorldSummary['rivals'][number] {
  return {
    id: 1,
    alive: true,
    found: true,
    buildings: 8,
    distance: 40,
    intel: null,
    contact: { firstSoldierMin: -1, firstAttackMin: -1, buildingsAtFive: -1 },
    ...over,
  };
}

describe('the posture table', () => {
  it('sets exactly the same knobs in every stance', () => {
    const keys = POSTURE_ORDER.map((id) => Object.keys(POSTURES[id].knobs).sort().join(','));
    expect(new Set(keys).size).toBe(1);
  });

  it('stays inside the published ranges, so nothing is silently clamped', () => {
    for (const id of POSTURE_ORDER) {
      const knobs: Record<string, unknown> = { ...POSTURES[id].knobs };
      for (const [key, [min, max]] of Object.entries(ADVICE_RANGES)) {
        const value = knobs[key];
        expect(typeof value, `${id}.${key}`).toBe('number');
        expect(value as number, `${id}.${key}`).toBeGreaterThanOrEqual(min);
        expect(value as number, `${id}.${key}`).toBeLessThanOrEqual(max);
      }
    }
  });

  it('offers stances that actually differ from each other', () => {
    const shapes = POSTURE_ORDER.map((id) => JSON.stringify(POSTURES[id].knobs));
    expect(new Set(shapes).size).toBe(POSTURE_ORDER.length);
  });

  it('quotes every stance to the model, and only real ones', () => {
    expect([...POSTURE_JSON_SCHEMA.properties.posture.enum]).toEqual([...POSTURE_ORDER]);
    expect(POSTURE_ORDER.every(isPostureId)).toBe(true);
    expect(isPostureId('turtle')).toBe(false);
    expect(isPostureId('__proto__')).toBe(false);
  });

  it('hands out copies, so one seat cannot edit the stance another seat will get', () => {
    const a = postureAdvice('siege');
    a.serfTarget = 99;
    expect(postureAdvice('siege').serfTarget).toBe(POSTURES.siege.knobs.serfTarget);
  });
});

describe('parseAdvice on a posture reply', () => {
  it('expands a stance name into its whole knob set', () => {
    const advice = parseAdvice('{"posture":"siege","reason":"castle found"}');
    expect(advice).toMatchObject({ ...POSTURES.siege.knobs, posture: 'siege' });
    expect(advice?.reason).toBe('castle found');
  });

  it('keeps the stance out of what reaches the sim', () => {
    const advice = parseAdvice('{"posture":"fortify","reason":"raided"}');
    const override = toOverride(advice!);
    expect(override).toEqual(POSTURES.fortify.knobs);
    expect('posture' in override).toBe(false);
    expect('reason' in override).toBe(false);
  });

  it('ignores a stance nobody authored rather than inventing one', () => {
    expect(parseAdvice('{"posture":"blitzkrieg"}')).toEqual({});
    expect(parseAdvice('{"posture":42}')).toEqual({});
    expect(parseAdvice('{"posture":"constructor"}')).toEqual({});
  });

  it('lets an explicitly named knob beat the stance it came with', () => {
    const advice = parseAdvice('{"posture":"expand","serfTarget":7}');
    expect(advice?.serfTarget).toBe(7);
    expect(advice?.houseLimit).toBe(POSTURES.expand.knobs.houseLimit);
  });

  it('still parses a bare knob reply, so the noise floor is unchanged', () => {
    expect(parseAdvice('{"armyAttackSize":9}')).toEqual({ armyAttackSize: 9 });
  });
});

describe('choosePostureBlind — the null', () => {
  it('drops everything to fortify when the castle is under attack', () => {
    expect(choosePostureBlind(summary({ me: { ...summary().me, underAttack: true } }))).toBe(
      'fortify',
    );
  });

  it('musters while no rival castle has been found', () => {
    const hidden = rival({ found: false, distance: -1 });
    expect(choosePostureBlind(summary({ rivals: [hidden] }))).toBe('muster');
  });

  it('sieges as soon as a castle is on the map, thin army and all', () => {
    const thin = { ...summary().me, army: { knight: 1, spearman: 0, archer: 0 } };
    expect(choosePostureBlind(summary({ me: thin, rivals: [rival()] }))).toBe('siege');
  });

  it('keeps sieging while merely outgunned — only the yard breaks stance', () => {
    const seen = rival({ intel: { ageTicks: 400, heavy: 9, light: 0, ranged: 0, total: 9, peak: 9 } });
    expect(choosePostureBlind(summary({ rivals: [seen] }))).toBe('siege');
  });

  it('does not go economy on a small village, which is what lost the draft rule', () => {
    const small = { ...summary().me, serfs: 6, pop: 8 };
    expect(choosePostureBlind(summary({ me: small, rivals: [rival()] }))).toBe('siege');
  });

  it('ignores rivals that are already dead', () => {
    const dead = rival({ alive: false });
    expect(choosePostureBlind(summary({ rivals: [dead] }))).toBe('muster');
  });

  it('never reads the opponent, whatever the opponent is doing', () => {
    const boomer = rival({ buildings: 16, intel: null });
    const rusher = rival({ contact: { firstSoldierMin: 2, firstAttackMin: 5, buildingsAtFive: 3 } });
    expect(choosePostureBlind(summary({ rivals: [boomer] }))).toBe('siege');
    expect(choosePostureBlind(summary({ rivals: [rusher] }))).toBe('siege');
  });
});

describe('choosePosture — the same cascade, reading the opponent', () => {
  /** A rival with a village on the map and no army ever sighted. */
  const quiet = rival({ buildings: 16, intel: null });

  it('agrees with the null while it has no read on the opponent', () => {
    const unread = rival({ found: false, distance: -1 });
    expect(choosePosture(summary({ rivals: [unread] }))).toBe(
      choosePostureBlind(summary({ rivals: [unread] })),
    );
  });

  it('pounces on a rival that has shown no army worth the name', () => {
    expect(choosePosture(summary({ rivals: [quiet] }))).toBe('pounce');
  });

  it('still sieges a rival that has an army, thin as ours may be', () => {
    const armed = rival({
      buildings: 16,
      intel: { ageTicks: 200, heavy: 5, light: 0, ranged: 0, total: 5, peak: 5 },
    });
    expect(choosePosture(summary({ rivals: [armed] }))).toBe('siege');
  });

  it('keeps the stance when the hostile in the yard is not the opponent in force', () => {
    // `underAttack` is any hostile in sight — a bandit, their lone scout.
    // Breaking a siege for one of those is the deviation that left the
    // blind rule short of the siege constant it could have named.
    const raided = summary({ me: { ...summary().me, underAttack: true }, rivals: [quiet] });
    expect(choosePostureBlind(raided)).toBe('fortify');
    expect(choosePosture(raided)).toBe('pounce');
  });

  it('still fortifies when the opponent itself is the one at the gates', () => {
    const rusher = rival({
      buildings: 4,
      contact: { firstSoldierMin: 2, firstAttackMin: 5, buildingsAtFive: 3 },
    });
    const raided = summary({ me: { ...summary().me, underAttack: true }, rivals: [rusher] });
    expect(choosePosture(raided)).toBe('fortify');
  });

  it('fortifies against an unread board — ignorance is not safety', () => {
    const unread = rival({ found: false, buildings: 0, intel: null });
    const raided = summary({ me: { ...summary().me, underAttack: true }, rivals: [unread] });
    expect(choosePosture(raided)).toBe('fortify');
  });

  it('only ever names a stance the table has', () => {
    const cases: AiWorldSummary[] = [
      summary(),
      summary({ me: { ...summary().me, underAttack: true } }),
      summary({ rivals: [rival()] }),
      summary({ rivals: [quiet] }),
      summary({ rivals: [rival({ found: false })], bandits: { camps: 3, nearestCamp: 5 } }),
    ];
    for (const c of cases) {
      const picked: PostureId = choosePosture(c);
      expect(POSTURE_ORDER).toContain(picked);
      expect(POSTURE_ORDER).toContain(choosePostureBlind(c));
    }
  });
});
