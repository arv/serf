import {describe, expect, it} from 'vitest';
import {
  DEFAULT_MAP_SIZE,
  marginFor,
  tileCount,
  tileIdx,
} from '../shared/grid.ts';
import {START_SERFS} from './defs/balance.ts';
import * as BuildingTypeId from './defs/buildingTypeIdEnum.ts';
import * as UnitTypeId from './defs/unitTypeIdEnum.ts';
import {BANDIT, isPlayerOwner} from './entities.ts';
import * as PlayerKind from './playerKindEnum.ts';
import * as Terrain from './terrainEnum.ts';
import {tickWorld} from './tick.ts';
import {createWorld, seatStarts, startLayout} from './world.ts';

/** 4-connected grass reachability between two tiles. */
function reachable(
  map: {size: number; terrain: Uint8Array},
  from: number,
  to: number,
): boolean {
  const size = map.size;
  const seen = new Uint8Array(tileCount(size));
  const queue = [from];
  seen[from] = 1;
  for (let head = 0; head < queue.length; head++) {
    const i = queue[head]!;
    if (i === to) return true;
    const x = i % size;
    const y = (i / size) | 0;
    for (const [nx, ny] of [
      [x - 1, y],
      [x + 1, y],
      [x, y - 1],
      [x, y + 1],
    ] as const) {
      if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
      const n = tileIdx(nx, ny, size);
      if (seen[n] || map.terrain[n] !== Terrain.Grass) continue;
      seen[n] = 1;
      queue.push(n);
    }
  }
  return false;
}

/** The playable side createWorld resolves for a config with no ?size. */
const SIZE = DEFAULT_MAP_SIZE;

describe('N-player worldgen', () => {
  for (const n of [2, 3, 4]) {
    it(`${n} players: symmetric starts, shared landmass, distant camp`, () => {
      // A handful of seeds so a lucky map can't hide a broken guarantee.
      for (const seed of [1, 42, 20260724]) {
        const world = createWorld({
          seed,
          players: Array.from({length: n}, () => ({kind: PlayerKind.human})),
        });
        const storehouses = [...world.buildings.values()].filter(
          b => b.type === BuildingTypeId.storehouse,
        );
        expect(storehouses.length).toBe(n);
        for (let p = 0; p < n; p++) {
          expect(storehouses.some(b => b.owner === p)).toBe(true);
          const serfs = [...world.units.values()].filter(
            u => u.owner === p && u.kind === UnitTypeId.serf,
          );
          expect(serfs.length).toBe(START_SERFS);
        }
        // Every pair of starts shares the landmass (door tiles south of each
        // storehouse — the footprint itself is blocked).
        const doors = storehouses.map(b =>
          tileIdx(b.x + 1, b.y + b.h, world.map.size),
        );
        for (const door of doors) {
          expect(world.map.terrain[door]).toBe(Terrain.Grass);
        }
        for (let i = 1; i < doors.length; i++) {
          expect(reachable(world.map, doors[0]!, doors[i]!)).toBe(true);
        }
        // The camp exists and belongs to the bandits.
        const camp = [...world.buildings.values()].find(
          b => b.type === BuildingTypeId.banditCamp,
        );
        expect(camp).toBeDefined();
        expect(camp!.owner).toBe(BANDIT);
        expect(isPlayerOwner(camp!.owner)).toBe(false);
        // ...and stands clear of every start. The camp's standing guards
        // besiege any enemy building inside their acquire radius, so a camp
        // on someone's doorstep razes their storehouse before the match
        // begins — which is exactly what happened at 4 players until the
        // camp moved to the contested middle. Nobody may be eliminated
        // while everyone is still standing around doing nothing.
        for (let t = 0; t < 1500; t++) tickWorld(world, []);
        for (const p of world.players) {
          expect(
            p.alive,
            `seat ${p.id} was eliminated before doing anything`,
          ).toBe(true);
        }
      }
    });
  }

  it('deals the seats their spots without moving the spots', () => {
    // The whole contract in one line: a rolled assignment, never a rolled
    // table. Worldgen's fairness guarantees (mapFairness.test.ts) are
    // about the spots, so a permutation inherits every one of them —
    // which is only true while the SET comes back unchanged.
    for (const n of [1, 2, 3, 4]) {
      const table = startLayout(SIZE, marginFor(SIZE), n)!;
      const key = (spots: [number, number][]): string =>
        [...spots]
          .map(([x, y]) => `${x},${y}`)
          .sort()
          .join(' ');
      for (const seed of [1, 42, 20260724, 0]) {
        const dealt = seatStarts(SIZE, marginFor(SIZE), n, seed)!;
        expect(dealt.length).toBe(n);
        expect(key(dealt)).toBe(key(table));
      }
    }
  });

  it('deals the same hand for the same seed and different hands across seeds', () => {
    const deal = (seed: number): string =>
      seatStarts(SIZE, marginFor(SIZE), 4, seed)!
        .map(([x, y]) => `${x},${y}`)
        .join(' ');
    expect(deal(42)).toBe(deal(42));
    // Where seat 0 — the human — actually ends up, across a hundred
    // valleys. All four spots have to turn up, or the roll is not one.
    const seat0 = new Set(
      Array.from({length: 100}, (_, seed) => deal(seed).split(' ')[0]!),
    );
    expect(seat0.size).toBe(4);
  });

  it('plants each seat on the spot it was dealt', () => {
    // The world records the deal, and the castles stand on it: the AI
    // steers scouts by World.starts, so a drift between the two would
    // send every scout to an empty field.
    const world = createWorld({
      seed: 20260901,
      players: Array.from({length: 4}, () => ({kind: PlayerKind.human})),
    });
    expect(world.starts.length).toBe(4);
    for (let p = 0; p < 4; p++) {
      const castle = [...world.buildings.values()].find(
        b => b.owner === p && b.type === BuildingTypeId.storehouse,
      );
      expect(castle).toMatchObject(world.starts[p]!);
    }
  });

  it('rolls the seats without rolling the ground', () => {
    // A seed is a promise about the valley. The deal draws from its own
    // Rng stream (seatStarts), so two builds that disagree about who sits
    // where would still generate the same map — and this is what pins
    // that the deal never reached worldgen's draws.
    const players = Array.from({length: 4}, () => ({kind: PlayerKind.human}));
    const world = createWorld({seed: 7, players});
    const table = startLayout(SIZE, marginFor(SIZE), 4)!;
    // Worldgen carved the spots in TABLE order; the seats came after.
    for (const [x, y] of table) {
      expect(
        world.map.terrain[tileIdx(x + 1, y + 1, world.map.size)],
        `spot ${x},${y} was not carved`,
      ).toBe(Terrain.Grass);
    }
  });

  it('deterministic: same config twice gives identical maps', () => {
    const config = {
      seed: 7,
      players: [{kind: PlayerKind.human}, {kind: PlayerKind.human}],
    };
    const a = createWorld(config);
    const b = createWorld(config);
    expect([...a.map.terrain]).toEqual([...b.map.terrain]);
    expect([...a.map.resource]).toEqual([...b.map.resource]);
    expect(a.rngState).toBe(b.rngState);
    // The deal too, which is the half a networked match leans on: the
    // server builds the world from the room's config (server/src/rooms.ts)
    // and a replay of that match rebuilds it from the config the room
    // recorded. Two builds that disagreed about who sat where would put
    // every castle in a replay under the wrong banner.
    expect(a.starts).toEqual(b.starts);
  });
});
