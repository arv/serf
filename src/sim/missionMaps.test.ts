import {describe, expect, it} from 'vitest';
import type {Enum} from '../shared/enum.ts';
import {inBounds, tileCount, tileIdx, tileX, tileY} from '../shared/grid.ts';
import {BUILDING_DEFS} from './defs/buildings.ts';
import * as BuildingTypeId from './defs/buildingTypeIdEnum.ts';
import * as MissionId from './defs/missionIdEnum.ts';
import {loadMissionMap} from './defs/missionMaps.ts';
import {MISSION_DEFS, MISSION_ORDER, MISSION_KEYS} from './defs/missions.ts';
import * as ObjectiveKind from './defs/objectiveKindEnum.ts';
import {
  CASTLE_OPENING_SIGHT,
  HOME_SEAM_BAND,
  RESERVE_SEAM_BAND,
  SILVER_RESERVE_WORTH,
  WATER_ACCESS_RADIUS,
  inPlayArea,
  tileBlocks,
  type GameMap,
  type StartSpot,
  type TileResourceKind,
} from './map.ts';
import {parseMapData, type AuthoredMap} from './mapFile.ts';
import * as Terrain from './terrainEnum.ts';
import * as TileResource from './tileResourceEnum.ts';
import {canPlace} from './world.ts';

type BuildingTypeId = Enum<typeof BuildingTypeId>;
type MissionId = Enum<typeof MissionId>;

/**
 * The campaign's ground is authored (tools/mapAuthor/), and this is what
 * "authored" is worth: the promises the recipes make, held against the
 * tiles that shipped.
 *
 * Worldgen owes every start timber, stone in the opening view, water
 * within a fishery's walk and ore it can reach — audited and repaired
 * inside `generateMap`. A hand-built map gets no such repair pass, so it
 * gets this instead. Everything here is a fast question about tiles; the
 * slow question — can the mission be WON — is missions.test.ts's.
 */

const MAPS = new Map<MissionId, AuthoredMap>();
async function mapFor(id: MissionId): Promise<AuthoredMap> {
  let authored = MAPS.get(id);
  if (!authored) {
    authored = parseMapData(await loadMissionMap(id));
    MAPS.set(id, authored);
  }
  return authored;
}

/** The castle's sight centre — what "in the opening view" measures from. */
function keepCenter(s: StartSpot): {x: number; y: number} {
  return {x: s.x + 1.5, y: s.y + 1.5};
}

/** Resource tiles of one kind within `radius` of a point, tile centres
 * against the point the way the visibility stamp measures. */
function countWithin(
  map: GameMap,
  c: {x: number; y: number},
  code: TileResourceKind,
  radius: number,
): number {
  let n = 0;
  const r = Math.ceil(radius) + 1;
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      const x = Math.floor(c.x) + dx;
      const y = Math.floor(c.y) + dy;
      if (!inPlayArea(map, x, y)) continue;
      if (Math.hypot(x + 0.5 - c.x, y + 0.5 - c.y) > radius) continue;
      if (map.resource[tileIdx(x, y, map.size)] === code) n++;
    }
  }
  return n;
}

/** What a resource is WORTH within `radius` of a point — the same square
 * of tiles `countWithin` walks, weighed rather than counted. */
function amountWithin(
  map: GameMap,
  c: {x: number; y: number},
  code: TileResourceKind,
  radius: number,
): number {
  let n = 0;
  const r = Math.ceil(radius) + 1;
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      const x = Math.floor(c.x) + dx;
      const y = Math.floor(c.y) + dy;
      if (!inPlayArea(map, x, y)) continue;
      if (Math.hypot(x + 0.5 - c.x, y + 0.5 - c.y) > radius) continue;
      const i = tileIdx(x, y, map.size);
      if (map.resource[i] === code) n += map.resourceAmt[i]!;
    }
  }
  return n;
}

