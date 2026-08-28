import {factionTint} from '../render/factionPalette';
import {
  background,
  goldOre,
  grass,
  ironOre,
  leafDark,
  rock,
  rockDark,
  silverOre,
  stoneRoad,
  water,
} from '../render/palette';
import {playMin, type PlayArea} from '../sim/map';
import * as PathLevel from '../sim/pathLevelEnum.ts';
import * as Terrain from '../sim/terrainEnum.ts';
import * as TileResource from '../sim/tileResourceEnum.ts';

/**
 * The minimap's ground painting, kept apart from the canvas so it is a
 * pure function of map arrays — the component owns pixels and pointers,
 * this owns what color a tile is. Everything here draws from palette.ts,
 * so the chart stays in the same key as the ground it abbreviates.
 */

/** The tile arrays the chart reads — structurally a MapSnapshot, named so
 * the painter (and its test) can't quietly grow a dependency on the rest. */
export interface MinimapTiles extends PlayArea {
  terrain: Uint8Array;
  resource: Uint8Array;
  pathLevel: Uint8Array;
}

type Rgb = readonly [number, number, number];

function rgb(color: number): Rgb {
  return [(color >> 16) & 255, (color >> 8) & 255, color & 255];
}

const GRASS = rgb(grass);
const WATER = rgb(water);
const MOUNTAIN = rgb(rock);
const FOREST = rgb(leafDark);
const STONE = rgb(rockDark);
const IRON = rgb(ironOre);
const SILVER = rgb(silverOre);
const GOLD = rgb(goldOre);
const ROAD = rgb(stoneRoad);
/** What unexplored ground reads as — the scene's own unknown color, so the
 * chart's dark matches the fog's dark on the map beside it. */
const UNKNOWN = rgb(background);

/** Bandits keep their in-world grey on the chart too — a camp should read
 * as somebody's, and grey is whose it is. */
const BANDIT_TINT = 0x9d968a;
/** Warm white, in the HUD's own key rather than a printer's #ffffff. */
const VIEWER_TINT = 0xf7f4ea;

/**
 * What color a dot or rectangle wears: the viewer is white — the one
 * banner that must read instantly is your own, and white is the tint no
 * seat's faction color ever is — rivals wear their faction tints, and
 * bandits their in-world grey.
 */
export function ownerTint(owner: number, viewer: number): number {
  if (owner === viewer) return VIEWER_TINT;
  return factionTint(owner) ?? BANDIT_TINT;
}

/**
 * One tile's color on the chart. Terrain first — a deposit only ever sits
 * on the terrain that bears it, but the chart must never paint ore where a
 * mountain is the story. Roads last: a road is worth a pixel, a trail is
 * noise at this scale.
 */
export function tileRgb(
  terrain: number,
  resource: number,
  pathLevel: number,
): Rgb {
  if (terrain === Terrain.Water) return WATER;
  if (terrain === Terrain.Rock) return MOUNTAIN;
  switch (resource) {
    case TileResource.Wood:
      return FOREST;
    case TileResource.Rock:
      return STONE;
    case TileResource.IronDep:
      return IRON;
    case TileResource.SilverDep:
      return SILVER;
    case TileResource.GoldDep:
      return GOLD;
  }
  if (pathLevel === PathLevel.Road) return ROAD;
  return GRASS;
}

/**
 * Paint the play square — one pixel per tile, play² of them — into an RGBA
 * buffer, shaded by the fog. `shade` answers in world coordinates (0..1,
 * the fog's own litAt scale) and 0 paints the scene's unknown color, so
 * unexplored ground is the same dark on the chart as on the map. The
 * scenery ring is cropped out entirely: the camera can't go there, and on
 * a 160px chart every ring pixel is a play pixel lost.
 */
export function paintBase(
  map: MinimapTiles,
  shade: (x: number, z: number) => number,
  out: Uint8ClampedArray,
): void {
  const p0 = playMin(map);
  const {size, play, terrain, resource, pathLevel} = map;
  let o = 0;
  for (let z = 0; z < play; z++) {
    const row = (z + p0) * size + p0;
    for (let x = 0; x < play; x++) {
      const i = row + x;
      const c = tileRgb(terrain[i]!, resource[i]!, pathLevel[i]!);
      const l = shade(x + p0 + 0.5, z + p0 + 0.5);
      out[o++] = UNKNOWN[0] + (c[0] - UNKNOWN[0]) * l;
      out[o++] = UNKNOWN[1] + (c[1] - UNKNOWN[1]) * l;
      out[o++] = UNKNOWN[2] + (c[2] - UNKNOWN[2]) * l;
      out[o++] = 255;
    }
  }
}
