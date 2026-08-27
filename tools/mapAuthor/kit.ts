/**
 * The mission-map authoring kit: landforms, not seeds.
 *
 * The campaign's ground used to be whatever `generateMap` rolled at a
 * pinned seed — a smear of groves and outcrops that happened to be
 * winnable. It is checked-in files now (src/sim/defs/maps/), and a file
 * can say something. This kit is the vocabulary the seven mission recipes
 * next door say it in: a valley floor, a ridge, a river, a grove where
 * the lesson wants the player to look.
 *
 * Three phases, in this order, because each one reads what the last one
 * settled:
 *
 *   1. **Shape** — `meadow`, `mound`, `ridge`, `bowl`, `level`, `river`,
 *      `borders`. All of it writes the raw elevation `field` (~[0,1], the
 *      same field worldgen's `computeTerrain` builds from noise), never
 *      heights: what floods and what stands is decided from one number
 *      per tile, so a basin cut after a hill still knows it is a basin.
 *      Order inside the phase is the order a valley is made in: raise the
 *      country, then `level` the town site out of it, then cut the water
 *      — `level` would fill a river back in, and a river cut first has
 *      banks the levelling would flatten.
 *   2. **Settle** — `settle()` floods the field below the lake line,
 *      drowns anything the water cut off, and turns the field into the
 *      world heights with worldgen's own curve. Everything downstream
 *      reads real terrain.
 *   3. **Dress** — `grove`, `outcrop`, `seam`, `plantBelt`. Resources go
 *      on ground that has stopped moving, so nothing is planted in a lake.
 *
 * Then `finish()` audits and serializes.
 *
 * Determinism is by construction: every "random" detail here is `hash2`
 * of the tile, so a recipe is a pure function of what it says. There is
 * no Rng in this file on purpose — an authored map that needs a seed to
 * explain its own shape is not authored.
 *
 * On the border recipe: `borders` reproduces the band-and-margin
 * machinery of `generateMap`'s rim pass (wobbled depth, meandering
 * headlands, the far-field profile the horizon is drawn from) so an
 * authored valley sits in the same landscape as a generated one. It is a
 * deliberate snapshot rather than a shared import — worldgen's rim is
 * woven through its rng draw order, and the seeded worlds the balance
 * tests are pinned to cannot afford a refactor there. The mission files
 * are frozen artifacts anyway: they are re-authored when someone means
 * to, not rebuilt on every worldgen tweak.
 */
import { hash2 } from '../../src/shared/math.ts';
import { gridFor, inBounds, marginFor, tileCount, tileIdx } from '../../src/shared/grid.ts';
import {
  Terrain,
  TileResource,
  WATER_ACCESS_RADIUS,
  RESOURCE_CODE,
  countResourceNear,
  inPlayArea,
  playEdgeDist,
  recomputeBlocked,
  resourceBlocks,
  tileBlocks,
  type GameMap,
  type StartSpot,
  type TileResourceKind,
} from '../../src/sim/map.ts';
import { WOOD_MAX_AMT } from '../../src/sim/defs/balance.ts';
import { serializeMapFile } from '../../src/sim/mapFile.ts';
import { canPlace } from '../../src/sim/world.ts';
import {
  buildingDef,
  gatherOrigin,
  gatherRecipeOf,
  type BuildingTypeId,
} from '../../src/sim/defs/buildings.ts';


/** Below this field value a tile floods (worldgen's LAKE_LEVEL_T). */
export const LAKE_LEVEL = 0.26;

/**
 * The field values the landforms are written in. Everything a recipe
 * says is a distance from these: MEADOW is buildable town ground, HILL
 * is where worldgen would put an outcrop, PEAK is bare mountain.
 * (Through the height curve below they come out at roughly 0.24, 1.05
 * and 2.0 world units.)
 */
export const WATER = 0.18;
export const SHALLOW = 0.24;
export const MEADOW = 0.42;
export const RISE = 0.58;
export const HILL = 0.72;
export const PEAK = 0.9;

export type RimStyle = 'sea' | 'ridge' | 'forest';
/** North, east, south, west — the order worldgen indexes its sides in. */
export interface BorderStyles {
  n: RimStyle;
  e: RimStyle;
  s: RimStyle;
  w: RimStyle;
}

export interface Pt {
  x: number;
  y: number;
}

