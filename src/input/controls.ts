import type * as THREE from 'three';
import { inBounds, tileIdx } from '../shared/grid';
import { OWNER_CODE } from '../sim/defs/units';
import { buildingDef } from '../sim/defs/buildings';
import { canPlace } from '../sim/world';
import {
  debugOpen,
  placing,
  setDebugOpen,
  setPlacing,
  setSelectedBuilding,
  setSelection,
} from '../ui/store';
import { screenToGround, worldToScreen } from './picking';
import type { SceneSync } from '../render/sceneSync';
import type { GhostPlacement } from '../render/ghost';
import type { HeightField } from '../render/heightField';
import type { WorldMirror } from '../app/mirror';
import type { SimHost } from '../app/simHost';

const CLICK_RADIUS_PX = 16;
const DRAG_THRESHOLD_PX = 4;

/**
 * Left click / drag: select player units. Right click: move order for the
 * current selection. Build-menu placement mode overrides both: hover shows a
 * validity-tinted ghost, left click places, right click / Esc cancels. A
 * small mode machine avoids the classic click-vs-drag papercuts; the band
 * rectangle is an HTML div, not WebGL.
 */
export class Controls {
  #canvas: HTMLCanvasElement;
  #camera: THREE.Camera;
  #sync: SceneSync;
  #host: SimHost;
  #mirror: WorldMirror;
  #ghost: GhostPlacement;
  #heights: HeightField;
  #selection = new Set<number>();
  #dragStart: { x: number; y: number } | null = null;
  #dragging = false;
  #bandEl: HTMLDivElement;

  constructor(
    canvas: HTMLCanvasElement,
    camera: THREE.Camera,
    sync: SceneSync,
    host: SimHost,
    mirror: WorldMirror,
    ghost: GhostPlacement,
    heights: HeightField,
  ) {
    this.#canvas = canvas;
    this.#camera = camera;
    this.#sync = sync;
    this.#host = host;
    this.#mirror = mirror;
    this.#ghost = ghost;
    this.#heights = heights;

    this.#bandEl = document.createElement('div');
    this.#bandEl.style.cssText =
      'position:fixed; border:1px solid #bf4342; background:rgba(191,67,66,0.12); display:none; pointer-events:none; z-index:10;';
    document.body.appendChild(this.#bandEl);

    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener('pointerdown', this.#onDown);
    canvas.addEventListener('pointermove', this.#onMove);
    canvas.addEventListener('pointerup', this.#onUp);
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Escape') {
        if (placing()) this.#cancelPlacement();
        else {
          this.#setSel(new Set());
          setSelectedBuilding(null);
        }
      } else if (e.code === 'Backquote') {
        setDebugOpen(!debugOpen());
      }
    });
  }

  #cancelPlacement(): void {
    setPlacing(null);
    this.#ghost.hide();
  }

  /** Footprint origin tile for a ghost centered under the cursor. */
  #placementOrigin(px: number, py: number): { x: number; y: number } | null {
    const type = placing();
    if (!type) return null;
    const ground = screenToGround(this.#camera, this.#canvas, px, py, this.#heights);
    if (!ground) return null;
    const def = buildingDef(type);
    return {
      x: Math.round(ground.x - def.w / 2),
      y: Math.round(ground.z - def.h / 2),
    };
  }

  get selected(): ReadonlySet<number> {
    return this.#selection;
  }

  /** Drop ids that no longer exist (deaths); call once per frame. */
  prune(): void {
    let changed = false;
    for (const id of this.#selection) {
      if (!this.#sync.latestIds.has(id)) {
        this.#selection.delete(id);
        changed = true;
      }
    }
    if (changed) this.#setSel(this.#selection);
  }

