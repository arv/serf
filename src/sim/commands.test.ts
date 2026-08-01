import { describe, expect, it } from 'vitest';
import { MAX_UNITS_PER_ORDER, sanitizeCommand, sanitizeCommands } from './commands.ts';
import { tickWorld } from './tick.ts';
import { addSerf, addStorehouse, bareWorld } from './testUtils.ts';
import type { SimCommand } from './commands.ts';
import type { PlayerCommand } from './tick.ts';

describe('command screening', () => {
  it('accepts what the client actually sends', () => {
    const cases: SimCommand[] = [
      { kind: 'moveUnits', unitIds: [1, 2, 3], x: 10, y: 12 },
      { kind: 'placeBuilding', building: 'woodcutter', x: 4, y: 5 },
      { kind: 'hireSerf' },
      { kind: 'dismissWorker', buildingId: 3 },
      { kind: 'research', tech: 'irrigation' },
      { kind: 'trainUnit', buildingId: 7, unit: 'spearman' },
      { kind: 'admin', action: 'grantGoods' },
    ];
    for (const cmd of cases) expect(sanitizeCommand(cmd)).toEqual(cmd);
  });

  it('rejects names that are not defs', () => {
    expect(sanitizeCommand({ kind: 'placeBuilding', building: 'bogus', x: 1, y: 1 })).toBeNull();
    expect(sanitizeCommand({ kind: 'research', tech: 'bogus' })).toBeNull();
    expect(sanitizeCommand({ kind: 'trainUnit', buildingId: 1, unit: 'bogus' })).toBeNull();
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
    expect(sanitizeCommand({ kind: 'placeBuilding', building: 'woodcutter' })).toBeNull();
    expect(sanitizeCommand(null)).toBeNull();
    expect(sanitizeCommand('moveUnits')).toBeNull();
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
