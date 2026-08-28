import { describe, expect, it } from 'vitest';
import { MAX_UNITS_PER_ORDER, sanitizeCommand, sanitizeCommands } from './commands.ts';
import { FORGE_QUEUE_CAP, TRAIN_QUEUE_CAP } from './defs/balance.ts';
import { AUTO_RECIPE, BUILDING_DEFS } from './defs/buildings.ts';
import { tickWorld } from './tick.ts';
import { addSerf, addStorehouse, bareWorld } from './testUtils.ts';
import type { SimCommand } from './commands.ts';
import type { PlayerCommand } from './tick.ts';
import { UnitTypeId } from './defs/units.ts';
import { BuildingTypeId } from './defs/buildings.ts';

describe('command screening', () => {
  it('accepts what the client actually sends', () => {
    const cases: SimCommand[] = [
      { kind: 'moveUnits', unitIds: [1, 2, 3], x: 10, y: 12 },
      { kind: 'moveUnits', unitIds: [1, 2, 3], x: 10, y: 12, attack: true },
      { kind: 'moveUnits', unitIds: [1, 2, 3], x: 10, y: 12, attack: 'half' },
      { kind: 'placeBuilding', building: BuildingTypeId.woodcutter, x: 4, y: 5 },
      { kind: 'hireSerf' },
      { kind: 'sellBuilding', buildingId: 3 },
      { kind: 'setBuildingPaused', buildingId: 3, paused: true },
      { kind: 'setBuildingRepair', buildingId: 3, repair: true },
      { kind: 'research', tech: 'irrigation' },
      { kind: 'trainUnit', buildingId: 7, unit: UnitTypeId.spearman },
      { kind: 'cancelTraining', buildingId: 7, index: 2, unit: UnitTypeId.spearman },
      { kind: 'setRallyPoint', buildingId: 7, x: 10, y: 12 },
      { kind: 'setRallyPoint', buildingId: 7 },
      { kind: 'admin', action: 'grantGoods' },
    ];
    for (const cmd of cases) expect(sanitizeCommand(cmd)).toEqual(cmd);
  });

  it('rejects names that are not defs', () => {
    expect(sanitizeCommand({ kind: 'placeBuilding', building: 'bogus', x: 1, y: 1 })).toBeNull();
    expect(sanitizeCommand({ kind: 'research', tech: 'bogus' })).toBeNull();
    expect(sanitizeCommand({ kind: 'trainUnit', buildingId: 1, unit: 'bogus' })).toBeNull();
    expect(
      sanitizeCommand({ kind: 'cancelTraining', buildingId: 1, index: 0, unit: 'bogus' }),
    ).toBeNull();
    expect(
      sanitizeCommand({ kind: 'cancelTraining', buildingId: 1, index: -1, unit: 'spearman' }),
    ).toBeNull();
    expect(
      sanitizeCommand({ kind: 'cancelTraining', buildingId: 1, index: 1.5, unit: 'spearman' }),
    ).toBeNull();
    expect(sanitizeCommand({ kind: 'admin', action: 'bogus' })).toBeNull();
    expect(sanitizeCommand({ kind: 'bogus' })).toBeNull();
    // Prototype properties are not definitions.
    expect(
      sanitizeCommand({ kind: 'placeBuilding', building: 'constructor', x: 1, y: 1 }),
    ).toBeNull();
  });

  it('rejects missing and wrong-typed fields', () => {
    expect(sanitizeCommand({ kind: 'moveUnits', x: 1, y: 1 })).toBeNull();
    expect(sanitizeCommand({ kind: 'moveUnits', unitIds: 5, x: 1, y: 1 })).toBeNull();
    expect(sanitizeCommand({ kind: 'moveUnits', unitIds: ['a'], x: 1, y: 1 })).toBeNull();
    expect(sanitizeCommand({ kind: 'moveUnits', unitIds: [1.5], x: 1, y: 1 })).toBeNull();
    expect(sanitizeCommand({ kind: 'moveUnits', unitIds: [1], x: NaN, y: 1 })).toBeNull();
    // A garbled attack flag degrades to the order that starts no fights.
    expect(sanitizeCommand({ kind: 'moveUnits', unitIds: [1], x: 1, y: 1, attack: 'yes' })).toEqual({
      kind: 'moveUnits',
      unitIds: [1],
      x: 1,
      y: 1,
    });
    expect(sanitizeCommand({ kind: 'placeBuilding', building: BuildingTypeId.woodcutter })).toBeNull();
    expect(sanitizeCommand({ kind: 'setBuildingRepair', buildingId: 'x', repair: true })).toBeNull();
    // A half-given rally pair is garbage, not a guess at what was meant;
    // only the fully absent pair reads as "take the flag down".
    expect(sanitizeCommand({ kind: 'setRallyPoint', buildingId: 3, x: 10 })).toBeNull();
    expect(sanitizeCommand({ kind: 'setRallyPoint', buildingId: 3, y: 10 })).toBeNull();
    expect(sanitizeCommand({ kind: 'setRallyPoint', buildingId: 3, x: 1.5, y: 2 })).toBeNull();
    expect(sanitizeCommand({ kind: 'setRallyPoint', buildingId: 3, x: NaN, y: 2 })).toBeNull();
    expect(sanitizeCommand({ kind: 'setRallyPoint', buildingId: 'x', x: 1, y: 2 })).toBeNull();
    // A garbled flag reads as the cancel — of the two readings, the one
    // that spends nothing.
    expect(sanitizeCommand({ kind: 'setBuildingRepair', buildingId: 3, repair: 'yes' })).toEqual({
      kind: 'setBuildingRepair',
      buildingId: 3,
      repair: false,
    });
    expect(sanitizeCommand(null)).toBeNull();
    expect(sanitizeCommand('moveUnits')).toBeNull();
  });

  it('bounds a queue slot by the queue that holds it', () => {
    // A slot past the cap can never name a real order, so it is turned away
    // here rather than reaching the sim to quietly do nothing.
    const forge = (index: number) =>
      sanitizeCommand({ kind: 'cancelForge', buildingId: 1, index, recipeIndex: 0 });
    expect(forge(FORGE_QUEUE_CAP - 1)).not.toBeNull();
    expect(forge(FORGE_QUEUE_CAP)).toBeNull();
    expect(forge(-1)).toBeNull();
    const train = (index: number) =>
      sanitizeCommand({ kind: 'cancelTraining', buildingId: 1, index, unit: UnitTypeId.spearman });
    expect(train(TRAIN_QUEUE_CAP - 1)).not.toBeNull();
    expect(train(TRAIN_QUEUE_CAP)).toBeNull();
  });

  it('bounds a recipe index by the longest forge menu, and lets auto through', () => {
    const menu = BUILDING_DEFS[BuildingTypeId.weaponsmith].recipeOptions!.length;
    const enqueue = (recipeIndex: number) =>
      sanitizeCommand({ kind: 'enqueueForge', buildingId: 1, recipeIndex });
    expect(enqueue(menu - 1)).not.toBeNull();
    // The length itself is the first impossible value — one past the
    // longest menu — and used to slip through as <=.
    expect(enqueue(menu)).toBeNull();
    expect(enqueue(menu + 1)).toBeNull();
    const recipe = (index: number) =>
      sanitizeCommand({ kind: 'setBuildingRecipe', buildingId: 1, index });
    expect(recipe(AUTO_RECIPE)).toMatchObject({ index: AUTO_RECIPE });
    expect(recipe(-2)).toBeNull();
    expect(recipe(menu + 1)).toBeNull();
  });

  it('caps the unit list and the frame', () => {
    const tooMany = Array.from({ length: MAX_UNITS_PER_ORDER + 1 }, (_, i) => i);
    expect(sanitizeCommand({ kind: 'moveUnits', unitIds: tooMany, x: 1, y: 1 })).toBeNull();

    const frame = Array.from({ length: 50 }, () => ({ kind: 'hireSerf' }));
    expect(sanitizeCommands(frame, 8)).toHaveLength(8);
    expect(sanitizeCommands('not an array', 8)).toEqual([]);
    // Garbled entries are dropped, the rest of the frame still plays.
    expect(sanitizeCommands([null, { kind: 'hireSerf' }, 'x'], 8)).toEqual([{ kind: 'hireSerf' }]);
  });

  it('survives a malformed command that reached the tick anyway', () => {
    const world = bareWorld();
    addStorehouse(world, 30, 30, {});
    addSerf(world, 32, 32);
    // What the old server did with `[{"kind":"placeBuilding","building":"bogus"}]`:
    // straight into applyCommand, where the def lookup threw and stopped the
    // pump for every room in the process.
    const rogue = [
      { playerId: 0, cmd: { kind: 'placeBuilding', building: 'bogus', x: 1, y: 1 } },
    ] as unknown as PlayerCommand[];
    expect(() => tickWorld(world, rogue)).not.toThrow();
    expect(world.tick).toBe(1);
  });
});