function ease01(t: number): number {
  const c = t < 0 ? 0 : t > 1 ? 1 : t;
  return c * c * (3 - 2 * c);
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Distance from a point to a segment — the metric every ridge and river
 * in this kit is drawn with. */
function distToSegment(px: number, py: number, a: Pt, b: Pt): number {
  const vx = b.x - a.x;
  const vy = b.y - a.y;
  const len2 = vx * vx + vy * vy;
  const t = len2 === 0 ? 0 : clamp(((px - a.x) * vx + (py - a.y) * vy) / len2, 0, 1);
  return Math.hypot(px - (a.x + vx * t), py - (a.y + vy * t));
}

/** Smooth value noise in [0,1] — worldgen's, so authored ground carries
 * the same grain as generated ground. */
function valueNoise(seed: number, x: number, y: number, scale: number): number {
  const fx = x / scale;
  const fy = y / scale;
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const sx = ease01(fx - x0);
  const sy = ease01(fy - y0);
  const h = (cx: number, cy: number): number => hash2(seed + cx * 131, seed * 7 + cy * 337);
  const a = h(x0, y0);
  const b = h(x0 + 1, y0);
  const c = h(x0, y0 + 1);
  const d = h(x0 + 1, y0 + 1);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

/** Tiles a seam aims to cover, and how far it may spread (worldgen's). */
const SEAM_TILES = 6;
const SEAM_REACH = 3;

export interface AuditReport {
  name: string;
  lines: string[];
  problems: string[];
}

/**
 * One valley under construction. Grids are the map's own; `field` is the
 * raw elevation every shaping call writes and `settle` reads.
 */
export class Valley {
  readonly size: number;
  readonly play: number;
  readonly margin: number;
  /** First and one-past-last playable row/column. */
  readonly p0: number;
  readonly p1: number;
  readonly terrain: Uint8Array;
  readonly resource: Uint8Array;
  readonly resourceAmt: Uint8Array;
  readonly field: Float32Array;
  readonly height: Float32Array;
  /** Border-ridge profile, 0..1, fed into the field by `borders`. */
  private readonly rimRamp: Float32Array;
  /** Border-forest tiles: 1 = full belt, 2 = ragged inner treeline. */
  private readonly belt: Uint8Array;
  private styles: BorderStyles = { n: 'forest', e: 'forest', s: 'forest', w: 'forest' };
  /** Which style owns a perimeter position, set by `borders` — the far
   * field has to carry the same handover the band inside does, or the
   * horizon changes style at the boundary. */
  private perimeterStyle: (p: number, i: number) => RimStyle = () => 'forest';
  /** Salt for the incidental detail (rim teeth, grove edges, grain). */
  readonly grain: number;
  /**
   * Half-turn symmetry: every detail draw is canonicalized so a tile and
   * its 180-degree twin get the same answer. A duel map that hands one
   * reeve a thicker wood than the other has decided the match with noise,
   * and this is how the recipe stops arguing about it — it composes one
   * half and mirrors it, and the grain mirrors too. The rim band is left
   * out of it (a border is scenery, and its wobble runs around the
   * perimeter rather than across the grid).
   */
  private readonly mirror: boolean;
  private settled = false;

  constructor(play: number, grain: number, opts: { mirror?: boolean } = {}) {
    this.mirror = opts.mirror ?? false;
    this.play = play;
    this.size = gridFor(play);
    this.margin = marginFor(play);
    this.p0 = this.margin;
    this.p1 = this.margin + play;
    this.grain = grain;
    const tiles = tileCount(this.size);
    this.terrain = new Uint8Array(tiles);
    this.resource = new Uint8Array(tiles);
    this.resourceAmt = new Uint8Array(tiles);
    this.field = new Float32Array(tiles);
    this.height = new Float32Array(tiles);
    this.rimRamp = new Float32Array(tiles);
    this.belt = new Uint8Array(tiles);
  }

  idx(x: number, y: number): number {
    return tileIdx(x, y, this.size);
  }

  inPlay(x: number, y: number): boolean {
    return inPlayArea(this, x, y);
  }

  isGrass(x: number, y: number): boolean {
    return inBounds(x, y, this.size) && this.terrain[this.idx(x, y)] === Terrain.Grass;
  }

  /**
   * The place a place maps to under the map's half turn, answered as a
   * tile centre.
   *
   * The snap is the whole point. Tile (x, y) turns into tile
   * (size-1-x, size-1-y), so the image of a place has to be the centre of
   * that tile — hand back `size - p` for an integer p and every op that
   * floors its box lands one tile off on the far side of the board, which
   * is a mirror only until someone measures it.
   */
  rotated(p: Pt): Pt {
    return { x: this.size - (Math.floor(p.x) + 0.5), y: this.size - (Math.floor(p.y) + 0.5) };
  }

  /** A place and its half-turn twin, for the ops a mirrored map does
   * twice. `for (const p of v.pair(at(-11, -6))) v.silverSeam(180, p)`. */
  pair(p: Pt): [Pt, Pt] {
    return [{ x: Math.floor(p.x) + 0.5, y: Math.floor(p.y) + 0.5 }, this.rotated(p)];
  }

  /** A tile's own index, or the lower of it and its half-turn twin's on a
   * mirrored map — a key two twins agree on, for ordering that must not
   * come out reversed on the far side of the board. */
  private canon(i: number): number {
    return this.mirror ? Math.min(i, this.twinOf(i)) : i;
  }

  /** A tile's half-turn twin. */
  private twinOf(i: number): number {
    const x = i % this.size;
    const y = (i / this.size) | 0;
    return this.idx(this.size - 1 - x, this.size - 1 - y);
  }

  /** Per-tile detail draw in [0,1) — the kit's stand-in for an rng. */
  jitter(x: number, y: number, salt: number): number {
    // Under mirror symmetry both twins draw from the lower index, so the
    // two halves of a duel map fray identically.
    const i = this.mirror
      ? Math.min(this.idx(x, y), this.idx(this.size - 1 - x, this.size - 1 - y))
      : this.idx(x, y);
    return hash2(i + salt * 7919, this.grain + salt);
  }

  noise(salt: number, x: number, y: number, scale: number): number {
    const seed = this.grain + salt * 977;
    const v = valueNoise(seed, x, y, scale);
    if (!this.mirror) return v;
    // Mirrored about the TILE, `size - 1 - x`: these are tile coordinates,
    // and averaging against `size - x` puts the two halves one tile out of
    // phase — a grove that frays differently on the far side of the board.
    return (v + valueNoise(seed, this.size - 1 - x, this.size - 1 - y, scale)) / 2;
  }

  /** Every tile of the grid, playable or scenery. */
  private each(fn: (x: number, y: number, i: number) => void): void {
    for (let y = 0; y < this.size; y++) {
      for (let x = 0; x < this.size; x++) fn(x, y, this.idx(x, y));
    }
  }

  // --- 1. Shape ---------------------------------------------------------

  /**
   * The valley floor everything else is cut into: rolling meadow at
   * `level`, wandering by `roughness`. Two scales, like worldgen's base —
   * a broad swell and a finer ripple — so the ground reads as land rather
   * than as a table.
   */
  meadow(level = MEADOW, roughness = 0.07): this {
    this.each((x, y, i) => {
      this.field[i] =
        level +
        (this.noise(1, x, y, 17) - 0.5) * 2 * roughness +
        (this.noise(2, x, y, 6) - 0.5) * roughness;
    });
    return this;
  }

  /**
   * A hill: `amp` added at the middle, easing to nothing at `r`. The
   * workhorse — a knoll for a quarry, a shoulder for a mine, the swell a
   * castle sits on.
   */
  mound(c: Pt, r: number, amp: number, crag = 0): this {
    // Boxes are floored and a tile wider than the radius, never rounded:
    // a place named at a half tile has to cover the same ground as its
    // half-turn twin on a mirrored map, and `Math.round` rounds both 45.5
    // and 106.5 up — one tile of asymmetry, in the seam that decides who
    // mines first.
    const R = Math.ceil(r) + 1;
    for (let dy = -R; dy <= R; dy++) {
      for (let dx = -R; dx <= R; dx++) {
        const x = Math.floor(c.x) + dx;
        const y = Math.floor(c.y) + dy;
        if (!inBounds(x, y, this.size)) continue;
        const d = Math.hypot(x + 0.5 - c.x, y + 0.5 - c.y);
        if (d > r) continue;
        const i = this.idx(x, y);
        const t = ease01(1 - d / r);
        const rough = crag > 0 ? (this.noise(3, x, y, 4.5) - 0.5) * crag * t : 0;
        this.field[i] = this.field[i]! + amp * t + rough;
      }
    }
    return this;
  }

  /**
   * A range: `amp` along a polyline, easing to nothing `halfWidth` out.
   * Crests wander (a ruler-straight ridge reads as a wall), so the line a
   * recipe gives is the spine, not the silhouette.
   */
  ridge(spine: Pt[], halfWidth: number, amp: number, crag = 0.35): this {
    this.each((x, y, i) => {
      let d = Infinity;
      for (let s = 0; s + 1 < spine.length; s++) {
        const dd = distToSegment(x + 0.5, y + 0.5, spine[s]!, spine[s + 1]!);
        if (dd < d) d = dd;
      }
      const wander = (this.noise(4, x, y, 13) - 0.5) * halfWidth * 0.55;
      const t = ease01(1 - (d + wander) / halfWidth);
      if (t <= 0) return;
      const rough = (this.noise(5, x, y, 5) - 0.5) * crag;
      this.field[i] = this.field[i]! + (amp + rough) * t;
    });
    return this;
  }

  /**
   * A wall of crag: a ridge whose core is bare rock.
   *
   * Height alone stops nobody — the sim paths on the flat grid, and a
   * mountain in the field is scenery a serf strolls over. Terrain does:
   * `Terrain.Rock` is unwalkable and unbuildable, the same stuff the
   * border ranges are made of. So a map that means to close a road says
   * it with this, and a map that only means to give the eye something to
   * climb says it with `ridge`.
   *
   * `bare` is how far out from the spine the rock reaches, as a fraction
   * of the half-width; beyond it the ridge is ordinary rising ground, so
   * the wall has shoulders rather than edges.
   */
  wall(spine: Pt[], halfWidth: number, amp: number, bare = 0.5): this {
    this.each((x, y, i) => {
      let d = Infinity;
      for (let s = 0; s + 1 < spine.length; s++) {
        const dd = distToSegment(x + 0.5, y + 0.5, spine[s]!, spine[s + 1]!);
        if (dd < d) d = dd;
      }
      const wander = (this.noise(10, x, y, 12) - 0.5) * halfWidth * 0.5;
      const t = ease01(1 - (d + wander) / halfWidth);
      if (t <= 0) return;
      this.field[i] = this.field[i]! + (amp + (this.noise(11, x, y, 4) - 0.5) * 0.3) * t;
      // The crest goes to stone, its edge frayed per tile so the cliff
      // line is not a drawn curve.
      if (t > bare + (this.jitter(x, y, 23) - 0.5) * 0.16) this.terrain[i] = Terrain.Rock;
    });
    return this;
  }

  /** A hollow: `depth` taken out of the middle, easing to nothing at `r`. */
  bowl(c: Pt, r: number, depth: number): this {
    return this.mound(c, r, -depth);
  }

  /**
   * Level ground: the field pulled to `to` inside `r`, released over
   * `feather` tiles. This is what makes a town site buildable and a mine
   * shoulder standable — worldgen's home-plateau clamp, aimed by hand.
   */
  level(c: Pt, r: number, to: number, feather = 6): this {
    const R = Math.ceil(r + feather) + 1;
    for (let dy = -R; dy <= R; dy++) {
      for (let dx = -R; dx <= R; dx++) {
        const x = Math.floor(c.x) + dx;
        const y = Math.floor(c.y) + dy;
        if (!inBounds(x, y, this.size)) continue;
        const d = Math.hypot(x + 0.5 - c.x, y + 0.5 - c.y);
        if (d > r + feather) continue;
        const i = this.idx(x, y);
        const t = ease01((d - r) / feather); // 0 inside, 1 past the feather
        const target = to + (this.noise(6, x, y, 9) - 0.5) * 0.03;
        this.field[i] = target + (this.field[i]! - target) * t;
      }
    }
    return this;
  }

  /**
   * A watercourse: the field cut below the lake line along a polyline, with
   * banks that rise out of it. `halfWidth` is the wet half-width; the
   * channel wanders on the same grain as everything else, so a river drawn
   * with two points still bends.
   */
  river(course: Pt[], halfWidth: number, bank = 0.1): this {
    this.each((x, y, i) => {
      let d = Infinity;
      for (let s = 0; s + 1 < course.length; s++) {
        const dd = distToSegment(x + 0.5, y + 0.5, course[s]!, course[s + 1]!);
        if (dd < d) d = dd;
      }
      const wander = (this.noise(7, x, y, 15) - 0.5) * halfWidth * 0.9;
      const w = d + wander;
      if (w <= halfWidth) {
        // Wet: deep in the middle, shelving up to the waterline.
        const t = ease01(w / halfWidth);
        this.field[i] = Math.min(this.field[i]!, WATER + t * (SHALLOW - WATER));
      } else if (w <= halfWidth + 3) {
        // Banks: a low levee, so the course reads as cut rather than spilled.
        const t = ease01(1 - (w - halfWidth) / 3);
        this.field[i] = this.field[i]! + bank * t;
      }
    });
    return this;
  }

  /**
   * A ford: a bar of dry ground across a watercourse, cut after the river
   * so the crossing is a decision on the map rather than an accident of
   * where the channel wandered. Two fords make a river a front; none make
   * it a wall.
   */
  ford(c: Pt, r: number): this {
    const R = Math.ceil(r) + 1;
    for (let dy = -R; dy <= R; dy++) {
      for (let dx = -R; dx <= R; dx++) {
        const x = Math.floor(c.x) + dx;
        const y = Math.floor(c.y) + dy;
        if (!inBounds(x, y, this.size)) continue;
        const d = Math.hypot(x + 0.5 - c.x, y + 0.5 - c.y);
        if (d > r) continue;
        const i = this.idx(x, y);
        // Barely above the waterline in the middle of the crossing, so the
        // ford reads as a shallow bar rather than as a causeway.
        this.field[i] = Math.max(this.field[i]!, LAKE_LEVEL + 0.04 * ease01(1 - d / r));
      }
    }
    return this;
  }

  /** A pool: everything inside `r` (raggedly) taken below the lake line. */
  pond(c: Pt, r: number): this {
    const R = Math.ceil(r * 1.4) + 1;
    for (let dy = -R; dy <= R; dy++) {
      for (let dx = -R; dx <= R; dx++) {
        const x = Math.floor(c.x) + dx;
        const y = Math.floor(c.y) + dy;
        if (!inBounds(x, y, this.size)) continue;
        const i = this.idx(x, y);
        const rim = r * (0.72 + 0.58 * this.jitter(x, y, 11));
        const d = Math.hypot(x + 0.5 - c.x, y + 0.5 - c.y);
        if (d > rim) continue;
        this.field[i] = Math.min(this.field[i]!, WATER + ease01(d / rim) * (SHALLOW - WATER));
      }
    }
    return this;
  }

  /**
   * The rim and the scenery ring beyond it: each edge draws the style the
   * recipe names — open sea, an impassable range, or a deep choppable
   * forest belt — and the margin continues that style outward as the
   * horizon. Worldgen's band machinery (wobbled depth, meandering
   * headlands, frayed inner teeth), hash-driven rather than rng-driven.
   *
   * Called during the shape phase: a ridge edge raises the field under
   * its rock, which is what keeps a basin from flooding a notch through
   * the border.
   */
  borders(styles: BorderStyles): this {
    this.styles = styles;
    const { play, p0, p1, size } = this;
    const order: RimStyle[] = [styles.n, styles.e, styles.s, styles.w];
    const fringe = Math.max(1, Math.floor(play / 24));
    const perimeter = play * 4;

    /** Value noise around the perimeter, in [0,1], wrapping seamlessly. */
    const meander = (salt: number, p: number, wavelength: number): number => {
      const cells = Math.max(4, Math.round(perimeter / wavelength));
      const f = (((p % perimeter) + perimeter) % perimeter / perimeter) * cells;
      const i0 = Math.floor(f);
      const t = ease01(f - i0);
      const a = hash2(this.grain + salt, i0 % cells);
      const b = hash2(this.grain + salt, (i0 + 1) % cells);
      return a + (b - a) * t;
    };
    // The finest scale: per-position jitter, smoothed once around the loop
    // so the very edge is bitten rather than sawn.
    const wobble = new Float32Array(perimeter);
    for (let i = 0; i < perimeter; i++) wobble[i] = hash2(this.grain + 313, i) * fringe;
    for (let i = 0; i < perimeter; i++) {
      const prev = wobble[(i + perimeter - 1) % perimeter]!;
      const next = wobble[(i + 1) % perimeter]!;
      wobble[i] = (prev + wobble[i]! * 2 + next) / 4;
    }

    // --- Where one style hands over to the next --------------------------
    // Not at the corner. A border that changes from forest to mountain
    // exactly where the map's corner is reads as a frame around a picture,
    // because that is what it is: four sides, mitred. So each of the four
    // handovers slides along the perimeter by up to a sixth of a side, and
    // then interleaves across a dozen tiles rather than cutting — the last
    // trees stand among the first rocks, the way a treeline actually ends.
    const HANDOVER = Math.max(6, Math.round(play / 9));
    const shift = [0, 1, 2, 3].map((c) => (hash2(this.grain + 601, c) - 0.5) * 0.34 * play);
    /** Side that owns perimeter position `p`, before interleaving. */
    const sideAt = (p: number): number => {
      const q = ((p % perimeter) + perimeter) % perimeter;
      for (let c = 3; c >= 0; c--) {
        const start = c * play + shift[c]!;
        if (q >= start) return c;
      }
      // Before the first handover: the last side still owns the wrap.
      return q >= 3 * play + shift[3]! - perimeter ? 3 : 3;
    };
    /** Signed distance to the nearest handover, in perimeter units. */
    const toHandover = (p: number): number => {
      let best = Infinity;
      for (let c = 0; c < 4; c++) {
        for (const turn of [-perimeter, 0, perimeter]) {
          const d = p - (c * play + shift[c]! + turn);
          if (Math.abs(d) < Math.abs(best)) best = d;
        }
      }
      return best;
    };
    const styleAt = (p: number, i: number): RimStyle => {
      const own = sideAt(p);
      const d = toHandover(p);
      if (Math.abs(d) >= HANDOVER) return order[own]!;
      // Inside the handover: the two styles interfinger, the far one
      // thinning out as the near one takes over.
      const other = order[(own + (d < 0 ? 3 : 1)) % 4]!;
      const mine = 0.5 + 0.5 * ease01(Math.abs(d) / HANDOVER);
      return hash2(i, 877) < mine ? order[own]! : other;
    };
    this.perimeterStyle = styleAt;

    /**
     * How far the band reaches in at `p`. Three scales, and the big one is
     * squared: most of a coast sits close to its nominal line and then, two
     * or three times a side, swings deep into a bay or a forest tongue.
     * That variation is most of what stops a border reading as a strip.
     * Sea and forest may reach further than rock — a bay and a wood are
     * places, while a mountain that eats a quarter of the valley is just
     * less valley.
     */
    const depthAt = (p: number, style: RimStyle, i: number): number => {
      const big = meander(2, p, play / 1.7);
      const mid = meander(3, p, play / 5);
      const reach = style === 'ridge' ? 1.5 : style === 'sea' ? 2.1 : 2.4;
      const tooth = hash2(i, 211);
      return (
        fringe * (0.5 + big * big * reach * 1.5 + mid * 0.8) +
        wobble[((p % perimeter) + perimeter) % perimeter]! * 0.5 +
        (tooth < 0.2 ? 2 : tooth < 0.5 ? 1 : 0)
      );
    };

    for (let y = p0; y < p1; y++) {
      for (let x = p0; x < p1; x++) {
        const px = x - p0;
        const py = y - p0;
        const dists = [py, play - 1 - px, play - 1 - py, px]; // N, E, S, W
        let side = 0;
        for (let s = 1; s < 4; s++) if (dists[s]! < dists[side]!) side = s;
        const along = side % 2 === 0 ? px : py;
        const p = side * play + along;
        const i = this.idx(x, y);
        const style = styleAt(p, i);
        const depth = depthAt(p, style, i);
        const d = dists[side]!;
        if (d >= depth) continue;
        switch (style) {
          case 'sea':
            this.terrain[i] = Terrain.Water;
            this.field[i] = WATER;
            // Stacks: a few of the drowned rocks never went under. They
            // stand off the shore and break the line of it.
            if (d > 1 && hash2(i, 733) < 0.014) {
              this.terrain[i] = Terrain.Rock;
              this.field[i] = 0.52 + hash2(i, 734) * 0.22;
            }
            break;
          case 'ridge': {
            this.terrain[i] = Terrain.Rock;
            const crest = 0.62 + meander(9, p, play / 9) * 0.5 + (hash2(i, 251) - 0.5) * 0.24;
            this.rimRamp[i] = Math.min(1, ((depth - d) / depth) * crest);
            break;
          }
          case 'forest':
            // How deep into the wood this tile sits, so the belt can
            // thicken inward instead of standing as one wall.
            this.belt[i] = Math.min(255, Math.max(1, Math.round(depth - d)));
            break;
        }
      }
    }

    // Scree: a few boulders shaken off the range onto the meadow below it,
    // so the mountain has a foot instead of an edge. Sparse and close in —
    // every one of these is an obstacle in the playfield, and a scatter of
    // them far enough out starts fencing off pockets of meadow that
    // `settle` then has to drown.
    for (let y = p0; y < p1; y++) {
      for (let x = p0; x < p1; x++) {
        const i = this.idx(x, y);
        if (this.terrain[i] !== Terrain.Grass || hash2(i, 919) >= 0.05) continue;
        let touching = false;
        for (let dy = -1; dy <= 1 && !touching; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (!inBounds(x + dx, y + dy, size)) continue;
            if (this.terrain[this.idx(x + dx, y + dy)] === Terrain.Rock) {
              touching = true;
              break;
            }
          }
        }
        if (touching) this.terrain[i] = Terrain.Rock;
      }
    }

    // The margin: up to two sides claim a tile, weighted by how far past
    // each edge it sits, so corners morph along a coastline instead of
    // averaging a sea bed against rising land. Which style each claim
    // carries is the same perimeter lookup the band inside used, so the
    // handover runs straight out through the scenery ring.
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (this.inPlay(x, y)) continue;
        const i = this.idx(x, y);
        const mix = this.marginMix(x, y);
        let best = mix[0]!;
        for (const s of mix) if (s.w > best.w) best = s;
        const style = styleAt(this.perimeterOf(best.side, best.u), i);
        if (style === 'sea') this.terrain[i] = Terrain.Water;
        else if (style === 'ridge') this.terrain[i] = Terrain.Rock;
        // A forest margin stays grass here; it takes its timber in `plantBelt`.
      }
    }

    // The border range is real geometry: raise the field under the rock so
    // the mesh draws a slope up to it rather than a wall.
    for (let i = 0; i < tileCount(size); i++) {
      const t = this.rimRamp[i]!;
      if (t > 0) this.field[i] = Math.max(this.field[i]!, 0.55 + 0.45 * ease01(t));
    }

    // A mirrored map's border is mirrored too. The perimeter noise runs
    // around the loop rather than across the grid, so nothing above is
    // symmetric by construction — and now that a bay can reach twenty
    // tiles in, that asymmetry is inside the ground the two banners
    // actually play on, not out in the scenery. Rather than teach every
    // draw about the half turn, take the canonical half of what was just
    // painted and stamp it on the other.
    if (this.mirror) {
      for (let i = 0; i < tileCount(size); i++) {
        const j = this.twinOf(i);
        if (j <= i) continue;
        this.terrain[j] = this.terrain[i]!;
        this.field[j] = this.field[i]!;
        this.rimRamp[j] = this.rimRamp[i]!;
        this.belt[j] = this.belt[i]!;
      }
    }
    return this;
  }

  /** Perimeter position of a point `u` (grid coordinate) along `side`. */
  private perimeterOf(side: number, u: number): number {
    const along = Math.min(this.play - 1, Math.max(0, Math.round(u) - this.p0));
    return side * this.play + along;
  }

  private marginMix(x: number, y: number): { side: number; w: number; u: number; d: number }[] {
    const ox = x < this.p0 ? this.p0 - x : x >= this.p1 ? x - (this.p1 - 1) : 0;
    const oy = y < this.p0 ? this.p0 - y : y >= this.p1 ? y - (this.p1 - 1) : 0;
    const out: { side: number; w: number; u: number; d: number }[] = [];
    const w = ease01((ox / (ox + oy) - 0.3) / 0.4);
    if (ox > 0) out.push({ side: x < this.p0 ? 3 : 1, w: oy > 0 ? w : 1, u: y, d: ox });
    if (oy > 0) out.push({ side: y < this.p0 ? 0 : 2, w: ox > 0 ? 1 - w : 1, u: x, d: oy });
    return out;
  }

  /** One style's far-field ground height `d` tiles past the boundary —
   * the horizon the camera sees behind the border. */
  private marginHeight(side: number, u: number, d: number, style: RimStyle): number {
    const s7 = this.grain + side * 7;
    if (style === 'sea') return -1.5 - valueNoise(s7 + 71, u, d, 6) * 0.5;
    if (style === 'ridge') {
      const r0 = 1 - Math.abs(2 * valueNoise(s7 + 173, u, d * 2.4, 12) - 1);
      const ridged = r0 * r0;
      const massif = valueNoise(s7 + 178, u, d, 34);
      const rough =
        (valueNoise(s7 + 177, u * 1.7, d * 1.7, 2.7) - 0.5) * 0.5 +
        (hash2(u * 31 + side, d * 57) - 0.5) * 0.25;
      return (
        0.45 + ridged * (1.8 + massif * 1.8) + (valueNoise(s7 + 174, u, d, 21) - 0.5) * 0.6 + rough
      );
    }
    const roll =
      0.34 +
      (valueNoise(s7 + 175, u, d, 8) - 0.5) * 0.8 +
      (valueNoise(s7 + 176, u, d, 3.1) - 0.5) * 0.3;
    return Math.max(roll, 0.1);
  }

  // --- 2. Settle --------------------------------------------------------

  /**
   * Turn the field into a world: flood what is below the lake line, drown
   * whatever the water cut off from home, then write the heights with
   * worldgen's own curve — banks that ease down to the waterline, beds
   * that shelve, ranges that climb steeply — and blend the margin's
   * far-field profile onto the boundary rows.
   *
   * `home` is the tile the landmass is judged from (a castle anchor).
   *
   * Returns what it had to drown, split in two. A pocket sealed off down
   * at the border — a lagoon behind a spit where a bay and a headland
   * happened to close on each other — is scenery, and the map is better
   * for it. A pocket out in the valley is a recipe cutting its own ground
   * up, which is a thing to hear about, so the audit reads the second
   * number rather than the total.
   */
  settle(home: Pt): { total: number; inland: number } {
    const { size } = this;
    const tiles = tileCount(size);

    for (let i = 0; i < tiles; i++) {
      if (this.terrain[i] === Terrain.Grass && this.field[i]! < LAKE_LEVEL) {
        this.terrain[i] = Terrain.Water;
      }
    }

    // One landmass: grass the water cut off from home is drowned, exactly
    // as worldgen does it — a pocket no serf can reach is a lie on a map.
    const start = this.idx(Math.round(home.x), Math.round(home.y));
    const reached = new Uint8Array(tiles);
    const queue = [start];
    reached[start] = 1;
    for (let head = 0; head < queue.length; head++) {
      const i = queue[head]!;
      const x = i % size;
      const y = (i / size) | 0;
      for (const [nx, ny] of [
        [x - 1, y],
        [x + 1, y],
        [x, y - 1],
        [x, y + 1],
      ] as const) {
        if (!inBounds(nx, ny, size)) continue;
        const n = this.idx(nx, ny);
        if (reached[n] || this.terrain[n] !== Terrain.Grass) continue;
        reached[n] = 1;
        queue.push(n);
      }
    }
    let drowned = 0;
    let inland = 0;
    for (let i = 0; i < tiles; i++) {
      const x = i % size;
      const y = (i / size) | 0;
      if (!this.inPlay(x, y)) continue;
      if (this.terrain[i] === Terrain.Grass && !reached[i]) {
        this.terrain[i] = Terrain.Water;
        drowned++;
        // Past the deepest a border band can reach: this one is the
        // valley's own ground, not the rim's.
        if (playEdgeDist(this, x, y) > 24) inland++;
      }
    }

    // Distance fields for the two shore effects: banks diving toward the
    // waterline, and beds shelving away from the shallows.
    const bfs = (seed: (t: number) => boolean): Float32Array => {
      const dist = new Float32Array(tiles).fill(99);
      const q: number[] = [];
      for (let i = 0; i < tiles; i++) {
        if (seed(this.terrain[i]!)) {
          dist[i] = 0;
          q.push(i);
        }
      }
      for (let head = 0; head < q.length; head++) {
        const i = q[head]!;
        const x = i % size;
        const y = (i / size) | 0;
        const d = dist[i]! + 1;
        if (d > 6) continue;
        for (const [nx, ny] of [
          [x - 1, y],
          [x + 1, y],
          [x, y - 1],
          [x, y + 1],
        ] as const) {
          if (!inBounds(nx, ny, size)) continue;
          const n = this.idx(nx, ny);
          if (d < dist[n]!) {
            dist[n] = d;
            q.push(n);
          }
        }
      }
      return dist;
    };
    const toWater = bfs((t) => t === Terrain.Water);
    const toLand = bfs((t) => t !== Terrain.Water);

    for (let i = 0; i < tiles; i++) {
      const x = i % size;
      const y = (i / size) | 0;
      if (this.terrain[i] === Terrain.Water) {
        const ease = ease01(Math.min(toLand[i]! / 2.2, 1));
        this.height[i] = -0.34 - ease * 0.95 - this.noise(8, x, y, 5) * 0.22;
      } else {
        const t = Math.max(0, (this.field[i]! - LAKE_LEVEL) / (1 - LAKE_LEVEL));
        const peak = 0.05 + Math.pow(t, 1.7) * 2.5;
        if (this.terrain[i] === Terrain.Rock) {
          this.height[i] = peak; // cliffs rise straight out of the water
        } else {
          const ease = ease01(Math.min(toWater[i]! / 3.5, 1));
          this.height[i] = 0.04 + (peak - 0.04) * ease;
        }
      }
    }

    // The horizon, tied to the boundary row over the first couple of tiles
    // so the border crest and the land behind it are one surface.
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (this.inPlay(x, y)) continue;
        const i = this.idx(x, y);
        if (this.terrain[i] === Terrain.Water) continue;
        let h = 0;
        let d = 0;
        for (const s of this.marginMix(x, y)) {
          const style = this.perimeterStyle(this.perimeterOf(s.side, s.u), i);
          h += this.marginHeight(s.side, s.u, s.d, style) * s.w;
          d = Math.max(d, s.d);
        }
        const edgeH =
          this.height[
            this.idx(clamp(x, this.p0, this.p1 - 1), clamp(y, this.p0, this.p1 - 1))
          ]!;
        this.height[i] = Math.max(edgeH + (h - edgeH) * ease01(d / 2.5), edgeH - d * 0.4);
      }
    }
    this.settled = true;
    return { total: drowned, inland };
  }

  // --- 3. Dress ---------------------------------------------------------

  private plant(x: number, y: number, res: TileResourceKind, amt: number): boolean {
    if (!inBounds(x, y, this.size)) return false;
    const i = this.idx(x, y);
    if (this.terrain[i] !== Terrain.Grass || this.resource[i] !== TileResource.None) return false;
    this.resource[i] = res;
    this.resourceAmt[i] = amt;
    return true;
  }

  /** A stand of timber: `density` of the grass inside `r`, thinning at the
   * edge so a grove ends ragged rather than stamped. */
  grove(c: Pt, r: number, density = 0.75, amt = WOOD_MAX_AMT): number {
    return this.scatter(TileResource.Wood, amt, c, r, density);
  }

  /** An outcrop of workable stone. */
  outcrop(c: Pt, r: number, density = 0.85, amt = 10): number {
    return this.scatter(TileResource.Rock, amt, c, r, density);
  }

  private scatter(
    res: TileResourceKind,
    amt: number,
    c: Pt,
    r: number,
    density: number,
  ): number {
    let placed = 0;
    const R = Math.ceil(r) + 1;
    for (let dy = -R; dy <= R; dy++) {
      for (let dx = -R; dx <= R; dx++) {
        const x = Math.floor(c.x) + dx;
        const y = Math.floor(c.y) + dy;
        if (!this.inPlay(x, y)) continue;
        const d = Math.hypot(x + 0.5 - c.x, y + 0.5 - c.y);
        if (d > r) continue;
        // Full density through the heart, thinning over the outer third:
        // a stand should read as a wood with a ragged edge, not as a
        // scatter of single trees over a wide circle.
        const p = density * (1 - 0.85 * ease01((d - r * 0.62) / (r * 0.38)));
        if (this.jitter(x, y, res * 31 + 5) > p) continue;
        if (this.plant(x, y, res, amt)) placed++;
      }
    }
    return placed;
  }

  /**
   * A treeline: timber along a polyline, `halfWidth` deep, wandering on
   * the map's own grain. What a valley's edge of woods actually is — the
   * shape a player reads as "the forest starts here".
   */
  treeline(course: Pt[], halfWidth: number, density = 0.85, amt = WOOD_MAX_AMT): number {
    let placed = 0;
    for (let y = this.p0; y < this.p1; y++) {
      for (let x = this.p0; x < this.p1; x++) {
        let d = Infinity;
        for (let s = 0; s + 1 < course.length; s++) {
          const dd = distToSegment(x + 0.5, y + 0.5, course[s]!, course[s + 1]!);
          if (dd < d) d = dd;
        }
        const wander = (this.noise(9, x, y, 11) - 0.5) * halfWidth * 0.7;
        const w = d + wander;
        if (w > halfWidth) continue;
        const p = density * (1 - 0.8 * ease01((w - halfWidth * 0.6) / (halfWidth * 0.4)));
        if (this.jitter(x, y, 17) > p) continue;
        if (this.plant(x, y, TileResource.Wood, amt)) placed++;
      }
    }
    return placed;
  }

  /** Timber across an arbitrary region — the belt of woods a recipe wants
   * to fence a valley with. */
  woods(pred: (x: number, y: number) => boolean, density = 0.7, amt = WOOD_MAX_AMT): number {
    let placed = 0;
    for (let y = this.p0; y < this.p1; y++) {
      for (let x = this.p0; x < this.p1; x++) {
        if (!pred(x, y)) continue;
        if (this.jitter(x, y, 41) > density) continue;
        if (this.plant(x, y, TileResource.Wood, amt)) placed++;
      }
    }
    return placed;
  }

  /**
   * A metal seam of fixed total worth, however the ground lets it lie —
   * worldgen's priced seam, so an authored deposit is worth exactly what
   * a generated one is. Takes the nearest open tiles to the center and
   * splits `budget` evenly over them.
   */
  seam(res: TileResourceKind, budget: number, c: Pt): number {
    if (!Number.isInteger(budget) || budget < 1 || budget > 255) {
      throw new Error(`seam budget must be a whole number of 1..255 (got ${budget})`);
    }
    // The working yard: standing timber inside the seam's own reach comes
    // down first. A seam is walkable rocky ground by design — a miner
    // stands beside it and a mine wants a footprint next to it — and a
    // seam that lands under a wood is ore nobody can get at, which the
    // map has no way of admitting once the file is written.
    const YARD = SEAM_REACH + 1;
    for (let dy = -YARD; dy <= YARD; dy++) {
      for (let dx = -YARD; dx <= YARD; dx++) {
        const x = Math.floor(c.x) + dx;
        const y = Math.floor(c.y) + dy;
        if (!inBounds(x, y, this.size)) continue;
        const i = this.idx(x, y);
        if (this.resource[i] !== TileResource.Wood) continue;
        this.resource[i] = TileResource.None;
        this.resourceAmt[i] = 0;
      }
    }
    const open: { i: number; d2: number }[] = [];
    for (let dy = -SEAM_REACH; dy <= SEAM_REACH; dy++) {
      for (let dx = -SEAM_REACH; dx <= SEAM_REACH; dx++) {
        const d2 = dx * dx + dy * dy;
        if (d2 > SEAM_REACH * SEAM_REACH) continue;
        const x = Math.floor(c.x) + dx;
        const y = Math.floor(c.y) + dy;
        if (!this.inPlay(x, y)) continue;
        const i = this.idx(x, y);
        if (this.terrain[i] !== Terrain.Grass || this.resource[i] !== TileResource.None) continue;
        open.push({ i, d2 });
      }
    }
    // Nearest first; ties by the twin-invariant key rather than the raw
    // index, because `i - j` sorts one way on one half of a mirrored map
    // and the other way on the other — which is how two seams priced
    // identically end up lying a tile and a half apart.
    open.sort((a, b) => a.d2 - b.d2 || this.canon(a.i) - this.canon(b.i));
    const take = open.slice(0, Math.min(SEAM_TILES, budget));
    if (take.length === 0) return 0;
    const per = Math.floor(budget / take.length);
    let over = budget - per * take.length;
    for (const { i } of take) {
      this.resource[i] = res;
      this.resourceAmt[i] = per + (over-- > 0 ? 1 : 0);
    }
    return take.length;
  }

  /** The three metals, by name — a recipe should not have to spell tile
   * codes to say "iron in the eastern hill". */
  ironSeam(budget: number, c: Pt): number {
    return this.seam(TileResource.IronDep, budget, c);
  }

  silverSeam(budget: number, c: Pt): number {
    return this.seam(TileResource.SilverDep, budget, c);
  }

  goldSeam(budget: number, c: Pt): number {
    return this.seam(TileResource.GoldDep, budget, c);
  }

  /**
   * The border woods: the playable belt a forest edge drew, and every
   * grass tile of the scenery ring behind it. The belt is choppable
   * reserve (tunnelling out is a strategy); the margin is scenery the
   * play-area rule keeps every axe away from.
   */
  plantBelt(): this {
    for (let i = 0; i < tileCount(this.size); i++) {
      const x = i % this.size;
      const y = (i / this.size) | 0;
      if (this.terrain[i] !== Terrain.Grass || this.resource[i] !== TileResource.None) continue;
      // Glades: a low-frequency thinning that runs through the whole belt
      // and out into the horizon behind it, so the wood has depth to it
      // rather than being a hedge with a ragged inside face.
      const glade = 0.45 + 0.55 * ease01((this.noise(12, x, y, 11) - 0.22) / 0.5);
      if (this.inPlay(x, y)) {
        const deep = this.belt[i]!;
        if (!deep) continue;
        // The treeline thickens over the first few tiles rather than
        // starting at full stand: an edge of wood is a gradient.
        const p = (0.2 + 0.8 * ease01((deep - 1) / 3.5)) * glade;
        if (this.jitter(x, y, 3) > p) continue;
      } else if (this.jitter(x, y, 3) > Math.max(glade, 0.7)) {
        // Scenery: nearly solid, but not perfectly — a horizon of
        // unbroken canopy reads as a texture rather than as trees.
        continue;
      }
      this.resource[i] = TileResource.Wood;
      this.resourceAmt[i] = WOOD_MAX_AMT;
    }
    return this;
  }

  /**
   * The town's own meadow, swept of timber inside `r` of a keep.
   *
   * Not tidiness — placement. A hut is legal wherever ONE tile of its
   * resource falls inside its reach, so a single tree left in the meadow
   * makes a dead spot look like a woodcutter site, and the first thing a
   * player (or a mission's scripted playthrough, which builds on the first
   * legal tile it spirals onto) does is raise a hut that fells that tree
   * and then stands idle for the rest of the mission. The woods have an
   * edge, and this is where the map says so.
   *
   * Timber only. Stone is the opposite case — worldgen promises every
   * start an outcrop inside the castle's opening view, so the knap by the
   * town is deliberate and stays; what a quarry must not be given is a
   * one-tile outcrop, which is a thing to check rather than to sweep.
   *
   * Two passes, because a hard edge alone does not do it: inside `r`
   * nothing stands, and for a hut's reach beyond it (`r`..`r + 8`, the
   * ground a hut sited at the meadow's edge can still see) any tile whose
   * own neighbourhood is nearly empty goes too. That second pass is what
   * takes the thin tail of a treeline, or the last straggler of a grove
   * the sweep cut through — the tiles that are not a wood, but are enough
   * to make a spot in the open legal.
   */
  clearing(c: Pt, r: number): this {
    const outer = r + 8;
    const R = Math.ceil(outer) + 1;
    const doomed: number[] = [];
    for (let dy = -R; dy <= R; dy++) {
      for (let dx = -R; dx <= R; dx++) {
        const x = Math.floor(c.x) + dx;
        const y = Math.floor(c.y) + dy;
        if (!inBounds(x, y, this.size)) continue;
        const d = Math.hypot(x + 0.5 - c.x, y + 0.5 - c.y);
        if (d > outer) continue;
        const i = this.idx(x, y);
        if (this.resource[i] !== TileResource.Wood) continue;
        if (d > r) {
          // A wood, or a straggler? Count the stand it stands in.
          let neighbours = 0;
          for (let ny = y - 2; ny <= y + 2; ny++) {
            for (let nx = x - 2; nx <= x + 2; nx++) {
              if (!inBounds(nx, ny, this.size)) continue;
              if (this.resource[this.idx(nx, ny)] === TileResource.Wood) neighbours++;
            }
          }
          if (neighbours >= 9) continue; // a third of the block: a real stand
        }
        doomed.push(i);
      }
    }
    // Gathered first, felled after: judging a tile by neighbours already
    // felled would eat inward from the edge of a perfectly good wood.
    for (const i of doomed) {
      this.resource[i] = TileResource.None;
      this.resourceAmt[i] = 0;
    }
    return this;
  }

  /**
   * No dead woodcutter sites near a keep.
   *
   * `clearing` gives the woods an edge; this holds the edge to what it
   * claims. A hut is legal wherever one tile of timber falls inside its
   * reach, so the corner of a perfectly good wood, clipped by the reach
   * of a spot out in the meadow, is still a hut that fells one tree and
   * starves — and the spiral a player's eye (and a mission's scripted
   * playthrough) runs will find that spot before it finds the good one,
   * because it is nearer. So: walk every site the spiral could pick
   * inside `rings`, and wherever one is legal but has less than `want`
   * timber to work, take away the few tiles that made it legal. Repeat
   * until the ground stops offering them.
   *
   * Timber only, and near the keep only. Out in the valley a thin stand
   * is a thin stand, and a player who sites a hut at one has made a
   * choice rather than been handed a trap.
   */
  noDeadWoodSites(starts: readonly StartSpot[], rings = 6, want = 40): number {
    const def = buildingDef('woodcutter');
    const radius = gatherRecipeOf(def)!.radius;
    let felled = 0;
    for (let pass = 0; pass < 12; pass++) {
      const map = this.toMap();
      for (const s of starts) {
        for (let dy = 0; dy < 3; dy++) {
          for (let dx = 0; dx < 3; dx++) {
            const i = this.idx(s.x + dx, s.y + dy);
            map.buildingAt[i] = 1;
            map.blocked[i] = 1;
          }
        }
      }
      const doomed = new Set<number>();
      for (const s of starts) {
        const cx = Math.floor(s.x + 1.5);
        const cy = Math.floor(s.y + 1.5);
        for (let r = 0; r <= rings; r++) {
          for (let dy = -r; dy <= r; dy++) {
            for (let dx = -r; dx <= r; dx++) {
              if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
              const x = cx + dx;
              const y = cy + dy;
              if (!canPlace(map, 'woodcutter', x, y)) continue;
              const o = gatherOrigin(def, x, y);
              if (countResourceNear(this, o.x, o.y, TileResource.Wood, radius) >= want) continue;
              for (let ty = o.y - radius; ty <= o.y + radius; ty++) {
                for (let tx = o.x - radius; tx <= o.x + radius; tx++) {
                  if (!this.inPlay(tx, ty)) continue;
                  const i = this.idx(tx, ty);
                  if (this.resource[i] !== TileResource.Wood) continue;
                  doomed.add(i);
                  // The spiral is not symmetric (it scans from the
                  // north-west whichever keep it starts at), so on a
                  // mirrored map a tile felled for one banner has to be
                  // felled for the other or the halves drift apart.
                  if (this.mirror) doomed.add(this.twinOf(i));
                }
              }
            }
          }
        }
      }
      if (doomed.size === 0) return felled;
      for (const i of doomed) {
        this.resource[i] = TileResource.None;
        this.resourceAmt[i] = 0;
        felled++;
      }
    }
    return felled;
  }

  /** Strip everything standing off a rect — a building site, a road, the
   * ground under a camp. */
  clear(x0: number, y0: number, w: number, h: number): this {
    for (let y = y0; y < y0 + h; y++) {
      for (let x = x0; x < x0 + w; x++) {
        if (!inBounds(x, y, this.size)) continue;
        const i = this.idx(x, y);
        this.resource[i] = TileResource.None;
        this.resourceAmt[i] = 0;
      }
    }
    return this;
  }

  // --- Finish -----------------------------------------------------------

  toMap(): GameMap {
    const map: GameMap = {
      size: this.size,
      play: this.play,
      terrain: this.terrain,
      resource: this.resource,
      resourceAmt: this.resourceAmt,
      blocked: new Uint8Array(tileCount(this.size)),
      buildingAt: new Int16Array(tileCount(this.size)).fill(-1),
      wear: new Float32Array(tileCount(this.size)),
      pathLevel: new Uint8Array(tileCount(this.size)),
      height: this.height,
    };
    recomputeBlocked(map);
    return map;
  }

  serialize(name: string, starts: StartSpot[]): string {
    if (!this.settled) throw new Error(`${name}: settle() was never called`);
    return serializeMapFile({ map: this.toMap(), players: starts.length, starts, name });
  }
}

