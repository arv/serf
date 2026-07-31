import type * as THREE from 'three';
import { inBounds, tileIdx } from '../shared/grid';
import { buildingDef, type BuildingTypeId } from '../sim/defs/buildings';
import { canPlace } from '../sim/world';
import { UNIT_DEFS } from '../sim/defs/units';
import {
  bandArm,
  debugOpen,
  myPlayerId,
  placing,
  setBandArm,
  setDebugOpen,
  setPlacing,
  setSelectedBuilding,
  setSelection,
} from '../ui/store';
import { screenToGround, worldToScreen } from './picking';
import type { SceneSync } from '../render/sceneSync';
import type { GhostPlacement } from '../render/ghost';
import type { FogQuery } from '../render/fogOfWar';
import type { HeightField } from '../render/heightField';
import type { WorldMirror } from '../app/mirror';
import type { SimHost } from '../app/simHost';

const CLICK_RADIUS_PX = 16;
const DRAG_THRESHOLD_PX = 4;
const TOUCH_SLOP_PX = 12;

/** Kind codes that count as army for the select-army shortcut. */
const MILITARY_CODES = new Set(
  Object.values(UNIT_DEFS)
    .filter((d) => d.combat !== undefined)
    .map((d) => d.kindCode),
);

/**
 * Left click / drag: select player units. Right click: move order for the
 * current selection. Build-menu placement mode overrides both: hover shows a
 * validity-tinted ghost, left click places, right click / Esc cancels. A
 * small mode machine avoids the classic click-vs-drag papercuts; the band
 * rectangle is an HTML div, not WebGL.
 *
 * Touch speaks selection-first, like every phone RTS: tap a unit to select,
 * then tap the ground to send the selection there (an order pulse + a tick
 * of haptics confirm it). The HUD's marquee button arms a one-shot band
 * select — the next finger drag draws the band while the camera holds
 * still — and its army button grabs every soldier at once.
 */
export class Controls {
  #canvas: HTMLCanvasElement;
  #camera: THREE.Camera;
  #sync: SceneSync;
  #host: SimHost;
  #mirror: WorldMirror;
  #ghost: GhostPlacement;
  #heights: HeightField;
  /** Fog test, so placement cannot probe ground nobody has scouted. */
  #fog: FogQuery | null = null;
  #selection = new Set<number>();
  #dragStart: { x: number; y: number } | null = null;
  #dragging = false;
  #bandEl: HTMLDivElement;
  #hoverUnit = -1;
  #hoverBuilding = -1;
  #touchOrigin: { x: number; y: number } | null = null;
  /** A marquee drag in flight (armed by the HUD's band button). */
  #bandTouch = false;
  /** Camera gate — closed while a marquee drag owns the finger. */
  #rig: { touchPanEnabled: boolean } | null;

  constructor(
    canvas: HTMLCanvasElement,
    camera: THREE.Camera,
    sync: SceneSync,
    host: SimHost,
    mirror: WorldMirror,
    ghost: GhostPlacement,
    heights: HeightField,
    rig?: { touchPanEnabled: boolean },
  ) {
    this.#canvas = canvas;
    this.#camera = camera;
    this.#sync = sync;
    this.#host = host;
    this.#mirror = mirror;
    this.#ghost = ghost;
    this.#heights = heights;
    this.#rig = rig ?? null;

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

  /** Unit under the cursor (any owner), for hover hp bars. -1 when none. */
  get hoverUnit(): number {
    return this.#hoverUnit;
  }

  /** Building under the cursor, for hover hp bars. -1 when none. */
  get hoverBuilding(): number {
    return this.#hoverBuilding;
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
        if (e.pointerType === 'touch') {
          // The finger may be starting a map drag, so commit on release
          // and only if it stayed put — a drag pans instead of building.
          this.#touchOrigin = { x: e.clientX, y: e.clientY };
          return;
        }
        this.#place(e.clientX, e.clientY, e.shiftKey);
      } else if (e.button === 2) {
        this.#cancelPlacement();
      }
      return;
    }
    if (e.button === 0) {
      this.#dragStart = { x: e.clientX, y: e.clientY };
      this.#dragging = false;
      if (e.pointerType === 'touch') {
        this.#touchOrigin = { x: e.clientX, y: e.clientY };
        if (bandArm()) {
          // The marquee button armed this drag: it draws the selection
          // band, and the camera holds still until the finger lifts.
          this.#bandTouch = true;
          if (this.#rig) this.#rig.touchPanEnabled = false;
          this.#canvas.setPointerCapture(e.pointerId);
        }
      }
    } else if (e.button === 2) {
      this.#issueMove(e.clientX, e.clientY);
    }
  };

