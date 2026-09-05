/**
 * What a seat can see. This is the gameplay half of fog of war, lifted out
 * of the renderer so the server can decide what to *send* rather than the
 * client deciding what to *draw*.
 *
 * src/render/fogOfWar.ts keeps the presentation half — the soft rim, the
 * reveal/conceal easing, the blur and the shader. None of that belongs
 * here: a server has no opinion about how a frontier should look, only
 * about whether a tile is observed.
 *
 * The radii match the renderer's exactly. The one deliberate difference is
 * the edge: the renderer fades a sight circle out over RIM tiles and treats
 * a tile as seen above a threshold, which makes its effective gameplay
 * radius about a tile shorter than the nominal one. The server uses the
 * full radius, so it always sends slightly more than the client will draw.
 * That margin is the right direction to err — the alternative is an enemy
 * standing in lit ground who was never sent, which reads as a hole in the
 * world rather than as fog.
 */
import {tileCount, tileIdx} from '../shared/grid.ts';
import * as BuildingState from './buildingStateEnum.ts';
import {buildingDef} from './defs/buildings.ts';
import * as BuildingTypeId from './defs/buildingTypeIdEnum.ts';
import {UNIT_DEFS} from './defs/units.ts';
import type {Owner} from './entities.ts';
import type {World} from './world.ts';

/** A building watches from its edges, not its middle, so its footprint
 * widens what it covers. Units are points and need no such adjustment. */
export function buildingSight(
  type: Parameters<typeof buildingDef>[0],
  w: number,
  h: number,
): number {
  return buildingDef(type).sight + Math.max(w, h) / 2;
}

/**
 * One seat's view of the map. Two grids: what is lit right now, and what
 * has ever been lit. Units are hidden by the first (a raider you saw a
 * minute ago is long gone); buildings are remembered through the second
 * (a camp does not walk away).
 */
export class SeatVision {
  /** Grid side length of the map this vision watches. */
  readonly size: number;
  /** 1 = observed this recompute. */
  readonly visible: Uint8Array;
  /** 1 = observed at some point. Never goes back to 0. */
  readonly explored: Uint8Array;
  /** Tiles that were dark last recompute and are lit now. The server owes
   * the client the current contents of these — a delta only fires when a
   * tile *changes*, so ground that was built on while unobserved would
   * otherwise stay wrong in the client's memory forever. */
  readonly revealed: number[] = [];
  #prev: Uint8Array;

  constructor(size: number) {
    this.size = size;
    const tiles = tileCount(size);
    this.visible = new Uint8Array(tiles);
    this.explored = new Uint8Array(tiles);
    this.#prev = new Uint8Array(tiles);
  }

  recompute(world: World, owner: Owner): void {
    this.visible.fill(0);
    for (const u of world.units.values()) {
      if (u.dead || u.owner !== owner) continue;
      this.#stamp(u.x, u.y, UNIT_DEFS[u.kind].sight);
    }
    for (const b of world.buildings.values()) {
      if (b.dead || b.owner !== owner) continue;
      this.#stamp(
        b.x + b.w / 2,
        b.y + b.h / 2,
        buildingSight(b.type, b.w, b.h),
      );
    }
    this.revealed.length = 0;
    const tiles = tileCount(this.size);
    for (let i = 0; i < tiles; i++) {
      const lit = this.visible[i]!;
      if (lit && !this.#prev[i]) this.revealed.push(i);
      if (lit) this.explored[i] = 1;
      this.#prev[i] = lit;
    }
    this.#revealMonuments(world, owner);
  }

  /**
   * A rival's finished monument is on everybody's map.
   *
   * `explored` and not `visible`, which is the whole of the design: a
   * monument does not walk away, so it belongs in the grid that remembers
   * buildings rather than the one that shows what is lit right now — the
   * same distinction the class comment above draws for a bandit camp. The
   * effect is that an enemy learns WHERE it stands and has to scout to
   * learn what is guarding it: sync.ts sends a full building snapshot only
   * on `canSee`, and a remembered stub otherwise. Knowing where to march
   * is the point; being handed the garrison count is not.
   *
   * A hold nobody can find is a stopwatch, not a claim, so this is what
   * makes the countdown contestable at all.
   *
   * The tiles are pushed onto `revealed` the first time they light, because
   * that list is what actually ships tile CONTENTS to a client (sync.ts) —
   * marking the ground explored without it would leave a rival looking at
   * remembered grass where the stone is.
   */
  #revealMonuments(world: World, owner: Owner): void {
    for (const b of world.buildings.values()) {
      if (
        b.dead ||
        b.owner === owner ||
        b.type !== BuildingTypeId.monument ||
        b.state !== BuildingState.built
      ) {
        continue;
      }
      for (let ty = b.y; ty < b.y + b.h; ty++) {
        for (let tx = b.x; tx < b.x + b.w; tx++) {
          if (tx < 0 || ty < 0 || tx >= this.size || ty >= this.size) continue;
          const i = tileIdx(tx, ty, this.size);
          if (this.explored[i]) continue;
          this.explored[i] = 1;
          this.revealed.push(i);
        }
      }
    }
  }

  canSee(x: number, y: number): boolean {
    const tx = Math.floor(x);
    const ty = Math.floor(y);
    if (tx < 0 || ty < 0 || tx >= this.size || ty >= this.size) return false;
    return this.visible[tileIdx(tx, ty, this.size)] === 1;
  }

  hasExplored(x: number, y: number): boolean {
    const tx = Math.floor(x);
    const ty = Math.floor(y);
    if (tx < 0 || ty < 0 || tx >= this.size || ty >= this.size) return false;
    return this.explored[tileIdx(tx, ty, this.size)] === 1;
  }

  /** Light every tile whose center is within `radius` of (cx, cy). */
  #stamp(cx: number, cy: number, radius: number): void {
    const size = this.size;
    const r = Math.ceil(radius);
    const x0 = Math.max(0, Math.floor(cx) - r);
    const x1 = Math.min(size - 1, Math.floor(cx) + r);
    const y0 = Math.max(0, Math.floor(cy) - r);
    const y1 = Math.min(size - 1, Math.floor(cy) + r);
    const rr = radius * radius; // squared: no sqrt in the inner loop
    for (let y = y0; y <= y1; y++) {
      const dy = y + 0.5 - cy;
      const row = y * size;
      for (let x = x0; x <= x1; x++) {
        const dx = x + 0.5 - cx;
        if (dx * dx + dy * dy <= rr) this.visible[row + x] = 1;
      }
    }
  }
}
