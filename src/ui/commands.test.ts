import type { Enum } from '../shared/enum.ts';
import { describe, expect, it } from 'vitest';
import { BUILDING_DEFS, BUILDING_TYPES } from '../sim/defs/buildings';
import { UNIT_DEFS, UNIT_TYPES } from '../sim/defs/units';
import { HIRE_KEY, RESEARCH_KEY, TRAIN_KEYS, trainKey, trainingForKey } from './commands';
import { BUILD_KEYS } from './buildMenu';
import type { BuildingSnap } from '../protocol/messages';
import * as BuildingTypeId from '../sim/defs/buildingTypeIdEnum.ts';
import * as UnitTypeId from '../sim/defs/unitTypeIdEnum.ts';

type UnitTypeId = Enum<typeof UnitTypeId>;

const TYPES = BUILDING_TYPES;
/** Every unit any building can be ordered to drill. */
const TRAINABLE = [
  ...new Set(TYPES.flatMap((t) => (BUILDING_DEFS[t].trains ?? []).map((o) => o.unit))),
];

/**
 * The letters on a selected building's command buttons. Contextual, so
 * they may reuse letters the global bindings spend elsewhere — Archer's A
 * is the attack-move's A, and that is fine, because a building selection
 * and a unit selection cannot both stand. What is not fine is two commands
 * on the *same* panel wanting one letter: the second is unreachable and
 * nothing says so.
 */
describe('building command keys', () => {
  it('gives every trainable unit a letter', () => {
    expect(TRAINABLE.filter((u) => trainKey(u) === '')).toEqual([]);
  });

  it('gives no letter to a unit nobody trains', () => {
    const stray = UNIT_TYPES.filter((u) => TRAIN_KEYS[u] !== undefined && !TRAINABLE.includes(u));
    expect(stray).toEqual([]);
  });

  it('never spends one letter twice on the same building', () => {
    for (const type of TYPES) {
      const keys = (BUILDING_DEFS[type].trains ?? []).map((o) => trainKey(o.unit));
      expect(keys.length, `${type} has a duplicate train key`).toBe(new Set(keys).size);
    }
  });

  it('picks letters the unit name can bold', () => {
    const NAMES: Record<UnitTypeId, string> = {
      [UnitTypeId.serf]: 'Serf',
      [UnitTypeId.worker]: 'Worker',
      [UnitTypeId.knight]: 'Knight',
      [UnitTypeId.spearman]: 'Spearman',
      [UnitTypeId.archer]: 'Archer',
      [UnitTypeId.bandit]: 'Bandit',
      [UnitTypeId.banditArcher]: 'Bandit Archer',
      [UnitTypeId.marauder]: 'Marauder',
    };
    const unbolded = TRAINABLE.filter((u) => !NAMES[u].toUpperCase().includes(trainKey(u)));
    expect(unbolded).toEqual([]);
  });

  it('resolves a letter back to its unit at that building, in either case', () => {
    const barracks = { type: BuildingTypeId.barracks } as BuildingSnap;
    for (const option of BUILDING_DEFS[BuildingTypeId.barracks].trains ?? []) {
      const k = trainKey(option.unit);
      expect(trainingForKey(barracks, k)).toBe(option.unit);
      expect(trainingForKey(barracks, k.toLowerCase())).toBe(option.unit);
    }
    expect(trainingForKey(barracks, 'Z')).toBeNull();
    // A building that drills nobody answers every letter with null rather
    // than throwing on an absent `trains`.
    expect(trainingForKey({ type: BuildingTypeId.house } as BuildingSnap, 'K')).toBeNull();
  });

  it('leaves B alone, so the build chord opens from any selection', () => {
    // Contextual commands are tested before the global bindings, so any of
    // them claiming B would shadow the chord opener for as long as that
    // building stayed selected — select your castle, lose the build menu.
    // (Bakery holding B *inside* the chord is fine and unrelated: by then
    // the chord has already swallowed the keystroke.)
    const contextual = [HIRE_KEY, ...TRAINABLE.map((u) => trainKey(u))];
    expect(contextual).not.toContain('B');
    expect(BUILD_KEYS[BuildingTypeId.bakery]).toBe('B');
  });

  it('keeps hire and research off each other', () => {
    expect(HIRE_KEY).not.toBe(RESEARCH_KEY);
  });

  it('names units the panel can actually render', () => {
    // TRAINABLE feeds the key table above; if a def ever names a unit that
    // UNIT_DEFS does not, the table is being built from fiction.
    expect(TRAINABLE.filter((u) => !(u in UNIT_DEFS))).toEqual([]);
  });
});
