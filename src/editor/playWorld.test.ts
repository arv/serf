import { describe, expect, it } from 'vitest';
import { tileIdx } from '../shared/grid.ts';
import { BANDIT } from '../sim/entities.ts';
import { START_SERFS, START_STOCK } from '../sim/defs/balance.ts';
import { Terrain, TileResource, recomputeBlocked } from '../sim/map.ts';
import { deserializeWorld, serializeWorld } from '../sim/save.ts';
import { tickWorld } from '../sim/tick.ts';
import { checkInvariants } from '../sim/debug/invariants.ts';
import { applyBrush } from './brush.ts';
import { createBlankMap } from './editorMap.ts';
import { worldFromEditor } from './playWorld.ts';

function authoredState() {
  // play 64 -> grid 120, play region [28, 92).
  const state = createBlankMap({ size: 64, players: 2 });
  // A lake, a range, a grove and a seam — enough authored variety that the
  // world builder has something real to keep intact.
  applyBrush(state, { kind: 'terrain', terrain: Terrain.Water }, 44, 72, { radius: 5, folds: 2 });
  applyBrush(state, { kind: 'terrain', terrain: Terrain.Rock }, 82, 44, { radius: 3, folds: 2 });
  applyBrush(state, { kind: 'resource', res: TileResource.Wood }, 58, 52, { radius: 3, folds: 2 });
  applyBrush(state, { kind: 'resource', res: TileResource.IronDep }, 72, 72, {
    radius: 2,
    folds: 2,
  });
  return state;
}

const PLAY = {
  seed: 12345,
  players: [{ kind: 'human' as const }, { kind: 'ai' as const }],
  banditsEnabled: true,
};

describe('worldFromEditor', () => {
  it('stands one stocked storehouse per seat on the authored starts', () => {
    const state = authoredState();
    const world = worldFromEditor(state, PLAY);
    const stores = [...world.buildings.values()].filter((b) => b.type === 'storehouse');
    expect(stores).toHaveLength(2);
    for (let p = 0; p < 2; p++) {
      const store = stores.find((b) => b.owner === p)!;
      expect({ x: store.x, y: store.y }).toEqual(state.starts[p]);
      expect(store.stock).toEqual(START_STOCK);
      // The footprint owns its tiles.
      expect(world.map.buildingAt[tileIdx(store.x + 1, store.y + 1, world.map.size)]).toBe(
        store.id,
      );
    }
  });

  it('spawns the starting serfs and the bandit camp with its guards', () => {
    const world = worldFromEditor(authoredState(), PLAY);
    const units = [...world.units.values()];
    for (let p = 0; p < 2; p++) {
      expect(units.filter((u) => u.owner === p && u.kind === 'serf')).toHaveLength(START_SERFS);
    }
    const camp = [...world.buildings.values()].find((b) => b.type === 'banditCamp');
    expect(camp).toBeDefined();
    expect(camp!.owner).toBe(BANDIT);
    expect(units.filter((u) => u.owner === BANDIT)).toHaveLength(3);
  });

  it('honors the bandits toggle', () => {
    const world = worldFromEditor(authoredState(), { ...PLAY, banditsEnabled: false });
    expect([...world.buildings.values()].some((b) => b.type === 'banditCamp')).toBe(false);
    expect([...world.units.values()].some((u) => u.owner === BANDIT)).toBe(false);
  });

  it('never mutates the editing session it came from', () => {
    const state = authoredState();
    const terrain = Uint8Array.from(state.map.terrain);
    const resource = Uint8Array.from(state.map.resource);
    const buildingAt = Int16Array.from(state.map.buildingAt);
    worldFromEditor(state, PLAY);
    expect(state.map.terrain).toEqual(terrain);
    expect(state.map.resource).toEqual(resource);
    expect(state.map.buildingAt).toEqual(buildingAt);
  });

  it('round-trips through the save format the Play handoff uses', () => {
    const world = worldFromEditor(authoredState(), PLAY);
    const back = deserializeWorld(serializeWorld(world));
    expect(back.map.play).toBe(64);
    expect(back.map.size).toBe(120);
    expect(back.map.terrain).toEqual(world.map.terrain);
    expect(back.buildings.size).toBe(world.buildings.size);
    expect(back.units.size).toBe(world.units.size);
    expect(back.players).toHaveLength(2);
    expect(back.players[1]!.kind).toBe('ai');
  });

  it('ticks cleanly: 200 ticks with no invariant violations', () => {
    const world = worldFromEditor(authoredState(), PLAY);
    for (let t = 0; t < 200; t++) tickWorld(world, []);
    expect(checkInvariants(world).violations).toEqual([]);
    expect(world.tick).toBe(200);
    expect(world.outcome.state).toBe('playing');
  });

  it('refuses a seat count that does not match the map', () => {
    expect(() =>
      worldFromEditor(authoredState(), { ...PLAY, players: [{ kind: 'human' }] }),
    ).toThrow(/seat/);
  });

  it('refuses bandits on a map with no room for their camp', () => {
    // All water except the solo center start's ground: every camp seed
    // (the four corners, solo) and its whole 16-ring search is drowned.
    // Launching that with bandits on would win instantly — the victory
    // check reads "no camp stands" as "the camp fell" on tick one.
    const state = createBlankMap({ size: 64, players: 1 });
    const size = state.map.size;
    state.map.terrain.fill(Terrain.Water);
    state.map.height.fill(-0.8);
    const s = state.starts[0]!;
    for (let y = s.y - 1; y < s.y + 4; y++) {
      for (let x = s.x - 1; x < s.x + 4; x++) {
        state.map.terrain[y * size + x] = Terrain.Grass;
        state.map.height[y * size + x] = 0.35;
      }
    }
    recomputeBlocked(state.map);
    const solo = { seed: 7, players: [{ kind: 'human' as const }], banditsEnabled: true };
    expect(() => worldFromEditor(state, solo)).toThrow(/bandit camp/);
    // The same map is a fine peaceful sandbox.
    const world = worldFromEditor(state, { ...solo, banditsEnabled: false });
    expect([...world.buildings.values()].some((b) => b.type === 'banditCamp')).toBe(false);
  });
});
