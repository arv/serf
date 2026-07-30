import { describe, expect, it } from 'vitest';
import { MAP_SIZE, tileIdx } from '../shared/grid';
import { Terrain } from './map';
import { createWorld } from './world';
import { BANDIT, isPlayerOwner } from './entities';
import { START_SERFS } from './defs/balance';

/** 4-connected grass reachability between two tiles. */
function reachable(map: { terrain: Uint8Array }, from: number, to: number): boolean {
  const seen = new Uint8Array(MAP_SIZE * MAP_SIZE);
  const queue = [from];
  seen[from] = 1;
  for (let head = 0; head < queue.length; head++) {
    const i = queue[head]!;
    if (i === to) return true;
    const x = i % MAP_SIZE;
    const y = (i / MAP_SIZE) | 0;
    for (const [nx, ny] of [
      [x - 1, y],
      [x + 1, y],
      [x, y - 1],
      [x, y + 1],
    ] as const) {
      if (nx < 0 || ny < 0 || nx >= MAP_SIZE || ny >= MAP_SIZE) continue;
      const n = tileIdx(nx, ny);
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
            (u) => u.owner === p && u.kind === 'serf',
          );
          expect(serfs.length).toBe(START_SERFS);
        }
        // Every pair of starts shares the landmass (door tiles south of each
        // storehouse — the footprint itself is blocked).
        const doors = storehouses.map((b) => tileIdx(b.x + 1, b.y + b.h));
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
