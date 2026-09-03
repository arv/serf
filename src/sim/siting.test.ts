import {describe, expect, it} from 'vitest';
import {tileIdx, tileX, tileY} from '../shared/grid.ts';
import * as BuildingTypeId from './defs/buildingTypeIdEnum.ts';
import {
  findSpot,
  nearestClaimableResource,
  nearestRivalStart,
  rivalGround,
} from './siting.ts';
import * as Terrain from './terrainEnum.ts';
import {addResourceTile, addStorehouse, bareWorld} from './testUtils.ts';
import * as TileResource from './tileResourceEnum.ts';
import type {World} from './world.ts';

/**
 * Where a building that FIGHTS goes: the spiral's own reading of "nearest"
 * says nothing about which side of the village a wall stands on, and a
 * seat whose towers went up behind its castle was the complaint that put
 * `toward` in `findSpot`.
 */
describe('siting a tower against a threat', () => {
  /** A castle at 30,30 — its anchor, and the point every site below is
   * measured from, is its middle at 31,31. The one-tile gap the spiral
   * keeps puts the innermost legal ring at three. */
  function village(): World {
    const world = bareWorld();
    addStorehouse(world, 30, 30, {});
    return world;
  }

  const tower = (
    world: World,
    toward?: {x: number; y: number} | null,
  ): {x: number; y: number} | null =>
    findSpot(world, BuildingTypeId.guardTower, 31, 31, 14, toward);

  it('stands on the side the threat is on', () => {
    const world = village();
    // Due east: the nearest legal 2x2 to a threat out that way, three
    // tiles out and level with the castle's middle.
    expect(tower(world, {x: 61, y: 31})).toEqual({x: 34, y: 30});
    // The other three quarters, from the same castle: the site follows
    // the threat rather than any compass point. Read as sides rather than
    // exact tiles, because the gap rule is not symmetric — a 2x2 sits one
    // column nearer on the east and south than on the west and north.
    expect(tower(world, {x: 1, y: 31})!.x).toBeLessThan(31);
    expect(tower(world, {x: 31, y: 61})!.y).toBeGreaterThan(31);
    expect(tower(world, {x: 31, y: 1})!.y).toBeLessThan(31);
  });

  it('keeps to the innermost ring that has ground facing the threat', () => {
    const world = village();
    const spot = tower(world, {x: 61, y: 31})!;
    // Three out, the nearest a 2x2 can stand with its gap kept — the
    // facing rule picks a SIDE, it does not march the tower out of the
    // village to meet the enemy.
    expect(Math.max(Math.abs(spot.x - 31), Math.abs(spot.y - 31))).toBe(3);
  });

  it('takes the nearest ground it can get when nothing faces the threat', () => {
    const world = village();
    // Everything east of the castle is water: every site left standing is
    // further from the threat than the castle itself, which is the case
    // the facing rule has no answer for.
    for (let y = 0; y < world.map.size; y++) {
      for (let x = 32; x < world.map.size; x++) {
        world.map.terrain[tileIdx(x, y, world.map.size)] = Terrain.Water;
      }
    }
    expect(tower(world, {x: 61, y: 31})).toEqual(tower(world));
  });

  it('is the plain spiral with no threat to face', () => {
    // The old answer, and still the answer for a granary: null and
    // undefined both mean "site this by nearness alone".
    const world = village();
    expect(tower(world, null)).toEqual(tower(world));
    expect(tower(world)).not.toBeNull();
  });
});

/**
 * Which corner a seat looks at before it has found anybody — the fallback
 * under the same rule (`nearestRivalStart`).
 */
