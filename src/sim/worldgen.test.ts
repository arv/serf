import { describe, expect, it } from 'vitest';
import { tileCount, tileIdx } from '../shared/grid.ts';
import { Terrain } from './map.ts';
import { createWorld } from './world.ts';
import { BANDIT, isPlayerOwner } from './entities.ts';
import { START_SERFS } from './defs/balance.ts';
import { tickWorld } from './tick.ts';
import { UnitTypeId } from './defs/units.ts';

/** 4-connected grass reachability between two tiles. */
function reachable(map: { size: number; terrain: Uint8Array }, from: number, to: number): boolean {
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

describe('N-player worldgen', () => {
  for (const n of [2, 3, 4]) {
    it(`${n} players: symmetric starts, shared landmass, distant camp`, () => {
      // A handful of seeds so a lucky map can't hide a broken guarantee.
      for (const seed of [1, 42, 20260724]) {
        const world = createWorld({
          seed,
          players: Array.from({ length: n }, () => ({ kind: 'human' as const })),
        });
        const storehouses = [...world.buildings.values()].filter((b) => b.type === 'storehouse');
        expect(storehouses.length).toBe(n);
        for (let p = 0; p < n; p++) {
          expect(storehouses.some((b) => b.owner === p)).toBe(true);
          const serfs = [...world.units.values()].filter(
            (u) => u.owner === p && u.kind === UnitTypeId.serf,
          );
          expect(serfs.length).toBe(START_SERFS);
        }
        // Every pair of starts shares the landmass (door tiles south of each
        // storehouse — the footprint itself is blocked).
        const doors = storehouses.map((b) => tileIdx(b.x + 1, b.y + b.h, world.map.size));
        for (const door of doors) {
          expect(world.map.terrain[door]).toBe(Terrain.Grass);
        }
        for (let i = 1; i < doors.length; i++) {
          expect(reachable(world.map, doors[0]!, doors[i]!)).toBe(true);
        }
        // The camp exists and belongs to the bandits.
        const camp = [...world.buildings.values()].find((b) => b.type === 'banditCamp');
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
          expect(p.alive, `seat ${p.id} was eliminated before doing anything`).toBe(true);
        }
      }
    });
  }

  it('deterministic: same config twice gives identical maps', () => {
    const config = { seed: 7, players: [{ kind: 'human' as const }, { kind: 'human' as const }] };
    const a = createWorld(config);
    const b = createWorld(config);
    expect([...a.map.terrain]).toEqual([...b.map.terrain]);
    expect([...a.map.resource]).toEqual([...b.map.resource]);
    expect(a.rngState).toBe(b.rngState);
  });
});