/** Everything a serf can walk to from a tile: playable, dry, nothing standing. */
function reachableFrom(map: GameMap, from: {x: number; y: number}): Uint8Array {
  const size = map.size;
  const seen = new Uint8Array(tileCount(size));
  const walkable = (i: number): boolean =>
    inPlayArea(map, tileX(i, size), tileY(i, size)) &&
    !tileBlocks(map.terrain[i]!, map.resource[i]!);
  const start = tileIdx(Math.round(from.x), Math.round(from.y), size);
  if (!walkable(start)) return seen;
  seen[start] = 1;
  const queue = [start];
  for (let head = 0; head < queue.length; head++) {
    const i = queue[head]!;
    const x = tileX(i, size);
    const y = tileY(i, size);
    for (const [nx, ny] of [
      [x - 1, y],
      [x + 1, y],
      [x, y - 1],
      [x, y + 1],
    ] as const) {
      if (!inBounds(nx, ny, size)) continue;
      const n = tileIdx(nx, ny, size);
      if (seen[n] || !walkable(n)) continue;
      seen[n] = 1;
      queue.push(n);
    }
  }
  return seen;
}

/** The nearest ring the placement rules accept this building on — the
 * ghost search a player runs by eye, and the one placePrebuiltNear runs. */
function siteRing(
  map: GameMap,
  type: BuildingTypeId,
  c: {x: number; y: number},
  maxRing: number,
): number {
  const cx = Math.round(c.x);
  const cy = Math.round(c.y);
  for (let r = 0; r <= maxRing; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        if (canPlace(map, type, cx + dx, cy + dy)) return r;
      }
    }
  }
  return Infinity;
}

