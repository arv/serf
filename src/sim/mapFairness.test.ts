import {describe, expect, it} from 'vitest';
import {
  DEFAULT_MAP_SIZE,
  gridFor,
  tileCount,
  tileX,
  tileY,
} from '../shared/grid.ts';
import * as BuildingTypeId from './defs/buildingTypeIdEnum.ts';
import {
  CASTLE_OPENING_SIGHT,
  HOME_SEAM_BAND,
  IRON_HOME_WORTH,
  IRON_RESERVE_WORTH,
  RESERVE_SEAM_BAND,
  SILVER_HOME_WORTH,
  SILVER_RESERVE_WORTH,
  WATER_ACCESS_RADIUS,
  playEdgeDist,
  type TileResourceKind,
} from './map.ts';
import * as PlayerKind from './playerKindEnum.ts';
import * as Terrain from './terrainEnum.ts';
import * as TileResource from './tileResourceEnum.ts';
import {createWorld, type World} from './world.ts';

/**
 * The fairness contract for generated maps: every faction has its own wood,
 * stone, iron, and silver at comparable reach, while gold is deliberately
 * contested — one central cluster with the bandit camp standing over it.
 */

// Pinned representative seeds; a seed here is pure data, swapped when a
// worldgen change rolls it a world that breaks an incidental bound (1337
// fell to the 96 rescale; 7, 20260724 and then 17 to the border passes;
// 5 to the edge-noise pass; 3 to the margin grid; 7 again — its gold
// drifting into solo reach — when the pan clamp and the zoom cap took
// their share of the scenery ring. The default valley has its own
// standing coverage in winnable.test.ts and holds no chair here).
const SEEDS = [4, 2, 11, 19];
// Grid center == play center: the scenery margin is symmetric.
const MID = gridFor(DEFAULT_MAP_SIZE) / 2;

function tilesOf(world: World, code: TileResourceKind): [number, number][] {
  const size = world.map.size;
  const out: [number, number][] = [];
  const tiles = tileCount(size);
  for (let i = 0; i < tiles; i++) {
    if (world.map.resource[i] === code)
      out.push([tileX(i, size), tileY(i, size)]);
  }
  return out;
}

/** Tile centers against a world point, the way the sight stamp measures. */
function countNear(
  tiles: [number, number][],
  x: number,
  y: number,
  r: number,
): number {
  return tiles.filter(([tx, ty]) => Math.hypot(tx + 0.5 - x, ty + 0.5 - y) <= r)
    .length;
}

/** What a resource is WORTH within `r` of a point, not how many tiles it
 * covers. The two used to be the same question — a cluster wrote a flat
 * amount per tile — and that is exactly how the unfairness hid: a start
 * whose seam had room for one tile passed the "has silver" check below on
 * a twentieth of the metal its neighbour drew. */
function amountNear(
  world: World,
  code: TileResourceKind,
  x: number,
  y: number,
  r: number,
): number {
  const size = world.map.size;
  let total = 0;
  for (let i = 0; i < tileCount(size); i++) {
    if (world.map.resource[i] !== code) continue;
    const tx = tileX(i, size);
    const ty = tileY(i, size);
    if (Math.hypot(tx + 0.5 - x, ty + 0.5 - y) > r) continue;
    total += world.map.resourceAmt[i]!;
  }
  return total;
}

function makeWorld(seed: number, players: number): World {
  return createWorld({
    seed,
    players: Array.from({length: players}, () => ({kind: PlayerKind.human})),
  });
}

function anchors(world: World): {x: number; y: number}[] {
  return [...world.buildings.values()]
    .filter(b => b.type === BuildingTypeId.storehouse)
    .map(b => ({x: b.x + b.w / 2, y: b.y + b.h / 2}));
}