  #setSel(sel: Set<number>): void {
    this.#selection = sel;
    setSelection(new Set(sel));
  }

  #onDown = (e: PointerEvent): void => {
    const type = placing();
    if (type) {
      if (e.button === 0) {
        const origin = this.#placementOrigin(e.clientX, e.clientY);
        if (origin && canPlace(this.#mirror.map, type, origin.x, origin.y)) {
          this.#host.sendCommands([
            { kind: 'placeBuilding', building: type, x: origin.x, y: origin.y },
          ]);
          if (!e.shiftKey) this.#cancelPlacement();
        }
      } else if (e.button === 2) {
        this.#cancelPlacement();
      }
      return;
    }
    if (e.button === 0) {
      this.#dragStart = { x: e.clientX, y: e.clientY };
      this.#dragging = false;
    } else if (e.button === 2) {
      this.#issueMove(e.clientX, e.clientY);
    }
  };

  #onMove = (e: PointerEvent): void => {
    const type = placing();
    if (type) {
      const origin = this.#placementOrigin(e.clientX, e.clientY);
      if (origin) {
        this.#ghost.show(type);
        this.#ghost.moveTo(origin.x, origin.y, canPlace(this.#mirror.map, type, origin.x, origin.y));
      }
      return;
    }
    this.#ghost.hide();
    if (!this.#dragStart) return;
    const dx = e.clientX - this.#dragStart.x;
    const dy = e.clientY - this.#dragStart.y;
    if (!this.#dragging && dx * dx + dy * dy > DRAG_THRESHOLD_PX * DRAG_THRESHOLD_PX) {
      this.#dragging = true;
      this.#canvas.setPointerCapture(e.pointerId);
      this.#bandEl.style.display = 'block';
    }
    if (this.#dragging) {
      const x0 = Math.min(this.#dragStart.x, e.clientX);
      const y0 = Math.min(this.#dragStart.y, e.clientY);
      this.#bandEl.style.left = `${x0}px`;
      this.#bandEl.style.top = `${y0}px`;
      this.#bandEl.style.width = `${Math.abs(dx)}px`;
      this.#bandEl.style.height = `${Math.abs(dy)}px`;
    }
  };

  #onUp = (e: PointerEvent): void => {
    if (e.button !== 0 || !this.#dragStart) return;
    const start = this.#dragStart;
    this.#dragStart = null;
    this.#bandEl.style.display = 'none';

    if (this.#dragging) {
      this.#dragging = false;
      this.#selectInRect(start.x, start.y, e.clientX, e.clientY, e.shiftKey);
    } else {
      this.#selectAtPoint(e.clientX, e.clientY, e.shiftKey);
    }
  };

  #playerUnitScreenPos(id: number, now: number): { x: number; y: number } | null {
    if (this.#sync.ownerOf(id) !== OWNER_CODE.player) return null;
    const pos = this.#sync.positionOf(id, now);
    if (!pos) return null;
    const groundY = this.#heights.at(pos.x, pos.y);
    return worldToScreen(this.#camera, this.#canvas, pos.x, groundY + 0.4, pos.y);
  }

  #selectAtPoint(px: number, py: number, additive: boolean): void {
    const now = performance.now();
    let bestId = -1;
    let bestDist = CLICK_RADIUS_PX * CLICK_RADIUS_PX;
    for (const id of this.#sync.latestIds.keys()) {
      const screen = this.#playerUnitScreenPos(id, now);
      if (!screen) continue;
      const dx = screen.x - px;
      const dy = screen.y - py;
      const d = dx * dx + dy * dy;
      if (d < bestDist) {
        bestDist = d;
        bestId = id;
      }
    }
    if (bestId < 0 && !additive) {
      // No unit under the cursor — try a building.
      const ground = screenToGround(this.#camera, this.#canvas, px, py, this.#heights);
      if (ground) {
        const tx = Math.floor(ground.x);
        const ty = Math.floor(ground.z);
        if (inBounds(tx, ty)) {
          const bId = this.#mirror.map.buildingAt[tileIdx(tx, ty)]!;
          const snap = bId >= 0 ? this.#mirror.buildings.get(bId) : undefined;
          if (snap && snap.owner === 'player') {
            this.#setSel(new Set());
            setSelectedBuilding(snap);
            return;
          }
        }
      }
    }
    setSelectedBuilding(null);
    const sel = additive ? new Set(this.#selection) : new Set<number>();
    if (bestId >= 0) {
      if (additive && sel.has(bestId)) sel.delete(bestId);
      else sel.add(bestId);
    }
    this.#setSel(sel);
  }

  #selectInRect(x0: number, y0: number, x1: number, y1: number, additive: boolean): void {
    const now = performance.now();
    const minX = Math.min(x0, x1);
    const maxX = Math.max(x0, x1);
    const minY = Math.min(y0, y1);
    const maxY = Math.max(y0, y1);
    const sel = additive ? new Set(this.#selection) : new Set<number>();
    for (const id of this.#sync.latestIds.keys()) {
      const screen = this.#playerUnitScreenPos(id, now);
      if (!screen) continue;
      if (screen.x >= minX && screen.x <= maxX && screen.y >= minY && screen.y <= maxY) {
        sel.add(id);
      }
    }
    this.#setSel(sel);
  }

  #issueMove(px: number, py: number): void {
    if (this.#selection.size === 0) return;
    const ground = screenToGround(this.#camera, this.#canvas, px, py, this.#heights);
    if (!ground) return;
    this.#host.sendCommands([
      {
        kind: 'moveUnits',
        unitIds: [...this.#selection],
        x: Math.floor(ground.x),
        y: Math.floor(ground.z),
      },
    ]);
  }
}
