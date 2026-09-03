import {describe, expect, it} from 'vitest';
import {tileX, tileY} from '../shared/grid.ts';
import {nearestClaimableResource, rivalGround} from './siting.ts';
import {addResourceTile, addStorehouse, bareWorld} from './testUtils.ts';
import * as TileResource from './tileResourceEnum.ts';
import type {World} from './world.ts';

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