describe('the campaign’s authored ground', () => {
  it.each(MISSION_ORDER)(
    '%s opens on ground a village can be started from',
    async id => {
      const {map, starts} = await mapFor(id);
      for (const start of starts) {
        const c = keepCenter(start);
        const where = `${id} @ ${start.x},${start.y}`;
        // Stone the player can SEE, and enough of it within a short walk to
        // be worth siting a quarry on: worldgen's own repair threshold.
        expect(
          countWithin(map, c, TileResource.Rock, CASTLE_OPENING_SIGHT),
          `${where}: stone in sight`,
        ).toBeGreaterThan(0);
        expect(
          countWithin(map, c, TileResource.Rock, 13),
          `${where}: stone worth quarrying`,
        ).toBeGreaterThanOrEqual(5);
        // Timber, and a hut that can legally stand at it.
        expect(
          siteRing(map, BuildingTypeId.woodcutter, c, 14),
          `${where}: a woodcutter within reach`,
        ).toBeLessThanOrEqual(14);
        expect(
          siteRing(map, BuildingTypeId.quarry, c, 14),
          `${where}: a quarry within reach`,
        ).toBeLessThanOrEqual(14);
        // Fishable water within a fishery's walk, on the village's own
        // landmass — worldgen's WATER_ACCESS_RADIUS promise.
        expect(
          siteRing(map, BuildingTypeId.fishery, c, WATER_ACCESS_RADIUS),
          `${where}: a shore to fish`,
        ).toBeLessThanOrEqual(WATER_ACCESS_RADIUS);
      }
    },
  );

  it.each(MISSION_ORDER)(
    '%s can be walked: no ore behind a lake, no camp off the landmass',
    async id => {
      const def = MISSION_DEFS[id];
      const {map, starts} = await mapFor(id);
      const reach = reachableFrom(map, {
        x: starts[0]!.x + 2,
        y: starts[0]!.y + 2,
      });
      const beside = (i: number): boolean => {
        const x = tileX(i, map.size);
        const y = tileY(i, map.size);
        return [
          [x - 1, y],
          [x + 1, y],
          [x, y - 1],
          [x, y + 1],
        ].some(
          ([nx, ny]) =>
            inBounds(nx!, ny!, map.size) &&
            reach[tileIdx(nx!, ny!, map.size)] === 1,
        );
      };
      // A miner stands beside its seam, so every deposit on the map has to
      // have a walkable tile against it.
      for (let i = 0; i < tileCount(map.size); i++) {
        const res = map.resource[i]!;
        if (
          res !== TileResource.IronDep &&
          res !== TileResource.SilverDep &&
          res !== TileResource.GoldDep
        ) {
          continue;
        }
        if (!inPlayArea(map, tileX(i, map.size), tileY(i, map.size))) continue;
        expect(
          beside(i),
          `${id}: deposit at ${tileX(i, map.size)},${tileY(i, map.size)} is walled off`,
        ).toBe(true);
      }
      // Rival seats must be able to reach each other — soldiers cannot chop,
      // and a war of elimination that cannot be marched never ends.
      for (const s of starts.slice(1)) {
        expect(
          reach[tileIdx(s.x + 2, s.y + 2, map.size)],
          `${id}: seat at ${s.x},${s.y} unreachable`,
        ).toBe(1);
      }
      // And the camp has to be marchable on, not merely placeable.
      if (def.campSpot) {
        const {x, y} = def.campSpot;
        let adjacent = false;
        for (let dy = -1; dy <= 3; dy++) {
          for (let dx = -1; dx <= 3; dx++) {
            if (reach[tileIdx(x + dx, y + dy, map.size)]) adjacent = true;
          }
        }
        expect(adjacent, `${id}: camp at ${x},${y} cannot be marched to`).toBe(
          true,
        );
      }
    },
  );

  it.each(MISSION_ORDER)(
    '%s stands the village its def pre-places',
    async id => {
      const def = MISSION_DEFS[id];
      const {map, starts} = await mapFor(id);
      for (const spec of def.prebuilt ?? []) {
        // placePrebuiltNear spirals 15 rings and silently places nothing if
        // it finds none. Held to five here: a hut that has to walk halfway
        // across the valley to find ground is a map that has drifted from
        // the village its briefing describes, even when it lands.
        const c = {x: starts[0]!.x + spec.dx, y: starts[0]!.y + spec.dy};
        expect(
          siteRing(map, spec.type, c, 5),
          `${id}: prebuilt ${spec.type} at ${spec.dx},${spec.dy}`,
        ).toBeLessThanOrEqual(5);
      }
    },
  );

  it.each(MISSION_ORDER)(
    '%s holds the ore its objectives ask a mine to dig',
    async id => {
      const def = MISSION_DEFS[id];
      const {map, starts} = await mapFor(id);
      const wanted = new Set<BuildingTypeId>();
      for (const o of def.objectives)
        if (o.spec.kind === ObjectiveKind.building) wanted.add(o.spec.type);
      for (const spec of def.prebuilt ?? []) wanted.add(spec.type);
      for (const type of wanted) {
        if (!BUILDING_DEFS[type].mine) continue;
        // Reachable in the sense the mission's own tests reach for it: the
        // scripted playthroughs spiral out from the castle looking for a
        // legal spot, and give up at sixteen rings.
        expect(
          siteRing(map, type, keepCenter(starts[0]!), 16),
          `${id}: nowhere to dig a ${type}`,
        ).toBeLessThanOrEqual(16);
      }
    },
  );

  it.each(MISSION_ORDER)(
    '%s puts a reserve seam behind the silver it teaches',
    async id => {
      // Worldgen deals every start a home seam and a reserve further out
      // (map.ts RESERVE_SEAM_BAND), because one seam is a finite number of
      // loads and a match that outlives it cannot hire, research or
      // re-tool. Authored ground gets no repair pass, so it gets this.
      //
      // Conditional on the map holding silver at all: the first two
      // commissions are read off ground that deliberately holds none, and
      // the test above pins that on purpose.
      const {map, starts} = await mapFor(id);
      const SEAM_SPREAD = 3; // how far a seam lies from the center it was drawn at
      for (const start of starts) {
        const c = keepCenter(start);
        const home = amountWithin(
          map,
          c,
          TileResource.SilverDep,
          HOME_SEAM_BAND.wide,
        );
        if (home === 0) continue;
        const reachable = amountWithin(
          map,
          c,
          TileResource.SilverDep,
          RESERVE_SEAM_BAND.wide + SEAM_SPREAD,
        );
        expect(
          reachable - home,
          `${id} @ ${start.x},${start.y}: reserve silver past the home ring`,
        ).toBeGreaterThanOrEqual(SILVER_RESERVE_WORTH);
      }
    },
  );

  it('the rival banner is exactly symmetric under the half turn', async () => {
    const {map, starts} = await mapFor(MissionId.rivalBanner);
    expect(starts.length).toBe(2);
    // Inside the rim only: a border draws its own wobble around the
    // perimeter and is scenery either way. The band's deepest reach is
    // base + capped jitter + teeth (mapBorders.test.ts pins the same sum).
    const fringe = Math.max(1, Math.floor(map.play / 24));
    const inset = 3 * fringe + 2;
    const lo = (map.size - map.play) / 2 + inset;
    const hi = lo + map.play - 2 * inset;
    let off = 0;
    for (let y = lo; y < hi; y++) {
      for (let x = lo; x < hi; x++) {
        const i = tileIdx(x, y, map.size);
        const j = tileIdx(map.size - 1 - x, map.size - 1 - y, map.size);
        if (
          map.terrain[i] !== map.terrain[j] ||
          map.resource[i] !== map.resource[j] ||
          map.resourceAmt[i] !== map.resourceAmt[j]
        ) {
          off++;
        }
      }
    }
    expect(off, 'tiles differing from their half-turn twin').toBe(0);
    // And the seats sit at each other's twin, so the symmetry is the
    // fairness claim rather than a pretty pattern.
    const [a, b] = starts as [StartSpot, StartSpot];
    expect({x: map.size - 1 - (a.x + 2), y: map.size - 1 - (a.y + 2)}).toEqual({
      x: b.x,
      y: b.y,
    });
  });

  it('the tutorial maps hold only the metals their lesson is about', async () => {
    // The first commissions are read off the ground, so the ground is not
    // allowed to be about anything else: no silver and no gold before the
    // mission that teaches them, and Hammer and Haft is one hill of iron.
    const has = async (
      id: MissionId,
      code: TileResourceKind,
    ): Promise<boolean> => {
      const {map} = await mapFor(id);
      return map.resource.some(
        (r, i) =>
          r === code && inPlayArea(map, tileX(i, map.size), tileY(i, map.size)),
      );
    };
    for (const id of [MissionId.clearing, MissionId.hammerAndHaft]) {
      expect(
        await has(id, TileResource.SilverDep),
        `${MISSION_KEYS[id]}: silver`,
      ).toBe(false);
      expect(
        await has(id, TileResource.GoldDep),
        `${MISSION_KEYS[id]}: gold`,
      ).toBe(false);
    }
    // Every later mission has silver: it is what hands are hired with.
    for (const id of [
      MissionId.ledger,
      MissionId.levy,
      MissionId.holdTheValley,
      MissionId.rivalBanner,
    ]) {
      expect(
        await has(id, TileResource.SilverDep),
        `${MISSION_KEYS[id]}: silver`,
      ).toBe(true);
    }
  });

  it('the mission maps are the same grid the game generates', async () => {
    for (const id of MISSION_ORDER) {
      const {map} = await mapFor(id);
      expect(map.play, `${id}: playable side`).toBe(96);
      // The scenery ring is real, editable tiles that nothing may walk on
      // — parseMapData's recomputeBlocked is what enforces it, and this is
      // the standing check that an authored file honours the same world
      // shape a generated one does.
      let walkableMargin = 0;
      for (let i = 0; i < tileCount(map.size); i++) {
        if (inPlayArea(map, tileX(i, map.size), tileY(i, map.size))) continue;
        if (!map.blocked[i]) walkableMargin++;
      }
      expect(walkableMargin, `${id}: walkable scenery`).toBe(0);
      // Nothing standing under a keep.
      expect(
        map.terrain.every(
          t => t === Terrain.Grass || t === Terrain.Water || t === Terrain.Rock,
        ),
      ).toBe(true);
    }
  });
});