  setFog(fog: FogQuery): void {
    this.#fog = fog;
  }

  /**
   * You cannot build on ground you have never scouted.
   *
   * This is a real rule, not just a guard. Without it, arming a building
   * and clicking across the dark is a free map probe: the click is silently
   * dropped wherever something already stands, so "nothing happened" maps
   * out a rival's base without sending a single order. Requiring
   * exploration removes the question rather than the answer.
   */
  #explored(x: number, y: number, w: number, h: number): boolean {
    if (!this.#fog) return true;
    for (let ty = y; ty < y + h; ty++) {
      for (let tx = x; tx < x + w; tx++) {
        if (!this.#fog.exploredAt(tx + 0.5, ty + 0.5)) return false;
      }
    }
    return true;
  }

  #canPlaceHere(type: BuildingTypeId, x: number, y: number): boolean {
    const def = buildingDef(type);
    return this.#explored(x, y, def.w, def.h) && canPlace(this.#mirror.map, type, x, y);
  }

  /** Commit the armed building at this screen point, if it fits. */
  #place(px: number, py: number, keepArmed: boolean): void {
    const type = placing();
    if (!type) return;
    const origin = this.#placementOrigin(px, py);
    if (origin && this.#canPlaceHere(type, origin.x, origin.y)) {
      this.#host.sendCommands([
        { kind: 'placeBuilding', building: type, x: origin.x, y: origin.y },
      ]);
      if (!keepArmed) this.#cancelPlacement();
    }
  }

  /** A finger that travels past the slop is a pan, not a tap. */
  #cancelTap(px: number, py: number): void {
    const o = this.#touchOrigin;
    if (!o) return;
    const dx = px - o.x;
    const dy = py - o.y;
    if (dx * dx + dy * dy > TOUCH_SLOP_PX * TOUCH_SLOP_PX) {
      this.#touchOrigin = null;
    }
  }

  #onMove = (e: PointerEvent): void => {
    this.#updateHover(e.clientX, e.clientY);
    const type = placing();
    if (type) {
      // A travelling finger is panning the map, not aiming: drop the
      // pending placement (the ghost still tracks so the site stays visible).
      if (e.pointerType === 'touch') this.#cancelTap(e.clientX, e.clientY);
      const origin = this.#placementOrigin(e.clientX, e.clientY);
      if (origin) {
        this.#ghost.show(type);
        this.#ghost.moveTo(origin.x, origin.y, this.#canPlaceHere(type, origin.x, origin.y));
      }
      return;
    }
    this.#ghost.hide();
    if (!this.#dragStart) return;
    if (e.pointerType === 'touch' && !this.#bandTouch) {
      // The camera owns plain finger drags; only an armed marquee selects.
      this.#cancelTap(e.clientX, e.clientY);
      return;
    }
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
    const heldStill = this.#touchOrigin !== null;
    this.#touchOrigin = null;

    // Placement mode never arms a drag, so it has to be handled before the
    // drag guard below: touch commits here (a mouse placed on press).
    if (placing()) {
      if (e.pointerType === 'touch' && e.button === 0 && heldStill) {
        this.#place(e.clientX, e.clientY, false);
      }
      return;
    }
    if (e.button !== 0 || !this.#dragStart) return;
    const start = this.#dragStart;
    this.#dragStart = null;
    this.#bandEl.style.display = 'none';

    if (e.pointerType === 'touch') {
      if (this.#bandTouch) {
        // The armed marquee resolves: a real drag selects the band, a mere
        // tap falls back to point-select. One-shot either way.
        const dragged = this.#dragging;
        this.#bandTouch = false;
        this.#dragging = false;
        setBandArm(false);
        if (this.#rig) this.#rig.touchPanEnabled = true;
        if (dragged) this.#selectInRect(start.x, start.y, e.clientX, e.clientY, false);
        else this.#selectAtPoint(e.clientX, e.clientY, false);
        return;
      }
      // A tap that stayed put speaks selection-first; a travelled finger
      // was a pan and means nothing here.
      if (heldStill) this.#touchTap(e.clientX, e.clientY);
      return;
    }
    if (this.#dragging) {
      this.#dragging = false;
      this.#selectInRect(start.x, start.y, e.clientX, e.clientY, e.shiftKey);
    } else {
      this.#selectAtPoint(e.clientX, e.clientY, e.shiftKey);
    }
  };

  /**
   * The touch grammar: tap a unit to select it; with a selection standing,
   * tap the ground (or a foe) to send them there; with nothing selected a
   * tap opens your building underneath, or clears the panel.
   */
  #touchTap(px: number, py: number): void {
    const unitId = this.#unitAt(px, py);
    if (unitId >= 0) {
      setSelectedBuilding(null);
      this.#setSel(new Set([unitId]));
      return;
    }
    if (this.#selection.size > 0) {
      this.#issueMove(px, py);
      return;
    }
    this.#selectAtPoint(px, py, false); // building panel, or clears it
  }

  /** Track what's under the cursor — any owner; hp is interesting on foes. */
  #updateHover(px: number, py: number): void {
    const now = performance.now();
    let bestId = -1;
    let bestDist = CLICK_RADIUS_PX * CLICK_RADIUS_PX;
    for (const id of this.#sync.latestIds.keys()) {
      const pos = this.#sync.positionOf(id, now);
      if (!pos) continue;
      const groundY = this.#heights.at(pos.x, pos.y);
      const screen = worldToScreen(this.#camera, this.#canvas, pos.x, groundY + 0.4, pos.y);
      if (!screen) continue;
      const dx = screen.x - px;
      const dy = screen.y - py;
      const d = dx * dx + dy * dy;
      if (d < bestDist) {
        bestDist = d;
        bestId = id;
      }
    }
    this.#hoverUnit = bestId;
    this.#hoverBuilding = -1;
    if (bestId < 0) {
      const ground = screenToGround(this.#camera, this.#canvas, px, py, this.#heights);
      if (ground) {
        const tx = Math.floor(ground.x);
        const ty = Math.floor(ground.z);
        if (inBounds(tx, ty)) {
          this.#hoverBuilding = this.#mirror.map.buildingAt[tileIdx(tx, ty)]!;
        }
      }
    }
  }

  #playerUnitScreenPos(id: number, now: number): { x: number; y: number } | null {
    if (this.#sync.ownerOf(id) !== myPlayerId()) return null;
    const pos = this.#sync.positionOf(id, now);
    if (!pos) return null;
    const groundY = this.#heights.at(pos.x, pos.y);
    return worldToScreen(this.#camera, this.#canvas, pos.x, groundY + 0.4, pos.y);
  }

  /** Nearest own unit within tap radius of a screen point, or -1. */
  #unitAt(px: number, py: number): number {
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
    return bestId;
  }

  #selectAtPoint(px: number, py: number, additive: boolean): void {
    const bestId = this.#unitAt(px, py);
    if (bestId < 0 && !additive) {
      // No unit under the cursor — try a building.
      const ground = screenToGround(this.#camera, this.#canvas, px, py, this.#heights);
      if (ground) {
        const tx = Math.floor(ground.x);
        const ty = Math.floor(ground.z);
        if (inBounds(tx, ty)) {
          const bId = this.#mirror.map.buildingAt[tileIdx(tx, ty)]!;
          const snap = bId >= 0 ? this.#mirror.buildings.get(bId) : undefined;
          if (snap && snap.owner === myPlayerId()) {
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
    this.#orderPulse(px, py);
  }

  /** A ring blooming at the tap/click plus a tick of haptics: order taken. */
  #orderPulse(px: number, py: number): void {
    const el = document.createElement('div');
    el.style.cssText =
      `position:fixed;left:${px}px;top:${py}px;width:44px;height:44px;` +
      'margin:-22px 0 0 -22px;border:2px solid #e5c469;border-radius:50%;' +
      'pointer-events:none;z-index:10;opacity:0.9;' +
      'animation:serf-order-pulse 0.45s ease-out forwards;';
    if (!document.getElementById('serf-order-pulse-style')) {
      const style = document.createElement('style');
      style.id = 'serf-order-pulse-style';
      style.textContent =
        '@keyframes serf-order-pulse { from { transform: scale(1); opacity: 0.9; }' +
        ' to { transform: scale(0.25); opacity: 0; } }';
      document.head.appendChild(style);
    }
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 500);
    navigator.vibrate?.(12);
  }

  /** Clear both unit selection and the building panel (HUD ✕ button). */
  deselectAll(): void {
    this.#setSel(new Set());
    setSelectedBuilding(null);
  }

  /** Select every soldier you own — the phone answer to band-dragging an army. */
  selectArmy(): void {
    const sel = new Set<number>();
    for (const id of this.#sync.latestIds.keys()) {
      if (this.#sync.ownerOf(id) !== myPlayerId()) continue;
      const kind = this.#sync.kindOf(id);
      if (kind !== null && MILITARY_CODES.has(kind)) sel.add(id);
    }
    setSelectedBuilding(null);
    this.#setSel(sel);
  }
}
