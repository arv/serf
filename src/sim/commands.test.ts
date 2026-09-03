import {describe, expect, it} from 'vitest';
import * as AdminAction from './adminActionEnum.ts';
import * as CommandKind from './commandKindEnum.ts';
import {
  MAX_UNITS_PER_ORDER,
  sanitizeCommand,
  sanitizeCommands,
  type SimCommand,
} from './commands.ts';
import {
  FORGE_QUEUE_CAP,
  HIRE_QUEUE_CAP,
  TRAIN_QUEUE_CAP,
} from './defs/balance.ts';
import {AUTO_RECIPE, BUILDING_DEFS} from './defs/buildings.ts';
import * as BuildingTypeId from './defs/buildingTypeIdEnum.ts';
import * as TechId from './defs/techIdEnum.ts';
import * as UnitTypeId from './defs/unitTypeIdEnum.ts';
import {addSerf, addStorehouse, bareWorld} from './testUtils.ts';
import {tickWorld, type PlayerCommand} from './tick.ts';

describe('command screening', () => {
  it('accepts what the client actually sends', () => {
    const cases: SimCommand[] = [
      {kind: CommandKind.moveUnits, unitIds: [1, 2, 3], x: 10, y: 12},
      {
        kind: CommandKind.moveUnits,
        unitIds: [1, 2, 3],
        x: 10,
        y: 12,
        attack: true,
      },
      {
        kind: CommandKind.moveUnits,
        unitIds: [1, 2, 3],
        x: 10,
        y: 12,
        attack: 'half',
      },
      {
        kind: CommandKind.moveUnits,
        unitIds: [1, 2, 3],
        x: 10,
        y: 12,
        patrol: true,
      },
      {
        kind: CommandKind.moveUnits,
        unitIds: [1, 2, 3],
        x: 10,
        y: 12,
        patrol: true,
        queue: true,
      },
      {
        kind: CommandKind.placeBuilding,
        building: BuildingTypeId.woodcutter,
        x: 4,
        y: 5,
      },
      {kind: CommandKind.hireSerf},
      {kind: CommandKind.cancelHire, index: 0},
      {kind: CommandKind.sellBuilding, buildingId: 3},
      {kind: CommandKind.setBuildingPaused, buildingId: 3, paused: true},
      {kind: CommandKind.setBuildingRepair, buildingId: 3, repair: true},
      {kind: CommandKind.research, tech: TechId.irrigation},
      {kind: CommandKind.trainUnit, buildingId: 7, unit: UnitTypeId.spearman},
      {
        kind: CommandKind.cancelTraining,
        buildingId: 7,
        index: 2,
        unit: UnitTypeId.spearman,
      },
      {kind: CommandKind.setRallyPoint, buildingId: 7, x: 10, y: 12},
      {kind: CommandKind.setRallyPoint, buildingId: 7},
      {kind: CommandKind.admin, action: AdminAction.grantGoods},
    ];
    for (const cmd of cases) expect(sanitizeCommand(cmd)).toEqual(cmd);
  });

  it('rejects names that are not defs', () => {
    expect(
      sanitizeCommand({
        kind: CommandKind.placeBuilding,
        building: 'bogus',
        x: 1,
        y: 1,
      }),
    ).toBeNull();
    expect(sanitizeCommand({kind: 'research', tech: 'bogus'})).toBeNull();
    expect(
      sanitizeCommand({
        kind: CommandKind.trainUnit,
        buildingId: 1,
        unit: 'bogus',
      }),
    ).toBeNull();
    expect(
      sanitizeCommand({
        kind: CommandKind.cancelTraining,
        buildingId: 1,
        index: 0,
        unit: 'bogus',
      }),
    ).toBeNull();
    expect(
      sanitizeCommand({
        kind: CommandKind.cancelTraining,
        buildingId: 1,
        index: -1,
        unit: 'spearman',
      }),
    ).toBeNull();
    expect(
      sanitizeCommand({
        kind: CommandKind.cancelTraining,
        buildingId: 1,
        index: 1.5,
        unit: 'spearman',
      }),
    ).toBeNull();
    expect(sanitizeCommand({kind: 'admin', action: 'bogus'})).toBeNull();
    expect(sanitizeCommand({kind: 'bogus'})).toBeNull();
    // Prototype properties are not definitions.
    expect(
      sanitizeCommand({
        kind: CommandKind.placeBuilding,
        building: 'constructor',
        x: 1,
        y: 1,
      }),
    ).toBeNull();
  });

  it('rejects missing and wrong-typed fields', () => {
    expect(
      sanitizeCommand({kind: CommandKind.moveUnits, x: 1, y: 1}),
    ).toBeNull();
    expect(
      sanitizeCommand({kind: CommandKind.moveUnits, unitIds: 5, x: 1, y: 1}),
    ).toBeNull();
    expect(
      sanitizeCommand({
        kind: CommandKind.moveUnits,
        unitIds: ['a'],
        x: 1,
        y: 1,
      }),
    ).toBeNull();
    expect(
      sanitizeCommand({
        kind: CommandKind.moveUnits,
        unitIds: [1.5],
        x: 1,
        y: 1,
      }),
    ).toBeNull();
    expect(
      sanitizeCommand({
        kind: CommandKind.moveUnits,
        unitIds: [1],
        x: NaN,
        y: 1,
      }),
    ).toBeNull();
    // A garbled attack flag degrades to the order that starts no fights.
    expect(
      sanitizeCommand({
        kind: CommandKind.moveUnits,
        unitIds: [1],
        x: 1,
        y: 1,
        attack: 'yes',
      }),
    ).toEqual({
      kind: CommandKind.moveUnits,
      unitIds: [1],
      x: 1,
      y: 1,
    });
    // And a garbled patrol flag is no patrol: only the literal true walks
    // a beat, so a truthy string cannot leave a squad marching forever.
    expect(
      sanitizeCommand({
        kind: CommandKind.moveUnits,
        unitIds: [1],
        x: 1,
        y: 1,
        patrol: 'yes',
      }),
    ).toEqual({
      kind: CommandKind.moveUnits,
      unitIds: [1],
      x: 1,
      y: 1,
    });
    expect(
      sanitizeCommand({
        kind: CommandKind.placeBuilding,
        building: BuildingTypeId.woodcutter,
      }),
    ).toBeNull();
    expect(
      sanitizeCommand({
        kind: CommandKind.setBuildingRepair,
        buildingId: 'x',
        repair: true,
      }),
    ).toBeNull();
    // A half-given rally pair is garbage, not a guess at what was meant;
    // only the fully absent pair reads as "take the flag down".
    expect(
      sanitizeCommand({kind: CommandKind.setRallyPoint, buildingId: 3, x: 10}),
    ).toBeNull();
    expect(
      sanitizeCommand({kind: CommandKind.setRallyPoint, buildingId: 3, y: 10}),
    ).toBeNull();
    expect(
      sanitizeCommand({
        kind: CommandKind.setRallyPoint,
        buildingId: 3,
        x: 1.5,
        y: 2,
      }),
    ).toBeNull();
    expect(
      sanitizeCommand({
        kind: CommandKind.setRallyPoint,
        buildingId: 3,
        x: NaN,
        y: 2,
      }),
    ).toBeNull();
    expect(
      sanitizeCommand({
        kind: CommandKind.setRallyPoint,
        buildingId: 'x',
        x: 1,
        y: 2,
      }),
    ).toBeNull();
    // A garbled flag reads as the cancel — of the two readings, the one
    // that spends nothing.
    expect(
      sanitizeCommand({
        kind: CommandKind.setBuildingRepair,
        buildingId: 3,
        repair: 'yes',
      }),
    ).toEqual({
      kind: CommandKind.setBuildingRepair,
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
      sanitizeCommand({
        kind: CommandKind.cancelForge,
        buildingId: 1,
        index,
        recipeIndex: 0,
      });
    expect(forge(FORGE_QUEUE_CAP - 1)).not.toBeNull();
    expect(forge(FORGE_QUEUE_CAP)).toBeNull();
    expect(forge(-1)).toBeNull();
    const train = (index: number) =>
      sanitizeCommand({
        kind: CommandKind.cancelTraining,
        buildingId: 1,
        index,
        unit: UnitTypeId.spearman,
      });
    expect(train(TRAIN_QUEUE_CAP - 1)).not.toBeNull();
    expect(train(TRAIN_QUEUE_CAP)).toBeNull();
    const hire = (index: unknown) =>
      sanitizeCommand({kind: CommandKind.cancelHire, index});
    expect(hire(HIRE_QUEUE_CAP - 1)).not.toBeNull();
    expect(hire(HIRE_QUEUE_CAP)).toBeNull();
    expect(hire(-1)).toBeNull();
    expect(hire(1.5)).toBeNull();
    expect(hire(undefined)).toBeNull();
  });

  it('bounds a recipe index by the longest forge menu, and lets auto through', () => {
    const menu =
      BUILDING_DEFS[BuildingTypeId.weaponsmith].recipeOptions!.length;
    const enqueue = (recipeIndex: number) =>
      sanitizeCommand({
        kind: CommandKind.enqueueForge,
        buildingId: 1,
        recipeIndex,
      });
    expect(enqueue(menu - 1)).not.toBeNull();
    // The length itself is the first impossible value — one past the
    // longest menu — and used to slip through as <=.
    expect(enqueue(menu)).toBeNull();
    expect(enqueue(menu + 1)).toBeNull();
    const recipe = (index: number) =>
      sanitizeCommand({
        kind: CommandKind.setBuildingRecipe,
        buildingId: 1,
        index,
      });
    expect(recipe(AUTO_RECIPE)).toMatchObject({index: AUTO_RECIPE});
    expect(recipe(-2)).toBeNull();
    expect(recipe(menu + 1)).toBeNull();
  });

  it('caps the unit list and the frame', () => {
    const tooMany = Array.from({length: MAX_UNITS_PER_ORDER + 1}, (_, i) => i);
    expect(
      sanitizeCommand({
        kind: CommandKind.moveUnits,
        unitIds: tooMany,
        x: 1,
        y: 1,
      }),
    ).toBeNull();

    const frame = Array.from({length: 50}, () => ({
      kind: CommandKind.hireSerf,
    }));
    expect(sanitizeCommands(frame, 8)).toHaveLength(8);
    expect(sanitizeCommands('not an array', 8)).toEqual([]);
    // Garbled entries are dropped, the rest of the frame still plays.
    expect(
      sanitizeCommands([null, {kind: CommandKind.hireSerf}, 'x'], 8),
    ).toEqual([{kind: CommandKind.hireSerf}]);
  });

  it('survives a malformed command that reached the tick anyway', () => {
    const world = bareWorld();
    addStorehouse(world, 30, 30, {});
    addSerf(world, 32, 32);
    // What the old server did with `[{"kind":"placeBuilding","building":"bogus"}]`:
    // straight into applyCommand, where the def lookup threw and stopped the
    // pump for every room in the process.
    const rogue = [
      {
        playerId: 0,
        cmd: {kind: CommandKind.placeBuilding, building: 'bogus', x: 1, y: 1},
      },
    ] as unknown as PlayerCommand[];
    expect(() => tickWorld(world, rogue)).not.toThrow();
    expect(world.tick).toBe(1);
  });
});
