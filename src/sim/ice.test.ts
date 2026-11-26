import {describe, expect, it} from 'vitest';
import {DEFAULT_MAP_SIZE, tileCount, tileIdx} from '../shared/grid.ts';
import {
  ICE_FROM,
  ICE_GRACE_TICKS,
  ICE_UNTIL,
  YEAR_TICKS,
  iceBears,
} from './defs/balance.ts';
import * as UnitTypeId from './defs/unitTypeIdEnum.ts';
import {inPlayArea, type GameMap} from './map.ts';
import {findPath} from './path.ts';
import * as PlayerKind from './playerKindEnum.ts';
import {iceSystem} from './systems/ice.ts';
import * as Terrain from './terrainEnum.ts';
import {createWorld, spawnUnit} from './world.ts';

const SIZE = DEFAULT_MAP_SIZE;

/** Open ground with a lake across its whole width, rows 20 to 24. */
function lakeMap(): GameMap {
  const tiles = tileCount(SIZE);
  const map: GameMap = {
    size: SIZE,
    play: SIZE,
    terrain: new Uint8Array(tiles),
    resource: new Uint8Array(tiles),
    resourceAmt: new Uint8Array(tiles),
    blocked: new Uint8Array(tiles),
    buildingAt: new Int16Array(tiles).fill(-1),
    wear: new Float32Array(tiles),
    pathLevel: new Uint8Array(tiles),
    height: new Float32Array(tiles),
  };
  for (let y = 20; y < 25; y++) {
    for (let x = 0; x < SIZE; x++) {
      const i = tileIdx(x, y, SIZE);
      map.terrain[i] = Terrain.Water;
      map.blocked[i] = 1;
    }
  }
  return map;
}

function freeze(map: GameMap): void {
  map.ice = new Uint8Array(map.blocked.length);
  for (let i = 0; i < map.ice.length; i++) {
    map.ice[i] = map.terrain[i] === Terrain.Water ? 1 : 0;
  }
}

describe('walking on ice', () => {
  it('bears for winter proper and a little into the thaw', () => {
    const from = ICE_FROM * YEAR_TICKS;
    const until = ICE_UNTIL * YEAR_TICKS + ICE_GRACE_TICKS;
    expect(iceBears(0)).toBe(false);
    expect(iceBears(from - 1)).toBe(false);
    expect(iceBears(from)).toBe(true);
    expect(iceBears(until - 1)).toBe(true);
    expect(iceBears(until)).toBe(false);
    // And again the year after.
    expect(iceBears(YEAR_TICKS + from)).toBe(true);
    expect(iceBears(YEAR_TICKS + until)).toBe(false);
  });

  it('is no way across open water', () => {
    expect(findPath(lakeMap(), 10, 10, 10, 30)).toBeNull();
  });

  it('is the short way across a frozen lake', () => {
    const map = lakeMap();
    freeze(map);
    const path = findPath(map, 10, 10, 10, 30);
    expect(path).toHaveLength(20);
    // Straight over: every step stays in the column it started in.
    expect(path!.every(i => i % SIZE === 10)).toBe(true);
  });

  it('still refuses a goal out on the ice', () => {
    const map = lakeMap();
    freeze(map);
    // Water is not ground to stand on, only to cross.
    expect(findPath(map, 10, 10, 10, 22)).toBeNull();
  });

  it('stands whoever is caught out on the nearest shore at the thaw', () => {
    const world = createWorld({seed: 1, players: [{kind: PlayerKind.human}]});
    const {map} = world;
    const size = map.size;
    const end = ICE_UNTIL * YEAR_TICKS + ICE_GRACE_TICKS;

    world.tick = end - 1;
    iceSystem(world);
    const lake = map.ice!.findIndex(
      (bears, i) =>
        bears === 1 &&
        // Well out from the bank: water on every side.
        [-1, 1, -size, size].every(d => map.ice![i + d] === 1),
    );
    expect(lake).toBeGreaterThan(-1);
    const x = lake % size;
    const y = (lake / size) | 0;
    expect(inPlayArea(map, x, y)).toBe(true);
    const unit = spawnUnit(world, UnitTypeId.serf, 0, x + 0.5, y + 0.5);

    world.tick = end;
    iceSystem(world);
    expect(map.ice!.every(bears => bears === 0)).toBe(true);
    const under = tileIdx(Math.floor(unit.x), Math.floor(unit.y), size);
    expect(map.terrain[under]).not.toBe(Terrain.Water);
    expect(map.blocked[under]).toBe(0);
  });
});
