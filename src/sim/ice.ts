import {tileCount, tileX, tileY} from '../shared/grid.ts';
import {iceBears, isWinter} from './defs/balance.ts';
import {inPlayArea, type GameMap} from './map.ts';
import * as Terrain from './terrainEnum.ts';

/**
 * PROTOTYPE: where the ice lies. Apart from systems/ice.ts, which is the
 * sim acting on it, because the client lays the same ice over its own copy
 * of the map and has no business importing a system to do it.
 */

/** What the ice is laid on, and over: enough of a map to say where the
 * lakes are. The client's copy of the map qualifies, which is the point. */
export type IceMap = Pick<
  GameMap,
  'size' | 'play' | 'terrain' | 'buildingAt' | 'ice' | 'iceBears' | 'winter'
>;

/** A tile that freezes: open water inside the play square. */
export function isLake(map: IceMap, i: number): boolean {
  const size = map.size;
  return (
    map.terrain[i] === Terrain.Water &&
    map.buildingAt[i]! < 0 &&
    inPlayArea(map, tileX(i, size), tileY(i, size))
  );
}

/**
 * Bring `map.ice` and `map.winter` up to `tick`, and say whether either had
 * to change. The one rule for where a man may walk in winter, and how fast, shared by the sim and by
 * whatever predicts the sim (net/predict.ts paths on the client's map with
 * the same pathfinder, and would walk round a lake the server crosses).
 */
export function layIce(map: IceMap, tick: number): boolean {
  const bears = iceBears(tick);
  const winter = isWinter(tick);
  const turned = map.winter !== winter;
  map.winter = winter;
  if (map.ice && map.iceBears === bears) return turned;
  const ice = (map.ice ??= new Uint8Array(tileCount(map.size)));
  map.iceBears = bears;
  for (let i = 0; i < ice.length; i++) ice[i] = bears && isLake(map, i) ? 1 : 0;
  return true;
}
