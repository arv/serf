import { describe, expect, it } from 'vitest';
import { tileIdx } from '../shared/grid';
import { SeatVision } from './visibility';
import { UNIT_DEFS } from './defs/units';
import { buildingDef } from './defs/buildings';
import { spawnUnit } from './world';
import { addStorehouse, bareWorld } from './testUtils';

describe('seat vision', () => {
  it('lights ground around your own units and not around anyone else', () => {
    const world = bareWorld();
    spawnUnit(world, 'serf', 0, 20.5, 20.5);
    spawnUnit(world, 'serf', 1, 40.5, 40.5);

    const mine = new SeatVision();
    mine.recompute(world, 0);

    expect(mine.canSee(20.5, 20.5)).toBe(true);
    // The rival's serf lights nothing for us — that is the whole point.
    expect(mine.canSee(40.5, 40.5)).toBe(false);
  });

  it('sees exactly as far as the sight radius', () => {
    const world = bareWorld();
    spawnUnit(world, 'serf', 0, 32.5, 32.5);
    const v = new SeatVision();
    v.recompute(world, 0);

    // Tile centers line up with the unit's, so distance is the tile offset.
    const sight = UNIT_DEFS.serf.sight;
    expect(v.canSee(32.5 + Math.floor(sight), 32.5)).toBe(true);
    expect(v.canSee(32.5 + Math.ceil(sight), 32.5)).toBe(false);
  });

  it('remembers explored ground after the unit walks away', () => {
    const world = bareWorld();
    const scout = spawnUnit(world, 'serf', 0, 10.5, 10.5);
    const v = new SeatVision();
    v.recompute(world, 0);
    expect(v.canSee(10.5, 10.5)).toBe(true);

    scout.x = 50.5;
    scout.y = 50.5;
    v.recompute(world, 0);

    expect(v.canSee(10.5, 10.5)).toBe(false);
    expect(v.hasExplored(10.5, 10.5)).toBe(true);
  });

  it('reports newly lit tiles once, when they light up', () => {
    const world = bareWorld();
    const scout = spawnUnit(world, 'serf', 0, 10.5, 10.5);
    const v = new SeatVision();
    v.recompute(world, 0);
    const first = v.revealed.length;
    expect(first).toBeGreaterThan(0);

    // Standing still reveals nothing new.
    v.recompute(world, 0);
    expect(v.revealed).toHaveLength(0);

    // Stepping one tile east reveals a sliver, not the whole circle.
    scout.x += 1;
    v.recompute(world, 0);
    expect(v.revealed.length).toBeGreaterThan(0);
    expect(v.revealed.length).toBeLessThan(first);

    // Walking back onto ground we already explored still counts as newly
    // *visible* — the server owes us its current contents, because it may
    // have been built on while we were away.
    scout.x -= 1;
    v.recompute(world, 0);
    expect(v.revealed.length).toBeGreaterThan(0);
  });

  it('takes each kind of thing at its own definition', () => {
    // The radii live on the defs so the server filter and the renderer's
    // fog read one source; a per-kind change needs no code change here.
    expect(UNIT_DEFS.serf.sight).toBeGreaterThan(0);
    expect(buildingDef('storehouse').sight).toBeGreaterThan(buildingDef('quarry').sight);
  });

  it('gives a storehouse a wider view than a unit', () => {
    const world = bareWorld();
    addStorehouse(world, 30, 30, {});
    const v = new SeatVision();
    v.recompute(world, 0);
    // Storehouse sight is 9 plus half its footprint, well beyond a serf's.
    expect(v.canSee(30 + 10.5, 31.5)).toBe(true);
  });

  it('does not light ground for a dead unit', () => {
    const world = bareWorld();
    const u = spawnUnit(world, 'serf', 0, 15.5, 15.5);
    u.dead = true;
    const v = new SeatVision();
    v.recompute(world, 0);
    expect(v.canSee(15.5, 15.5)).toBe(false);
  });

  it('keeps the visible grid consistent with canSee', () => {
    const world = bareWorld();
    spawnUnit(world, 'serf', 0, 25.5, 25.5);
    const v = new SeatVision();
    v.recompute(world, 0);
    expect(v.visible[tileIdx(25, 25)]).toBe(1);
    expect(v.visible[tileIdx(0, 0)]).toBe(0);
  });
});
