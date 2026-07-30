import type { GoodId } from '../sim/defs/goods';
import { THEME } from './medieval';

/**
 * The feudal-Japan palette, tuned for the Battle Realms look: saturated
 * mossy greens, dark teal water, warm lacquered-orange architecture, lantern
 * glow. Every color in the game comes from here so the scene stays in key.
 * (Values are pre-tone-mapping; the renderer applies ACES filmic.)
 */
const japan = {
  // World
  grass: 0x53912e, // saturated valley green
  grassDry: 0x87973e, // olive meadow patches
  grassDark: 0x2e5a1c, // shaded lush grass
  water: 0x1d4a56, // dark moody teal
  waterShore: 0x3d7482,
  waterDeep: 0x0d2531, // the middle of the lake
  earthTrail: 0x9b7d4e, // worn dirt
  stoneRoad: 0x8f8878, // pavers
  // Terrain painting: meadow hue range + bank/bed tones
  grassLush: 0x4c8626, // vivid comic green
  grassOlive: 0x71863a,
  grassGold: 0xa39448, // sun-dried patches
  trampledEarth: 0x81653c, // trodden ground around buildings
  bankMoss: 0x2c451f, // dark mossy waterline
  riverbed: 0x2e3f2a,

  // Scatter
  bambooCulm: 0xa8c94f, // bright young culm
  bambooCulmOld: 0x7fa03c,
  bambooLeaf: 0x4f8f2a, // rich tuft green
  bambooLeafDark: 0x2e6b1e,
  rock: 0x7d7668, // mossier warm grey
  rockDark: 0x57534a,
  peakSnow: 0xdfe4e2, // mountain caps
  ironOre: 0x7a5c4f,
  silverOre: 0xb9c0c8,
  goldOre: 0xd4a93c,

  // Architecture — Battle Realms warm woods and orange roofs
  paper: 0xefe3cc, // shoji paper walls
  wood: 0x4a3220, // dark timber
  woodLight: 0x7d5a35,
  roofOrange: 0xc9722e, // the BR signature lacquered orange
  vermillion: 0xbf4342, // torii / accents
  roofDark: 0x3a3f4a, // charcoal tile roofs (enemy/neutral)
  indigo: 0x30437a, // cloth
  lantern: 0xffc46b, // glowing paper lanterns

  // Atmosphere
  skyLight: 0x8fb3d9, // hemisphere sky
  groundBounce: 0x5d6b3a, // green bounce light
  background: 0x0c1410, // near-black forest edge
  fog: 0x18271e, // deep green haze
} as const;

type Palette = { [K in keyof typeof japan]: number };

/**
 * Daylight overrides for the medieval look — the Warcraft/Settlers key:
 * bright saturated meadow, clear water, high warm sun, gentle blue haze.
 */
const medieval: Palette = {
  ...japan,
  grass: 0x55a02a,
  grassDry: 0x8ba342,
  grassDark: 0x357522,
  water: 0x2f7e96,
  waterShore: 0x58aec0,
  waterDeep: 0x14526e,
  grassLush: 0x5bb02f,
  grassOlive: 0x7a9e44,
  grassGold: 0xaaa04e,
  trampledEarth: 0x8d7146,
  bankMoss: 0x3f6030,
  riverbed: 0x3c5638,
  rock: 0x8b8375,
  rockDark: 0x666055,
  peakSnow: 0xedf2f4,
  skyLight: 0xcfe4f7,
  groundBounce: 0x7f9a50,
  background: 0x223526,
  fog: 0x9cc0a8,
};

export const palette: Palette = THEME === 'medieval' ? medieval : japan;

/** Color of a good when carried on a serf's shoulders (and in UI accents). */
export const goodColors: Record<GoodId, number> = {
  water: 0x5a8ab0,
  rice: 0xe8d9a0,
  bamboo: 0x8fae4f,
  stone: 0x8d8577,
  iron: 0x6e6259,
  silver: 0xb9c0c8,
  gold: 0xd4a93c,
  katana: 0xd8dde3,
  yari: 0xb08d57,
  yumi: 0x9a7b4f,
  sake: 0xefe8f0,
};
