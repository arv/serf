/**
 * The game palette — the Warcraft/Settlers key: bright saturated meadow,
 * clear water, high warm sun, gentle blue haze. Every color in the game
 * comes from this file so the scene stays in key. (Values are
 * pre-tone-mapping; the renderer applies ACES filmic.)
 *
 * One export per color rather than one object holding all of them: a mesh
 * paints with two or three of these, and naming them at the import is both
 * the shorter read at the point of use and an honest list of what a file
 * puts on the screen.
 */
import type { GoodId } from '../sim/defs/goods';

// ——— World ———

/** Base meadow green (ground planes, wardrobe fitting room). */
export const grass = 0x55a02a;
/** Olive meadow patches. */
export const grassDry = 0x8ba342;
export const water = 0x2f7e96;
export const waterShore = 0x58aec0;
/** The middle of the lake. */
export const waterDeep = 0x14526e;
/** Worn dirt. */
export const earthTrail = 0x9b7d4e;
/** Pavers. */
export const stoneRoad = 0x8f8878;

// ——— Terrain painting: meadow hue range + bank/bed tones ———

/** Vivid comic green. */
export const grassLush = 0x5bb02f;
export const grassOlive = 0x7a9e44;
/** Sun-dried patches. */
export const grassGold = 0xaaa04e;
/** Trodden ground around buildings. */
export const trampledEarth = 0x8d7146;
/** Mossy waterline. */
export const bankMoss = 0x3f6030;
export const riverbed = 0x3c5638;

// ——— Scatter ———

/** Bright young stalk. */
export const stalk = 0xa8c94f;
export const stalkOld = 0x7fa03c;
/** Rich tuft green. */
export const leaf = 0x4f8f2a;
export const leafDark = 0x2e6b1e;
/** Warm grey. */
export const rock = 0x8b8375;
export const rockDark = 0x666055;
/** Mountain caps. */
export const peakSnow = 0xedf2f4;
export const ironOre = 0x7a5c4f;
export const silverOre = 0xb9c0c8;
export const goldOre = 0xd4a93c;

// ——— Architecture — warm timber, pale plaster, cloth accents ———

/** Pale plaster walls. */
export const paper = 0xefe3cc;
/** Dark timber. */
export const wood = 0x4a3220;
export const woodLight = 0x7d5a35;
/** Banners / accents. */
export const vermillion = 0xbf4342;
/** Cloth. */
export const indigo = 0x30437a;
/** Glowing lanterns. */
export const lantern = 0xffc46b;

// ——— Atmosphere ———

/** Hemisphere sky. */
export const skyLight = 0xcfe4f7;
/** Green bounce light. */
export const groundBounce = 0x7f9a50;
export const background = 0x223526;
/** Distant pale haze. */
export const fog = 0x9cc0a8;

// ——— Verdicts ———

/**
 * Green for a placement that will work — or for ground that still has
 * something on it — red for one that will not. Apart from the world colors
 * above on purpose: those are the key the scene is painted in, and these
 * two are feedback painted over it, in no key at all.
 */
export const verdictGood = 0x7fbf6a;
export const verdictBad = 0xd45252;

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
  axe: 0xb87f4a,
  pickaxe: 0x84796e,
  scythe: 0xc2b089,
  hammer: 0x9a8d80,
  cauldron: 0xb0763f,
  rod: 0xa08a5f,
};