describe('the nearest rival corner', () => {
  it('reads the dealt starts, nearest first, and forgets the dead', () => {
    const world = bareWorld(1, 3);
    addStorehouse(world, 30, 30, {});
    addStorehouse(world, 80, 30, {}, 1);
    addStorehouse(world, 50, 30, {}, 2);
    // Anchors, not origins: the castle's middle, as rivalGround reads it.
    expect(nearestRivalStart(world, 0, 31, 31)).toEqual({x: 52, y: 32});
    world.players[2]!.alive = false;
    expect(nearestRivalStart(world, 0, 31, 31)).toEqual({x: 82, y: 32});
    world.players[1]!.alive = false;
    expect(nearestRivalStart(world, 0, 31, 31)).toBeNull();
  });

  it('has no answer in a valley with nobody else in it', () => {
    const world = bareWorld();
    addStorehouse(world, 30, 30, {});
    expect(nearestRivalStart(world, 0, 31, 31)).toBeNull();
  });
});

/**
 * Whose ground a seam is, as the seats read it. The build order, the
 * re-site rule and the reserve-mine rule all anchor on
 * `nearestClaimableResource`, so the line is drawn once here.
 */
describe('claimable ground', () => {
  /** Two castles, north-west and south-east, with the valley split
   * between them along the diagonal. */
  function twoSeats(): World {
    const world = bareWorld(1, 2);
    addStorehouse(world, 20, 20, {});
    addStorehouse(world, 60, 60, {}, 1);
    return world;
  }

  const at = (world: World, i: number): [number, number] => [
    tileX(i, world.map.size),
    tileY(i, world.map.size),
  ];

  it('splits the valley by the nearer castle, ties to nobody', () => {
    const world = twoSeats();
    const theirs = rivalGround(world, 0);
    expect(theirs(25, 25)).toBe(false); // my doorstep
    expect(theirs(58, 58)).toBe(true); // the rival's
    // The anchors sit at 22,22 and 62,62: the tile half way between them
    // is as far from one as the other, and open to both.
    expect(theirs(42, 42)).toBe(false);
    expect(rivalGround(world, 1)(42, 42)).toBe(false);
    expect(theirs(43, 43)).toBe(true);
  });

  it("finds the nearest seam on its own side and skips a nearer one in the rival's yard", () => {
    const world = twoSeats();
    // Iron at the rival's door, and iron further off on my own side.
    addResourceTile(world, 58, 56, TileResource.IronDep, 24);
    addResourceTile(world, 10, 40, TileResource.IronDep, 24);
    // Asked from the middle of the valley, the rival's seam is nearer.
    const i = nearestClaimableResource(world, 0, TileResource.IronDep, 40, 40);
    expect(at(world, i)).toEqual([10, 40]);
    // And from the rival's chair the answer is its own seam.
    const j = nearestClaimableResource(world, 1, TileResource.IronDep, 40, 40);
    expect(at(world, j)).toEqual([58, 56]);
  });

  it("answers nothing when the only seam is a living rival's, and the seam once the rival is gone", () => {
    const world = twoSeats();
    addResourceTile(world, 58, 56, TileResource.IronDep, 24);
    expect(
      nearestClaimableResource(world, 0, TileResource.IronDep, 22, 22),
    ).toBe(-1);
    world.players[1]!.alive = false;
    const i = nearestClaimableResource(world, 0, TileResource.IronDep, 22, 22);
    expect(at(world, i)).toEqual([58, 56]);
  });

  it('leaves the gold contested, as worldgen deals it', () => {
    // The gold sits in the middle of the map and is dealt to nobody; on a
    // three-seat valley the middle is nearer one castle than another
    // however it is drawn, so the line is not drawn for gold at all.
    const world = twoSeats();
    addResourceTile(world, 58, 56, TileResource.GoldDep, 12);
    const i = nearestClaimableResource(world, 0, TileResource.GoldDep, 22, 22);
    expect(at(world, i)).toEqual([58, 56]);
  });

  it('draws no line at all with nobody to draw it against', () => {
    const world = bareWorld();
    addStorehouse(world, 20, 20, {});
    addResourceTile(world, 60, 60, TileResource.IronDep, 24);
    const i = nearestClaimableResource(world, 0, TileResource.IronDep, 22, 22);
    expect(at(world, i)).toEqual([60, 60]);
  });
});
