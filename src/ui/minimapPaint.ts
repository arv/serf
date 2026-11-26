import {BANDIT_TINT, factionTint} from '../render/factionPalette';
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

/** The snow that lies on the chart, a touch under the HUD's own white so
 * the viewer's dots still read against it. */
const SNOW: Rgb = [0xd9, 0xe2, 0xec];

/**
 * What the season does to the chart, as the scene has it this moment: how
 * much snow lies (0..1), and the scene's own unknown and water colors,
 * which the seasons turn. Absent, the chart is the printed summer one.
 */
export interface ChartSeason {
  snow: number;
  unknown: number;
  water: number;
}

/** How much of the lying snow a tile shows: open ground nearly all of it,
 * a wood only its dusting, a road what the carts have left. */
function snowShare(
  terrain: number,
  resource: number,
  pathLevel: number,
): number {
  if (terrain === Terrain.Rock) return 0.6;
  if (resource === TileResource.Wood) return 0.4;
  if (resource !== TileResource.None) return 0.5;
  if (pathLevel === PathLevel.Road) return 0.35;
  return 0.9;
}

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
  season?: ChartSeason,
): void {
  const p0 = playMin(map);
  const {size, play, terrain, resource, pathLevel} = map;
  const unknown = season ? rgb(season.unknown) : UNKNOWN;
  const iced = season ? rgb(season.water) : WATER;
  const snow = season?.snow ?? 0;
  let o = 0;
  for (let z = 0; z < play; z++) {
    const row = (z + p0) * size + p0;
    for (let x = 0; x < play; x++) {
      const i = row + x;
      const t = terrain[i]!;
      const c = tileRgb(t, resource[i]!, pathLevel[i]!);
      const l = shade(x + p0 + 0.5, z + p0 + 0.5);
      // Water takes the scene's own tone, which winter ices; everything
      // else takes its share of the snow.
      const water = t === Terrain.Water;
      const to = water ? iced : SNOW;
      const k = water ? 1 : snow * snowShare(t, resource[i]!, pathLevel[i]!);
      for (let ch = 0; ch < 3; ch++) {
        const lit = c[ch]! + (to[ch]! - c[ch]!) * k;
        out[o++] = unknown[ch]! + (lit - unknown[ch]!) * l;
      }
      out[o++] = 255;
    }
  }
}