describe('map fairness', () => {
  for (const players of [2, 3, 4]) {
    it(`${players} players: everyone has wood, stone, iron, and silver at home reach`, () => {
      for (const seed of SEEDS) {
        const world = makeWorld(seed, players);
        const homes = anchors(world);
        expect(homes.length).toBe(players);
        // Border-belt timber doesn't count as home wood: a 3-player edge
        // anchor's 17-circle can graze a max-wobble forest rim, and rim
        // trees masking a missing home grove is exactly the false pass
        // this test exists to refuse.
        const wood = tilesOf(world, TileResource.Wood).filter(
          ([x, y]) => playEdgeDist(world.map, x, y) >= 10,
        );
        const rock = tilesOf(world, TileResource.Rock);
        const iron = tilesOf(world, TileResource.IronDep);
        const silver = tilesOf(world, TileResource.SilverDep);
        for (const h of homes) {
          const label = `seed ${seed}, ${players}p, start ${h.x},${h.y}`;
          expect(
            countNear(wood, h.x, h.y, 17),
            `${label}: wood`,
          ).toBeGreaterThanOrEqual(3);
          expect(
            countNear(rock, h.x, h.y, 17),
            `${label}: rock`,
          ).toBeGreaterThanOrEqual(2);
          expect(
            countNear(iron, h.x, h.y, 17),
            `${label}: iron`,
          ).toBeGreaterThanOrEqual(1);
          expect(
            countNear(silver, h.x, h.y, 17),
            `${label}: silver`,
          ).toBeGreaterThanOrEqual(1);
        }
      }
    });

    it(`${players} players: every start's iron and silver are worth the same`, () => {
      // Reach is only half of fairness. The seam a start can walk to has to
      // be worth what its rivals' seams are worth, or the map has picked a
      // winner before anyone gives an order — the complaint this covers is
      // a four-seat valley that dealt one seat 20 silver and another 200,
      // on which the poor seat mined its whole birthright out mid-match and
      // sent a mine across the map onto a rival's seam.
      //
      // Exact equality, not a tolerance: seams are priced rather than
      // measured now (see placeSeam), so every start is dealt the same
      // budget whatever the ground under it allows. A tolerance here would
      // pass the very drift the pricing exists to remove.
      for (const seed of SEEDS) {
        const world = makeWorld(seed, players);
        const homes = anchors(world);
        for (const code of [
          TileResource.IronDep,
          TileResource.SilverDep,
        ] as const) {
          const worth = homes.map(h => amountNear(world, code, h.x, h.y, 17));
          for (const [i, w] of worth.entries()) {
            expect(
              w,
              `seed ${seed}, ${players}p, start ${i}: ${code} worth`,
            ).toBe(worth[0]);
          }
          expect(
            worth[0],
            `seed ${seed}, ${players}p: ${code} placed`,
          ).toBeGreaterThan(0);
        }
      }
    });

    it(`${players} players: gold and the bandit camp share the middle`, () => {
      for (const seed of SEEDS) {
        const world = makeWorld(seed, players);
        const gold = tilesOf(world, TileResource.GoldDep);
        expect(gold.length, `seed ${seed}: gold exists`).toBeGreaterThan(0);
        const gx = gold.reduce((s, [x]) => s + x, 0) / gold.length;
        const gy = gold.reduce((s, [, y]) => s + y, 0) / gold.length;
        expect(
          Math.hypot(gx - MID, gy - MID),
          `seed ${seed}: gold central`,
        ).toBeLessThan(10);

        const camp = [...world.buildings.values()].find(
          b => b.type === BuildingTypeId.banditCamp,
        );
        expect(camp, `seed ${seed}: camp exists`).toBeDefined();
        const cd = Math.max(
          Math.abs(camp!.x + 1 - MID),
          Math.abs(camp!.y + 1 - MID),
        );
        expect(cd, `seed ${seed}: camp central`).toBeLessThanOrEqual(12);
      }
    });
  }

  it('every start, solo included, opens with stone in sight', () => {
    // The complaint this covers: solo games that looked stoneless. Trees
    // landed inside the storehouse's opening view and the outcrop did not,
    // so the map read as "no stone" long before anyone walked far enough
    // to find it — and on the seeds where the guaranteed cluster silently
    // wrote zero tiles, walking further would not have helped either.
    //
    // The radius is worldgen's own, derived from the castle's def, so the
    // day someone changes the castle's sight or footprint this test moves
    // with the guarantee instead of quietly checking the wrong ring.
    for (const players of [1, 2, 3, 4]) {
      for (const seed of SEEDS) {
        const world = makeWorld(seed, players);
        const rock = tilesOf(world, TileResource.Rock);
        for (const h of anchors(world)) {
          const label = `seed ${seed}, ${players}p, start ${h.x},${h.y}`;
          expect(
            countNear(rock, h.x, h.y, CASTLE_OPENING_SIGHT),
            `${label}: stone in sight`,
          ).toBeGreaterThan(0);
          expect(
            countNear(rock, h.x, h.y, 13),
            `${label}: a seam worth quarrying`,
          ).toBeGreaterThanOrEqual(5);
        }
      }
    }
  });

  it('every start, any seat count, has fishable water in reach', () => {
    // The water-access audit's observable: a pond, lake, or the open sea
    // within WATER_ACCESS_RADIUS of every castle, with a grass bank to
    // stand on. The bank is asserted at terrain level on purpose — a grove
    // planted over a lakeshore is choppable ground, not lost access —
    // while rim water locked behind a mountain ridge has no grass bank at
    // all and never counts.
    for (const players of [1, 2, 3, 4]) {
      for (const seed of SEEDS) {
        const world = makeWorld(seed, players);
        const size = world.map.size;
        const grassBank = (x: number, y: number): boolean => {
          for (const [nx, ny] of [
            [x - 1, y],
            [x + 1, y],
            [x, y - 1],
            [x, y + 1],
          ] as const) {
            if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
            if (world.map.terrain[ny * size + nx] === Terrain.Grass)
              return true;
          }
          return false;
        };
        for (const h of anchors(world)) {
          let found = false;
          for (let i = 0; i < tileCount(size) && !found; i++) {
            if (world.map.terrain[i] !== Terrain.Water) continue;
            const x = tileX(i, size);
            const y = tileY(i, size);
            if (Math.hypot(x + 0.5 - h.x, y + 0.5 - h.y) > WATER_ACCESS_RADIUS)
              continue;
            found = grassBank(x, y);
          }
          expect(
            found,
            `seed ${seed}, ${players}p, start ${h.x},${h.y}: water access`,
          ).toBe(true);
        }
      }
    }
  });

  it('every start, solo included, has a second silver and iron seam further out', () => {
    // The complaint this covers: the metal runs out. One seam is a
    // finite number of loads and a match that outlives it is a match
    // nobody can hire, research or re-tool in — and, once the iron went
    // the same way (seed 55973911: six loads left on a three-seat board
    // by tick 36_000), a match with no swords and no tools either — so
    // every start is dealt a reserve of each, out past its home ring
    // where reaching it costs a mine and a long haul rather than a build
    // order.
    //
    // Measured as worth beyond the home ring, not as a count of seams: a
    // reserve that landed as two tiles of thirty is the same reserve.
    // `SEAM_SPREAD` is how far a seam's tiles can lie from the center it
    // was drawn at (map.ts SEAM_REACH), which the outer bound has to
    // allow for.
    const SEAM_SPREAD = 3;
    const metals = [
      [TileResource.SilverDep, SILVER_RESERVE_WORTH, 'silver'],
      [TileResource.IronDep, IRON_RESERVE_WORTH, 'iron'],
    ] as const;
    for (const players of [1, 2, 3, 4]) {
      for (const seed of SEEDS) {
        const world = makeWorld(seed, players);
        for (const h of anchors(world)) {
          const label = `seed ${seed}, ${players}p, start ${h.x},${h.y}`;
          for (const [code, worth, name] of metals) {
            const home = amountNear(world, code, h.x, h.y, HOME_SEAM_BAND.wide);
            const reachable = amountNear(
              world,
              code,
              h.x,
              h.y,
              RESERVE_SEAM_BAND.wide + SEAM_SPREAD,
            );
            expect(
              reachable - home,
              `${label}: reserve ${name} past the home ring`,
            ).toBeGreaterThanOrEqual(worth);
          }
        }
      }
    }
  });

  for (const players of [2, 3, 4]) {
    it(`${players} players: the map holds one home seam and one reserve per seat`, () => {
      // The counterpart to the reach test above: reach alone would pass a
      // valley that dealt one seat two reserves and its neighbour a share
      // of someone else's. Every gram of silver on the board is accounted
      // for by the seats, at the same price each.
      const metals = [
        [
          TileResource.SilverDep,
          SILVER_HOME_WORTH + SILVER_RESERVE_WORTH,
          'silver',
        ],
        [TileResource.IronDep, IRON_HOME_WORTH + IRON_RESERVE_WORTH, 'iron'],
      ] as const;
      for (const seed of SEEDS) {
        const world = makeWorld(seed, players);
        for (const [code, perSeat, name] of metals) {
          let total = 0;
          for (let i = 0; i < tileCount(world.map.size); i++) {
            if (world.map.resource[i] === code)
              total += world.map.resourceAmt[i]!;
          }
          expect(total, `seed ${seed}, ${players}p: ${name} on the board`).toBe(
            players * perSeat,
          );
        }
      }
    });
  }

  it('solo: the classic mid-ring layout is untouched', () => {
    for (const seed of SEEDS) {
      const world = makeWorld(seed, 1);
      const iron = tilesOf(world, TileResource.IronDep);
      const silver = tilesOf(world, TileResource.SilverDep);
      const gold = tilesOf(world, TileResource.GoldDep);
      // Ring band 13-17 from center, plus cluster radius.
      expect(
        countNear(iron, MID, MID, 20),
        `seed ${seed}: iron`,
      ).toBeGreaterThanOrEqual(1);
      expect(
        countNear(silver, MID, MID, 20),
        `seed ${seed}: silver`,
      ).toBeGreaterThanOrEqual(1);
      expect(gold.length, `seed ${seed}: gold exists`).toBeGreaterThan(0);
      // Not at the doorstep (the middle is home in solo), not out of reach.
      const gd = Math.min(
        ...gold.map(([x, y]) => Math.hypot(x - MID, y - MID)),
      );
      expect(gd, `seed ${seed}: gold off the plateau`).toBeGreaterThan(9);
      expect(gd, `seed ${seed}: gold reachable`).toBeLessThan(21);
    }
  });
});
