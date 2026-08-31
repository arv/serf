import * as THREE from 'three';
import {worldToScreen} from '../input/picking';
import type {HeightField} from '../render/heightField';
import {eachMaterial} from '../render/materials';
import {makeGhostModel} from '../render/models';
import * as BuildingTypeId from '../sim/defs/buildingTypeIdEnum.ts';
import type {StartSpot} from '../sim/map.ts';

const INVALID = new THREE.Color(0xd45252);

/** Storehouse footprint side; a StartSpot is its origin tile. */
const START_W = 3;

/**
 * The editable start positions: one translucent storehouse ghost per seat,
 * in that seat's faction colors, with a floating "Player N" label. The
 * ghosts are the editor's only standing buildings — the map itself stays
 * pristine — and dragging one is how a start moves.
 */
export class StartMarkers {
  #scene: THREE.Scene;
  #heights: HeightField;
  #overlay: HTMLElement;
  #ghosts: THREE.Group[] = [];
  #labels: HTMLSpanElement[] = [];
  /** Each ghost material's untinted color, for validity tinting. */
  #base = new Map<THREE.Material, THREE.Color>();
  #starts: StartSpot[] = [];

  constructor(scene: THREE.Scene, heights: HeightField, overlay: HTMLElement) {
    this.#scene = scene;
    this.#heights = heights;
    this.#overlay = overlay;
  }

  /** Rebuild for a new seat list (New map / Import / player-count change). */
  set(starts: readonly StartSpot[]): void {
    this.clear();
    this.#starts = starts.map(s => ({...s}));
    this.#starts.forEach((s, p) => {
      const ghost = makeGhostModel(BuildingTypeId.storehouse, 0.6, p);
      this.#ghosts.push(ghost);
      ghost.traverse(obj => {
        if (obj instanceof THREE.Mesh) {
          eachMaterial(obj, m => {
            const lit = m as THREE.MeshLambertMaterial;
            if (lit.color) this.#base.set(m, lit.color.clone());
          });
        }
      });
      this.#scene.add(ghost);

      const label = document.createElement('span');
      label.textContent = `Player ${p + 1}`;
      label.style.cssText =
        'position:absolute;transform:translate(-50%,0);font:600 12px system-ui,sans-serif;' +
        'color:#f0ede4;text-shadow:0 1px 3px rgba(0,0,0,0.85);white-space:nowrap;' +
        'pointer-events:none';
      this.#overlay.appendChild(label);
      this.#labels.push(label);
      this.#place(p);
    });
  }

  get starts(): readonly StartSpot[] {
    return this.#starts;
  }

  /** Move one seat's spot (drag); tint tells the author whether it's legal. */
  moveSeat(seat: number, spot: StartSpot, valid: boolean): void {
    const s = this.#starts[seat];
    if (!s) return;
    s.x = spot.x;
    s.y = spot.y;
    this.#place(seat);
    this.#tint(seat, valid ? null : INVALID);
  }

  /** Restore normal faction tinting (drag ended). */
  clearTint(seat: number): void {
    this.#tint(seat, null);
  }

  /** Which seat's 3x3 footprint covers this tile, or -1. */
  hitTest(x: number, y: number): number {
    for (let p = 0; p < this.#starts.length; p++) {
      const s = this.#starts[p]!;
      if (x >= s.x && x < s.x + START_W && y >= s.y && y < s.y + START_W)
        return p;
    }
    return -1;
  }

  /** Re-seat every ghost on the (possibly sculpted) ground. */
  refreshHeights(): void {
    for (let p = 0; p < this.#starts.length; p++) this.#place(p);
  }

  /** Keep the DOM labels pinned to the ghosts (call each frame). */
  updateLabels(camera: THREE.Camera, canvas: HTMLCanvasElement): void {
    for (let p = 0; p < this.#starts.length; p++) {
      const s = this.#starts[p]!;
      const cx = s.x + START_W / 2;
      const cz = s.y + START_W / 2;
      const pt = worldToScreen(
        camera,
        canvas,
        cx,
        this.#heights.at(cx, cz) + 2.6,
        cz,
      );
      const label = this.#labels[p]!;
      label.style.left = `${pt.x}px`;
      label.style.top = `${pt.y}px`;
    }
  }

  #place(seat: number): void {
    const s = this.#starts[seat]!;
    const ghost = this.#ghosts[seat]!;
    const cx = s.x + START_W / 2;
    const cz = s.y + START_W / 2;
    ghost.position.set(cx, this.#heights.at(cx, cz), cz);
  }

  #tint(seat: number, color: THREE.Color | null): void {
    const ghost = this.#ghosts[seat];
    if (!ghost) return;
    ghost.traverse(obj => {
      if (obj instanceof THREE.Mesh) {
        eachMaterial(obj, m => {
          const base = this.#base.get(m);
          const lit = m as THREE.MeshLambertMaterial;
          if (!base || !lit.color) return;
          if (color) lit.color.copy(base).lerp(color, 0.65);
          else lit.color.copy(base);
        });
      }
    });
  }

  clear(): void {
    for (const g of this.#ghosts) {
      this.#scene.remove(g);
      // Ghost materials are per-instance clones (makeGhostModel clones on
      // build); free them — the editor rebuilds markers inside a live
      // context. Geometry is the shared building GLB: leave it alone.
      g.traverse(obj => {
        if (obj instanceof THREE.Mesh) {
          eachMaterial(obj, m => m.dispose());
        }
      });
    }
    for (const l of this.#labels) l.remove();
    this.#ghosts = [];
    this.#labels = [];
    this.#base = new Map();
    this.#starts = [];
  }
}