/** What a recipe hands back: the valley, its name, its seats, and the
 * landmarks the audit should hold it to. */
export interface Authored {
  valley: Valley;
  name: string;
  starts: StartSpot[];
  /** Bandit camp footprint origin the mission def pins, if any. */
  campSpot?: Pt;
  /** The prebuilt huts the mission def stands at castle + offset, so the
   * audit can prove the placement rules accept the ground under them —
   * a quarry wants stone in reach and flat-enough ground, and a mission
   * whose village half-lands is a mission that opens broken. */
  prebuilt?: { type: BuildingTypeId; dx: number; dy: number }[];
  /** Free-form notes about what the ground is meant to teach — printed
   * with the audit so a rebuild reads its own intent back. */
  intent: string[];
  /** What `settle` had to drown, filled in by the recipe: the total, and
   * how much of it was out in the valley rather than down at the rim. */
  drowned: { total: number; inland: number };
  /** Set by a duel map authored as one half and mirrored: the audit then
   * holds the finished tiles to that claim, inside the rim (the border
   * band is scenery and draws its own wobble). */
  symmetric?: boolean;
}

/** Walkable in the sim's terms: playable, dry, and nothing standing on it. */
function walkable(v: Valley, i: number): boolean {
  return (
    v.inPlay(i % v.size, (i / v.size) | 0) && !tileBlocks(v.terrain[i]!, v.resource[i]!)
  );
}

