import {inBounds, tileIdx, tileX, tileY} from '../shared/grid.ts';
import {exactDist} from '../shared/math.ts';
import {buildingDef} from './defs/buildings.ts';
import type {Building} from './entities.ts';
import type {GameMap} from './map.ts';
import {findPath, findPathToAdjacent, shut} from './path.ts';
import type {Unit} from './units.ts';

/**
 * Telling "the walk is over" from "the walk failed".
 *
 * Every errand ends the same way in the data: `unit.path` goes null. But a
 * route lost to new construction nulls it too, and the owner systems could
 * not tell the difference — so a hauler drew a good out of a storehouse
 * tiles away, a woodcutter deposited into a hut he never reached, and a
 * recruit was consumed by a barracks he never entered. Movement re-plans
 * around obstructions now, which makes that rare rather than routine, but a
 * goal sealed off entirely still ends the walk short.
 *
 * So arrival is asked, not assumed: the owner knows where it sent the unit,
 * and checks it is standing there before running what happens on arrival.
 */

/**
 * How close counts as standing there. A walk to a building ends on a tile
 * ringing its footprint, and a unit that consumed its last waypoint sits
 * exactly on that tile's center — 0.5 out from an orthogonal neighbour,
 * ~0.71 from a diagonal one. The rest is slack: comfortably wider than any
 * real arrival, and far narrower than the failures this rules out, which
 * leave the unit tiles or a whole map away.
 */
const ARRIVAL_REACH = 1.5;

/** Distance from a unit to the nearest point of a footprint. */
export function distToFootprint(
  unit: Unit,
  x: number,
  y: number,
  w: number,
  h: number,
): number {
  const cx = Math.max(x, Math.min(unit.x, x + w));
  const cy = Math.max(y, Math.min(unit.y, y + h));
  return exactDist(unit.x - cx, unit.y - cy);
}

/** Is the unit standing at this building, or merely out of route to it? */
export function atBuilding(unit: Unit, b: Building): boolean {
  return distToFootprint(unit, b.x, b.y, b.w, b.h) <= ARRIVAL_REACH;
}

/** Is the unit standing at this map tile? */
export function atTile(unit: Unit, tile: number, size: number): boolean {
  return (
    distToFootprint(unit, tileX(tile, size), tileY(tile, size), 1, 1) <=
    ARRIVAL_REACH
  );
}

/**
 * Put the unit back on the road to this building. False when there is no way
 * there at all — the caller decides what giving up costs, since only it knows
 * whether a job, a post or a load of cargo is riding on the walk.
 *
 * An empty path would mean the pathfinder considers the unit already
 * adjacent while the reach test above says otherwise; the two agree by
 * construction, but treating it as failure keeps a disagreement from
 * becoming a unit that re-plans forever and never moves.
 */
export function walkToBuilding(map: GameMap, unit: Unit, b: Building): boolean {
  return walk(
    unit,
    findPathToAdjacent(
      map,
      Math.floor(unit.x),
      Math.floor(unit.y),
      b.x,
      b.y,
      b.w,
      b.h,
    ),
  );
}

/**
 * The walk to a building a hauler is fetching from. A plain shelf is
 * reached from any tile ringing it, like every other errand; a source that
 * has to be worked to give anything up is worked from one side
 * (BuildingDef.drawFrom — the well's crank), so the walk aims at that tile
 * from the start. Only when it is shut or cut off does he settle for the
 * rest of the ring, and draw from wherever that leaves him.
 *
 * Every walk to a source goes through here — the dispatch, a man taking a
 * load from the doorstep he is standing on, and the re-plan of a walk that
 * ended short — so all three put him on the same tile.
 */
export function findPathToSource(
  map: GameMap,
  sx: number,
  sy: number,
  b: Building,
): number[] | null {
  const from = buildingDef(b.type).drawFrom;
  const fx = from ? b.x + from[0] : 0;
  const fy = from ? b.y + from[1] : 0;
  return (
    (from && enterable(map, sx, sy, fx, fy) && findPath(map, sx, sy, fx, fy)) ||
    findPathToAdjacent(map, sx, sy, b.x, b.y, b.w, b.h)
  );
}

/**
 * Whether a walk from (sx, sy) could end on tile (x, y) at all — false only
 * when it certainly cannot, so the answer agrees with findPath. A step in
 * comes from a neighbour, and a diagonal one needs both of its orthogonals
 * open (no corner cutting, path.ts), so an open orthogonal neighbour is the
 * whole question — unless he is already on the tile or beside it, where
 * the search starts and the rule about where it may stand does not apply.
 *
 * Asked first because the answer is otherwise expensive: a goal the search
 * cannot enter costs it the whole walkable component to prove (path.ts,
 * the runaway cap), and a draw tile hemmed in on its three open sides by
 * houses or trees would charge that to every water haul in the village
 * before the ring fallback ran.
 */
function enterable(
  map: GameMap,
  sx: number,
  sy: number,
  x: number,
  y: number,
): boolean {
  if (Math.abs(sx - x) + Math.abs(sy - y) <= 1) return true;
  const size = map.size;
  const open = (nx: number, ny: number): boolean =>
    inBounds(nx, ny, size) && !shut(map, tileIdx(nx, ny, size));
  return open(x + 1, y) || open(x - 1, y) || open(x, y + 1) || open(x, y - 1);
}

/** Put the unit back on the road to the source it is fetching from. False
 * when there is no way. */
export function walkToSource(map: GameMap, unit: Unit, b: Building): boolean {
  return walk(
    unit,
    findPathToSource(map, Math.floor(unit.x), Math.floor(unit.y), b),
  );
}

/** Put the unit back on the road to this tile. False when there is no way. */
export function walkToTile(map: GameMap, unit: Unit, tile: number): boolean {
  const size = map.size;
  return walk(
    unit,
    findPathToAdjacent(
      map,
      Math.floor(unit.x),
      Math.floor(unit.y),
      tileX(tile, size),
      tileY(tile, size),
      1,
      1,
    ),
  );
}

function walk(unit: Unit, path: number[] | null): boolean {
  if (!path || path.length === 0) return false;
  unit.path = path;
  unit.pathIdx = 0;
  return true;
}
