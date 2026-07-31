import { TICKS_PER_SECOND } from '../sim/defs/balance';
import { UNIT_DEFS } from '../sim/defs/units';
import { findPath, tileSpeedMult, type PathMap } from '../sim/path';
import { tileIdx, tileX, tileY } from '../shared/grid';
import type { UnitSnapshot } from '../protocol/sabLayout';

/**
 * Client-side prediction for your own units' movement.
 *
 * The problem it solves is narrow: between clicking and the server's answer
 * arriving, your units stand still. That dead window is the whole of what a
 * player feels as lag — once the server *is* moving them, its frames are
 * smooth and being a fraction of a second behind the true world is not
 * something anyone can perceive.
 *
 * So this predicts only across that window, and hands back the moment the
 * server takes over. It deliberately does not run a parallel simulation:
 * that would need the rest of the world, which this client is no longer
 * given, and every extra tick of independent guessing is another chance to
 * be wrong and snap.
 *
 * Handover is smoothed rather than cut. At the moment the server starts
 * moving a unit, our predicted position is ahead of its by roughly half the
 * round trip; dropping straight to truth would twitch the unit backwards.
 * The difference is kept as an offset and decayed away over a few frames.
 *
 * Speed here omits the serfSpeed tech modifier, which would need player
 * state this worker does not carry. The error is small and, importantly,
 * in the safe direction: prediction runs slightly slow, so it under-moves
 * rather than overshooting into a correction.
 */

/** Server movement beyond this means it has taken the order. Units cross
 * ~0.09 tiles per tick, so one tick of real movement clears it easily. */
const TAKEOVER_EPS = 0.01;
/** Give up predicting after this long with no server movement — the order
 * was refused, or the unit cannot go where it was sent. */
const MAX_LEAD_TICKS = 10;
/** Per-frame decay of the handover offset. */
const SETTLE = 0.75;
/** Below this the offset is not worth carrying. */
const SETTLED_EPS = 0.004;

interface Prediction {
  path: number[] | null;
  pathIdx: number;
  x: number;
  y: number;
  /** Tiles per tick, before terrain multipliers. */
  baseSpeed: number;
  /** Where the server had this unit when the order went out. */
  anchorX: number;
  anchorY: number;
  ticks: number;
  /** Set once the server starts moving the unit; then we only settle. */
  handedOver: boolean;
  offX: number;
  offY: number;
}

const SPEED_BY_KIND_CODE = new Map<number, number>(
  Object.values(UNIT_DEFS).map((d) => [d.kindCode, d.speed]),
);

export class MovePredictor {
  #map: PathMap;
  #preds = new Map<number, Prediction>();

  constructor(map: PathMap) {
    this.#map = map;
  }

  get size(): number {
    return this.#preds.size;
  }

  /** Forget everything — used when the server resends the whole world. */
  reset(): void {
    this.#preds.clear();
  }

  /**
   * A local move order just went out. `known` is the latest server frame,
   * which is where these units are starting from as far as anyone knows.
   */
  order(unitIds: readonly number[], tx: number, ty: number, known: Map<number, UnitSnapshot>): void {
    for (const id of unitIds) {
      const u = known.get(id);
      if (!u) continue;
      const baseSpeed = SPEED_BY_KIND_CODE.get(u.kind);
      if (baseSpeed === undefined) continue;
      const path = findPath(this.#map, Math.floor(u.x), Math.floor(u.y), tx, ty);
      if (!path || path.length === 0) continue;
      this.#preds.set(id, {
        path,
        pathIdx: 0,
        x: u.x,
        y: u.y,
        baseSpeed: baseSpeed / TICKS_PER_SECOND,
        anchorX: u.x,
        anchorY: u.y,
        ticks: 0,
        handedOver: false,
        offX: 0,
        offY: 0,
      });
    }
  }

  /**
   * Rewrite this frame's own-unit positions with predicted ones. Mutates
   * the snapshots in place — everything else in the frame is server truth
   * and is left exactly as it arrived.
   */
  apply(units: UnitSnapshot[], owner: number): void {
    if (this.#preds.size === 0) return;
    for (const u of units) {
      if (u.owner !== owner) continue;
      const p = this.#preds.get(u.id);
      if (!p) continue;

      if (!p.handedOver) {
        const moved = Math.abs(u.x - p.anchorX) + Math.abs(u.y - p.anchorY);
        if (moved > TAKEOVER_EPS || p.ticks >= MAX_LEAD_TICKS) {
          // Either the server picked the order up, or it never will. Both
          // end the same way: truth from here, with the gap smoothed out.
          p.handedOver = true;
          p.offX = p.x - u.x;
          p.offY = p.y - u.y;
        } else {
          p.ticks++;
          this.#advance(p);
          u.x = p.x;
          u.y = p.y;
          continue;
        }
      }

      p.offX *= SETTLE;
      p.offY *= SETTLE;
      if (Math.abs(p.offX) + Math.abs(p.offY) < SETTLED_EPS) {
        this.#preds.delete(u.id);
        continue;
      }
      u.x += p.offX;
      u.y += p.offY;
    }
  }

  /** One tick of movement, mirroring the sim's movement system. */
  #advance(p: Prediction): void {
    const path = p.path;
    if (!path) return;
    const here = tileIdx(Math.floor(p.x), Math.floor(p.y));
    let budget = p.baseSpeed * tileSpeedMult(this.#map, here);
    while (budget > 0 && p.pathIdx < path.length) {
      const next = path[p.pathIdx]!;
      if (this.#map.blocked[next]) {
        p.path = null;
        return;
      }
      const wx = tileX(next) + 0.5;
      const wy = tileY(next) + 0.5;
      const dx = wx - p.x;
      const dy = wy - p.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist <= budget) {
        p.x = wx;
        p.y = wy;
        p.pathIdx++;
        budget -= dist;
      } else {
        p.x += (dx / dist) * budget;
        p.y += (dy / dist) * budget;
        budget = 0;
      }
    }
  }
}