/** Everything reachable on foot from a tile. */
function reachable(v: Valley, from: Pt): Uint8Array {
  const size = v.size;
  const seen = new Uint8Array(tileCount(size));
  const start = v.idx(Math.round(from.x), Math.round(from.y));
  if (!walkable(v, start)) return seen;
  seen[start] = 1;
  const q = [start];
  for (let head = 0; head < q.length; head++) {
    const i = q[head]!;
    const x = i % size;
    const y = (i / size) | 0;
    for (const [nx, ny] of [
      [x - 1, y],
      [x + 1, y],
      [x, y - 1],
      [x, y + 1],
    ] as const) {
      if (!inBounds(nx, ny, size)) continue;
      const n = v.idx(nx, ny);
      if (seen[n] || !walkable(v, n)) continue;
      seen[n] = 1;
      q.push(n);
    }
  }
  return seen;
}

const RESOURCE_NAMES: Record<number, string> = {
  [TileResource.Wood]: 'wood',
  [TileResource.Rock]: 'rock',
  [TileResource.IronDep]: 'iron',
  [TileResource.SilverDep]: 'silver',
  [TileResource.GoldDep]: 'gold',
};

/** The castle's sight centre, as worldgen measures it. */
function keep(s: StartSpot): Pt {
  return { x: s.x + 1.5, y: s.y + 1.5 };
}

