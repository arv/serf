import type {Enum} from '../shared/enum.ts';
import * as GoodId from '../sim/defs/goodIdEnum.ts';

type GoodId = Enum<typeof GoodId>;
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

/**
 * PROTOTYPE: ?season=spring|fall|winter repaints the valley in that
 * season's key so the look can be judged before any of the season design
 * is built. Summer is the printed game; ?winter is the old spelling.
 */
export type Season = 'spring' | 'summer' | 'fall' | 'winter';
function seasonFromUrl(): Season {
  if (typeof location === 'undefined') return 'summer';
  const params = new URLSearchParams(location.search);
  const named = params.get('season');
  if (named === 'spring' || named === 'fall' || named === 'winter') {
    return named;
  }
  return params.has('winter') ? 'winter' : 'summer';
}
export const season = seasonFromUrl();
/** A color that changes with the season; a season left out keeps summer's. */
const s = (summer: number, others: Partial<Record<Season, number>>): number =>
  others[season] ?? summer;

// ——— World ———

/** Base meadow green (ground planes, wardrobe fitting room). */
export const grass = s(0x55a02a, {
  spring: 0x6cbf3a,
  fall: 0x9a9a3a,
  winter: 0xe4ebf1,
});
/** Olive meadow patches. */
export const grassDry = s(0x8ba342, {
  spring: 0x9cba4a,
  fall: 0xb5903c,
  winter: 0xd9dfe0,
});
export const water = s(0x2f7e96, {fall: 0x3a7688, winter: 0xa9c6d6});
export const waterShore = s(0x58aec0, {winter: 0xd3e3ec});
/** The middle of the lake. */
export const waterDeep = s(0x14526e, {winter: 0x7fa6bd});
/** Worn dirt. */
export const earthTrail = s(0x9b7d4e, {winter: 0x9a8c7a});
/** Pavers. */
export const stoneRoad = 0x8f8878;

// ——— Terrain painting: meadow hue range + bank/bed tones ———

/** Vivid comic green. */
export const grassLush = s(0x5bb02f, {
  spring: 0x74cc40,
  fall: 0x8f9e34,
  winter: 0xeaf0f5,
});
export const grassOlive = s(0x7a9e44, {
  spring: 0x8fbf4e,
  fall: 0xa8963f,
  winter: 0xdde5ec,
});
/** Sun-dried patches. */
export const grassGold = s(0xaaa04e, {
  spring: 0xb9c95a,
  fall: 0xc79a3c,
  winter: 0xd8dcd2,
});
/** Trodden ground around buildings. */
export const trampledEarth = s(0x8d7146, {fall: 0x86683f, winter: 0xa59a8a});
/** Mossy waterline. */
export const bankMoss = s(0x3f6030, {
  spring: 0x4a7a36,
  fall: 0x5a5a2c,
  winter: 0xb9c6cc,
});
export const riverbed = s(0x3c5638, {winter: 0x6f8c9c});

// ——— Scatter ———

/** Bright young stalk. */
export const stalk = s(0xa8c94f, {
  spring: 0xb8dc58,
  fall: 0xd2b24f,
  winter: 0xcfd3bd,
});
export const stalkOld = s(0x7fa03c, {
  spring: 0x8fb844,
  fall: 0xb08a3a,
  winter: 0xb5b59a,
});
/** Rich tuft green. */
export const leaf = s(0x4f8f2a, {
  spring: 0x5aa832,
  fall: 0xb5762a,
  winter: 0x5f7f52,
});
export const leafDark = s(0x2e6b1e, {
  spring: 0x347a22,
  fall: 0x8a4a1e,
  winter: 0x3c5a3c,
});
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
/** Glowing lanterns — a window with a fire behind it, the light on the
 * stone around it. Deeper and more saturated than the light reads on
 * screen: the renderer grades ACES filmic at 1.32 exposure, which walks a
 * bright warm colour toward white, and the paler amber this started at
 * (0xffc46b) came out of it as cream. */
export const lantern = 0xffb23c;

// ——— Atmosphere ———

/** Hemisphere sky. */
export const skyLight = s(0xcfe4f7, {
  spring: 0xd6ecff,
  fall: 0xe8dcc8,
  winter: 0xd6e4ff,
});
/** Green bounce light. */
export const groundBounce = s(0x7f9a50, {
  spring: 0x8cb058,
  fall: 0xa08a50,
  winter: 0xb4c4dc,
});
export const background = s(0x223526, {fall: 0x2e2a1e, winter: 0x2b3542});
/** Distant pale haze. */
export const fog = s(0x9cc0a8, {
  spring: 0xa8cdb4,
  fall: 0xc9b99a,
  winter: 0xc6d3e0,
});

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
  [GoodId.water]: 0x5a8ab0,
  [GoodId.wheat]: 0xe8d9a0,
  [GoodId.wood]: 0x8fae4f,
  [GoodId.stone]: 0x8d8577,
  [GoodId.iron]: 0x6e6259,
  [GoodId.silver]: 0xb9c0c8,
  [GoodId.gold]: 0xd4a93c,
  [GoodId.sword]: 0xd8dde3,
  [GoodId.spear]: 0xb08d57,
  [GoodId.bow]: 0x9a7b4f,
  [GoodId.ale]: 0xefe8f0,
  [GoodId.flour]: 0xe9e2d4,
  [GoodId.food]: 0xd9a860,
  [GoodId.axe]: 0xb87f4a,
  [GoodId.pickaxe]: 0x84796e,
  [GoodId.scythe]: 0xc2b089,
  [GoodId.hammer]: 0x9a8d80,
  [GoodId.cauldron]: 0xb0763f,
  [GoodId.rod]: 0xa08a5f,
};
