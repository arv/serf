import type { GoodId } from '../sim/defs/goods';

/**
 * The game palette — the Warcraft/Settlers key: bright saturated meadow,
 * clear water, high warm sun, gentle blue haze. Every color in the game
 * comes from here so the scene stays in key. (Values are pre-tone-mapping;
 * the renderer applies ACES filmic.)
 */
export const palette = {
  // World
  grass: 0x55a02a, // base meadow green (ground planes, wardrobe fitting room)
  grassDry: 0x8ba342, // olive meadow patches
  water: 0x2f7e96,
  waterShore: 0x58aec0,
  waterDeep: 0x14526e, // the middle of the lake
  earthTrail: 0x9b7d4e, // worn dirt
  stoneRoad: 0x8f8878, // pavers
  // Terrain painting: meadow hue range + bank/bed tones
  grassLush: 0x5bb02f, // vivid comic green
  grassOlive: 0x7a9e44,
  grassGold: 0xaaa04e, // sun-dried patches
  trampledEarth: 0x8d7146, // trodden ground around buildings
  bankMoss: 0x3f6030, // mossy waterline
  riverbed: 0x3c5638,

  // Scatter
  stalk: 0xa8c94f, // bright young stalk
  stalkOld: 0x7fa03c,
  leaf: 0x4f8f2a, // rich tuft green
  leafDark: 0x2e6b1e,
  rock: 0x8b8375, // warm grey
  rockDark: 0x666055,
  peakSnow: 0xedf2f4, // mountain caps
  ironOre: 0x7a5c4f,
  silverOre: 0xb9c0c8,
  goldOre: 0xd4a93c,

  // Architecture — warm timber, pale plaster, cloth accents
  paper: 0xefe3cc, // pale plaster walls
  wood: 0x4a3220, // dark timber
  woodLight: 0x7d5a35,
  vermillion: 0xbf4342, // banners / accents
  indigo: 0x30437a, // cloth
  lantern: 0xffc46b, // glowing lanterns

  // Verdicts — the green/red pair the ghost and the reach outline both wear
  verdictGood: 0x7fbf6a,
  verdictBad: 0xd45252,

  // Atmosphere
  skyLight: 0xcfe4f7, // hemisphere sky
  groundBounce: 0x7f9a50, // green bounce light
  background: 0x223526,
  fog: 0x9cc0a8, // distant pale haze
} as const;

/** Color of a good when carried on a serf's shoulders (and in UI accents). */
export const goodColors: Record<GoodId, number> = {
  water: 0x5a8ab0,
  wheat: 0xe8d9a0,
  wood: 0x8fae4f,
  stone: 0x8d8577,
  iron: 0x6e6259,
  silver: 0xb9c0c8,
  gold: 0xd4a93c,
  sword: 0xd8dde3,
  spear: 0xb08d57,
  bow: 0x9a7b4f,
  ale: 0xefe8f0,
  flour: 0xe9e2d4,
  food: 0xd9a860,
};