/**
 * The nearest spot the sim's own placement rules accept, searched in the
 * same ring-spiral the prebuilt placer and a player's eye both use.
 * Returns the ring it was found on — "how far this building slides from
 * where the recipe wanted it".
 */
function nearestSite(
  map: GameMap,
  type: BuildingTypeId,
  c: Pt,
  maxRing: number,
): { x: number; y: number; r: number } | undefined {
  const cx = Math.floor(c.x);
  const cy = Math.floor(c.y);
  for (let r = 0; r <= maxRing; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        if (canPlace(map, type, cx + dx, cy + dy)) return { x: cx + dx, y: cy + dy, r };
      }
    }
  }
  return undefined;
}

/**
 * The standing questions every mission map has to answer, asked of the
 * finished tiles rather than of the recipe's intentions: is the town site
 * buildable, is there stone in the opening view, can a serf walk to the
 * ore, does the camp have ground to stand on, is any of it stranded.
 *
 * A `problem` is a mission that would boot broken or unwinnable; a plain
 * line is a number to read.
 */
export function audit(a: Authored): AuditReport {
  const v = a.valley;
  const lines: string[] = [];
  const problems: string[] = [];
  const size = v.size;
  const tiles = tileCount(size);
  // The finished world, so every question below is asked of the same
  // tiles the sim will boot — `canPlace` included. The keeps are stamped
  // in first, because they are: a site search that may answer "on top of
  // the castle" is not the search a player runs.
  const map = v.toMap();
  for (const s of a.starts) {
    for (let dy = 0; dy < 3; dy++) {
      for (let dx = 0; dx < 3; dx++) {
        const i = v.idx(s.x + dx, s.y + dy);
        map.buildingAt[i] = 1;
        map.blocked[i] = 1;
      }
    }
  }

  const totals = new Map<number, { amt: number; tiles: number }>();
  let wet = 0;
  for (let y = v.p0; y < v.p1; y++) {
    for (let x = v.p0; x < v.p1; x++) {
      const i = v.idx(x, y);
      if (v.terrain[i] === Terrain.Water) wet++;
      const r = v.resource[i]!;
      if (!r) continue;
      const t = totals.get(r) ?? { amt: 0, tiles: 0 };
      t.amt += v.resourceAmt[i]!;
      t.tiles++;
      totals.set(r, t);
    }
  }
  lines.push(`water ${((100 * wet) / (v.play * v.play)).toFixed(1)}% of the playfield`);
  for (const [code, name] of Object.entries(RESOURCE_NAMES)) {
    const t = totals.get(Number(code));
    lines.push(`  ${name.padEnd(6)} ${String(t?.amt ?? 0).padStart(5)} in ${t?.tiles ?? 0} tiles`);
  }
  if (a.drowned.total > 0) {
    lines.push(
      `  settle drowned ${a.drowned.total} stranded tiles ` +
        `(${a.drowned.inland} of them inland)`,
    );
  }
  if (a.drowned.inland > 12) {
    problems.push(
      `settle drowned ${a.drowned.inland} tiles out in the valley — a landform is cutting it up`,
    );
  }

  for (const [si, s] of a.starts.entries()) {
    const c = { x: s.x + 1.5, y: s.y + 1.5 };
    const who = a.starts.length > 1 ? `seat ${si}` : 'castle';
    // The town site: a 3x3 keep needs its ground, and the plateau around
    // it is where the first half-dozen roofs go.
    let blockedNear = 0;
    for (let dy = -6; dy <= 6; dy++) {
      for (let dx = -6; dx <= 6; dx++) {
        const x = Math.floor(c.x) + dx;
        const y = Math.floor(c.y) + dy;
        if (!v.inPlay(x, y)) {
          blockedNear++;
          continue;
        }
        if (v.terrain[v.idx(x, y)] !== Terrain.Grass) blockedNear++;
      }
    }
    if (blockedNear > 20) {
      problems.push(`${who}: ${blockedNear} of 169 tiles around the keep are unbuildable`);
    }
    const reach = reachable(v, { x: s.x + 2, y: s.y + 2 });
    const nearest = (code: number): number => {
      let best = Infinity;
      for (let i = 0; i < tiles; i++) {
        if (v.resource[i] !== code) continue;
        const x = i % size;
        const y = (i / size) | 0;
        if (!v.inPlay(x, y)) continue;
        const d = Math.hypot(x + 0.5 - c.x, y + 0.5 - c.y);
        if (d < best) best = d;
      }
      return best;
    };
    const dists = Object.entries(RESOURCE_NAMES)
      .map(([code, name]) => `${name} ${nearest(Number(code)).toFixed(1)}`)
      .join('  ');
    lines.push(`${who} at ${s.x},${s.y}: nearest ${dists}`);
    // Stone in the opening view is worldgen's own promise: a player who
    // sees timber and no stone reads the map as stoneless.
    let stoneInSight = 0;
    for (let dy = -10; dy <= 10; dy++) {
      for (let dx = -10; dx <= 10; dx++) {
        const x = Math.floor(c.x) + dx;
        const y = Math.floor(c.y) + dy;
        if (!v.inPlay(x, y)) continue;
        if (Math.hypot(x + 0.5 - c.x, y + 0.5 - c.y) > 9.5) continue;
        if (v.resource[v.idx(x, y)] === TileResource.Rock) stoneInSight++;
      }
    }
    if (stoneInSight === 0) problems.push(`${who}: no stone inside the castle's opening sight`);
    else lines.push(`  ${stoneInSight} stone tiles in the opening view`);
    // Fishable water within a short walk — the fishery's whole premise.
    let shore = Infinity;
    for (let i = 0; i < tiles; i++) {
      if (v.terrain[i] !== Terrain.Water) continue;
      const x = i % size;
      const y = (i / size) | 0;
      for (const [nx, ny] of [
        [x - 1, y],
        [x + 1, y],
        [x, y - 1],
        [x, y + 1],
      ] as const) {
        if (!v.inPlay(nx, ny) || !reach[v.idx(nx, ny)]) continue;
        shore = Math.min(shore, Math.hypot(x + 0.5 - c.x, y + 0.5 - c.y));
      }
    }
    if (shore > WATER_ACCESS_RADIUS) {
      problems.push(`${who}: no reachable shore within ${WATER_ACCESS_RADIUS} tiles (${shore.toFixed(1)})`);
    } else lines.push(`  shore at ${shore.toFixed(1)}`);

    // Every deposit has to be walkable-to: a seam behind a lake is a seam
    // the mission cannot ask for.
    for (const code of [TileResource.IronDep, TileResource.SilverDep, TileResource.GoldDep]) {
      let live = 0;
      let reachableTiles = 0;
      for (let i = 0; i < tiles; i++) {
        if (v.resource[i] !== code) continue;
        live++;
        // A miner stands beside the seam, not on it.
        const x = i % size;
        const y = (i / size) | 0;
        for (const [nx, ny] of [
          [x - 1, y],
          [x + 1, y],
          [x, y - 1],
          [x, y + 1],
        ] as const) {
          if (reach[v.idx(nx, ny)]) {
            reachableTiles++;
            break;
          }
        }
      }
      if (live > 0 && reachableTiles === 0) {
        problems.push(`${who}: ${RESOURCE_NAMES[code]} is walled off`);
      }
    }
    if (si > 0) {
      const home = reachable(v, { x: a.starts[0]!.x + 2, y: a.starts[0]!.y + 2 });
      if (!home[v.idx(s.x + 2, s.y + 2)]) {
        problems.push(`${who}: no walkable route from seat 0 — a war of elimination never ends`);
      }
    }
  }

  if (a.symmetric) {
    // The deepest band any border can draw is base + capped wobble +
    // teeth; inside that, a mirrored map owes exact symmetry.
    const fringe = Math.max(1, Math.floor(v.play / 24));
    const inset = 3 * fringe + 2;
    let off = 0;
    for (let y = v.p0 + inset; y < v.p1 - inset; y++) {
      for (let x = v.p0 + inset; x < v.p1 - inset; x++) {
        const i = v.idx(x, y);
        const j = v.idx(size - 1 - x, size - 1 - y);
        if (
          v.terrain[i] !== v.terrain[j] ||
          v.resource[i] !== v.resource[j] ||
          v.resourceAmt[i] !== v.resourceAmt[j]
        ) {
          off++;
        }
      }
    }
    if (off > 0) problems.push(`${off} tiles differ from their half-turn twin`);
    else lines.push('exactly symmetric under the half turn');
  }

  if (a.campSpot) {
    const { x, y } = a.campSpot;
    let clear = true;
    for (let dy = 0; dy < 3; dy++) {
      for (let dx = 0; dx < 3; dx++) {
        if (!v.inPlay(x + dx, y + dy)) clear = false;
        else if (v.terrain[v.idx(x + dx, y + dy)] !== Terrain.Grass) clear = false;
        else if (v.resource[v.idx(x + dx, y + dy)] !== TileResource.None) clear = false;
      }
    }
    if (!clear) problems.push(`campSpot ${x},${y} is not a clear 3x3`);
    const reach = reachable(v, { x: a.starts[0]!.x + 2, y: a.starts[0]!.y + 2 });
    let adjacent = false;
    for (let dy = -1; dy <= 3; dy++) {
      for (let dx = -1; dx <= 3; dx++) {
        if (reach[v.idx(x + dx, y + dy)]) adjacent = true;
      }
    }
    if (!adjacent) problems.push(`campSpot ${x},${y} cannot be marched to`);
    else lines.push(`camp at ${x},${y}, clear and reachable`);
  }

  for (const b of a.prebuilt ?? []) {
    // placePrebuiltNear spirals outward from the offset, so the question
    // is whether the ordinary placement rules accept ANY footprint nearby
    // — not whether the exact tile is free. Asked with the sim's own
    // `canPlace`, which is the only honest way to ask it: slope, doorway,
    // and the gatherer's reach are all in there.
    const ox = a.starts[0]!.x + b.dx;
    const oy = a.starts[0]!.y + b.dy;
    const at = nearestSite(map, b.type, { x: ox, y: oy }, 6);
    if (!at) problems.push(`prebuilt ${b.type} at ${b.dx},${b.dy}: no legal site within 5 tiles`);
    else if (at.r > 3) lines.push(`  prebuilt ${b.type} slides ${at.r} tiles to find ground`);
  }

  // What a player can actually raise, how far they walk to do it, and —
  // the number that decides whether a taught line works at all — how much
  // work the hut finds once it is standing there.
  //
  // The nearest LEGAL site is not the nearest good one. One stray tree
  // nine tiles out makes a woodcutter placeable in the middle of the
  // meadow, the hut fells that tree, and the mission stalls with a
  // working woodcutter and no wood — which is exactly how mission 1's
  // scripted playthrough (it spirals out from the keep and builds on the
  // first legal tile) fails on a map that reads fine.
  for (const s0 of a.starts) {
    const c = keep(s0);
    const sites = (['woodcutter', 'quarry', 'ironMine', 'silverMine', 'goldMine', 'fishery'] as const)
      .map((type) => {
        const at = nearestSite(map, type, c, 40);
        if (!at) return `${type} --`;
        const gather = gatherRecipeOf(buildingDef(type));
        if (!gather) return `${type} ${at.r}`;
        const o = gatherOrigin(buildingDef(type), at.x, at.y);
        const held = countResourceNear(v, o.x, o.y, RESOURCE_CODE[gather.resource]!, gather.radius);
        return `${type} ${at.r} (${held})`;
      })
      .join('  ');
    lines.push(`  nearest legal site (and what it can work): ${sites}`);
    // A hut on the first legal tile has to find a real day's work there.
    for (const [type, want] of [
      ['woodcutter', 40],
      ['quarry', 40],
    ] as const) {
      const at = nearestSite(map, type, c, 40);
      if (!at) continue;
      const gather = gatherRecipeOf(buildingDef(type))!;
      const o = gatherOrigin(buildingDef(type), at.x, at.y);
      const held = countResourceNear(v, o.x, o.y, RESOURCE_CODE[gather.resource]!, gather.radius);
      if (held < want) {
        problems.push(
          `the first legal ${type} site out of the keep can only work ${held} — a stray ` +
            'grove tile is making a dead spot look legal',
        );
      }
    }
  }

  return { name: a.name, lines, problems };
}
