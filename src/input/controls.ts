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
  pushToast,
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
import type { BuildingSnap } from '../protocol/messages';

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
 * then tap the ground to send the selection there as a half attack-move —
 * plain for the front half of the route so a retreat breaks clean, live for
 * the back half so soldiers still fight where they were sent (an order
 * pulse + a tick of haptics confirm it) — though a tap on one of your own
 * buildings opens that building instead of marching onto it. The HUD's marquee button arms
 * a one-shot band select — the next finger drag draws the band while the
 * camera holds still — and its army button grabs every soldier at once.
 * Placement has no Esc and no right click there either, so the way out of
 * an armed building is the HUD's cancel bar, which comes back through
 * setPlacement(null).
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
  /** Last pointer position + dirty flag: pointermove can fire at hundreds
   * of Hz, so the O(units) hover scan runs at most once per frame, from
   * the rAF loop (updateHoverIfDirty). */
  #hoverX = 0;
  #hoverY = 0;
  #hoverDirty = false;
  #hoverIsTouch = false;
  // Scratch objects for the per-unit screen-space scans.
  #scratchPos = { x: 0, y: 0 };
  #scratchScreen = { x: 0, y: 0 };
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
    // The gesture can also end without a pointerup: the system takes it (a
    // notification shade, a browser back-swipe) or the capture is lost.
    // Nothing it was building up should land afterwards.
    canvas.addEventListener('pointercancel', this.#onCancel);
    canvas.addEventListener('lostpointercapture', this.#onCancel);
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Escape') {
        if (placing()) this.setPlacement(null);
        else {
          this.#setSel(new Set());
          setSelectedBuilding(null);
        }
      } else if (e.code === 'Backquote') {
        const open = !debugOpen();
        setDebugOpen(open);
        // The worker skips serializing its jobs table until told to.
        this.#host.setDebug(open);
      }
    });
  }

  /**
   * Arm (or disarm) build placement. Everything that changes the mode goes
   * through here, the HUD's buttons included: writing the signal alone
   * leaves the ghost standing on the map until the next pointer move, and
   * a finger that just tapped Cancel may never send one.
   */
  setPlacement(type: BuildingTypeId | null): void {
    setPlacing(type);
    if (type === null) this.#ghost.hide();
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
      // A corpse stays in the publish while its death animation plays, so
      // "gone from the publish" is not enough: a wiped squad went on
      // wearing selection rings, counting in the HUD, and putting dead ids
      // into the next move order.
      if (!this.#sync.latestIds.has(id) || this.#sync.isDead(id)) {
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

  /**
   * Forget everything the current gesture had started: the band
   * rectangle, and the tap that would have selected or placed.
   * Used when the gesture is taken away rather than finished — a cancelled
   * touch, a lost capture, or a second finger arriving.
   */
  #abortGesture = (): void => {
    this.#touchOrigin = null;
    this.#dragStart = null;
    this.#dragging = false;
    this.#bandEl.style.display = 'none';
  };

  #onCancel = (): void => {
    this.#abortGesture();
  };

  /** Only the first finger down commands anything. A second one means the
   * camera — pinch-zoom, two-finger pan — and what the first was starting
   * is not what the player meant by it. */
  #secondaryTouch(e: PointerEvent): boolean {
    return e.pointerType === 'touch' && !e.isPrimary;
  }

  #onDown = (e: PointerEvent): void => {
    if (this.#secondaryTouch(e)) {
      this.#abortGesture();
      return;
    }
    const type = placing();
    if (type) {
      if (e.button === 0) {
        if (e.pointerType === 'touch') {
          // The finger may be starting a map drag, so commit on release
          // and only if it stayed put — a drag pans instead of building.
          // Meanwhile the ghost appears under the finger at once: touch
          // has no hover, so the press itself is the only chance to show
          // the footprint and its valid/invalid tint before it commits.
          this.#touchOrigin = { x: e.clientX, y: e.clientY };
          const origin = this.#placementOrigin(e.clientX, e.clientY);
          if (origin) {
            this.#ghost.show(type);
            this.#ghost.moveTo(origin.x, origin.y, this.#canPlaceHere(type, origin.x, origin.y));
          }
          return;
        }
        this.#place(e.clientX, e.clientY, e.shiftKey);
      } else if (e.button === 2) {
        this.setPlacement(null);
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
      this.#issueMove(e.clientX, e.clientY, false);
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
      if (!keepArmed) this.setPlacement(null);
      return;
    }
    // A refused spot must never be a silent nothing. With a mouse the red
    // ghost already warned before the click; a finger taps blind — no
    // hover — so without this the phone reads "building is broken" where
    // the desktop reads "I can see it won't fit". Same rule, told out loud.
    if (origin) {
      this.#ghost.show(type);
      this.#ghost.moveTo(origin.x, origin.y, false);
      const def = buildingDef(type);
      pushToast(
        this.#explored(origin.x, origin.y, def.w, def.h)
          ? 'No room to build there.'
          : 'Too dark to build — nobody has scouted that ground.',
      );
      navigator.vibrate?.(30);
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
    if (this.#secondaryTouch(e)) return;
    this.#hoverX = e.clientX;
    this.#hoverY = e.clientY;
    this.#hoverIsTouch = e.pointerType === 'touch';
    this.#hoverDirty = true;
    if (placing()) {
      // A travelling finger is panning the map, not aiming: drop the
      // pending placement (the ghost still tracks so the site stays visible).
      if (e.pointerType === 'touch') this.#cancelTap(e.clientX, e.clientY);
      // The ghost itself moves from the rAF loop (updateHoverIfDirty, via
      // the dirty flag set above): pointermove fires at input-device rate —
      // up to 1000 Hz on a gaming mouse — and re-running placement
      // validity and the outline geometry per event bought nothing a frame
      // could show.
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
    if (this.#secondaryTouch(e)) return;
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
   * The touch grammar: tap a unit to select it; tap one of your buildings to
   * open its panel; otherwise, with a selection standing, tap the ground (or
   * a foe) to send them there. Empty ground with nothing selected clears.
   *
   * Your own buildings outrank the move order on purpose. A finger has one
   * gesture, so while a selection stood, a tap on the brewery marched them
   * over instead of opening it — and with the village built up, that left
   * the panels reachable only by deselecting first. Nothing is lost: a
   * building's tiles are blocked, so that order only ever walked them to
   * the free ground beside it, which is exactly what tapping beside it
   * does. Foreign buildings stay an order, so an enemy camp still raids.
   */
  #touchTap(px: number, py: number): void {
    const unitId = this.#unitAt(px, py);
    if (unitId >= 0) {
      setSelectedBuilding(null);
      this.#setSel(new Set([unitId]));
      return;
    }
    const building = this.#ownBuildingAt(px, py);
    if (building) {
      this.#setSel(new Set());
      setSelectedBuilding(building);
      return;
    }
    if (this.#selection.size > 0) {
      // The phone default is the half attack-move: one gesture has to serve
      // both "go fight over there" and "get out of there". Quiet for the
      // front half of the walk, so a tap away from a lost fight actually
      // escapes it; live for the back half, so a tapped army still fights
      // what it finds where it was sent.
      this.#issueMove(px, py, 'half');
      return;
    }
    this.deselectAll();
  }

  /** Run the deferred hover scan (and the placement ghost, which defers
   * from pointermove the same way), if the pointer moved since last frame. */
  updateHoverIfDirty(): void {
    if (!this.#hoverDirty) return;
    this.#hoverDirty = false;
    this.#updateGhost(this.#hoverX, this.#hoverY);
    this.#updateHover(this.#hoverX, this.#hoverY);
  }

  /** Track the armed building's ghost under the pointer. */
  #updateGhost(px: number, py: number): void {
    const type = placing();
    if (!type) return;
    const origin = this.#placementOrigin(px, py);
    if (!origin) return;
    this.#ghost.show(type);
    this.#ghost.moveTo(origin.x, origin.y, this.#canPlaceHere(type, origin.x, origin.y));
  }

  /** Track what's under the cursor — any owner; hp is interesting on foes. */
  #updateHover(px: number, py: number): void {
    const now = performance.now();
    let bestId = -1;
    let bestDist = CLICK_RADIUS_PX * CLICK_RADIUS_PX;
    // Touch placement mode has no hover to show — skip the unit scan.
    if (!(this.#hoverIsTouch && placing())) {
      const pos = this.#scratchPos;
      for (const id of this.#sync.latestIds.keys()) {
        if (!this.#sync.positionOfInto(id, now, pos)) continue;
        const groundY = this.#heights.at(pos.x, pos.y);
        const screen = worldToScreen(
          this.#camera,
          this.#canvas,
          pos.x,
          groundY + 0.4,
          pos.y,
          this.#scratchScreen,
        );
        const dx = screen.x - px;
        const dy = screen.y - py;
        const d = dx * dx + dy * dy;
        if (d < bestDist) {
          bestDist = d;
          bestId = id;
        }
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

  /** Screen position of an own unit, written into `out`; false otherwise. */
  #playerUnitScreenPosInto(id: number, now: number, out: { x: number; y: number }): boolean {
    if (this.#sync.ownerOf(id) !== myPlayerId()) return false;
    const pos = this.#scratchPos;
    if (!this.#sync.positionOfInto(id, now, pos)) return false;
    const groundY = this.#heights.at(pos.x, pos.y);
    worldToScreen(this.#camera, this.#canvas, pos.x, groundY + 0.4, pos.y, out);
    return true;
  }

  /** Nearest own unit within tap radius of a screen point, or -1. */
  #unitAt(px: number, py: number): number {
    const now = performance.now();
    let bestId = -1;
    let bestDist = CLICK_RADIUS_PX * CLICK_RADIUS_PX;
    const screen = this.#scratchScreen;
    for (const id of this.#sync.latestIds.keys()) {
      if (!this.#playerUnitScreenPosInto(id, now, screen)) continue;
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

  /** The building of yours under a screen point, or null. */
  #ownBuildingAt(px: number, py: number): BuildingSnap | null {
    const ground = screenToGround(this.#camera, this.#canvas, px, py, this.#heights);
    if (!ground) return null;
    const tx = Math.floor(ground.x);
    const ty = Math.floor(ground.z);
    if (!inBounds(tx, ty)) return null;
    const bId = this.#mirror.map.buildingAt[tileIdx(tx, ty)]!;
    const snap = bId >= 0 ? this.#mirror.buildings.get(bId) : undefined;
    return snap && snap.owner === myPlayerId() ? snap : null;
  }

  #selectAtPoint(px: number, py: number, additive: boolean): void {
    const bestId = this.#unitAt(px, py);
    if (bestId < 0 && !additive) {
      // No unit under the cursor — try a building.
      const snap = this.#ownBuildingAt(px, py);
      if (snap) {
        this.#setSel(new Set());
        setSelectedBuilding(snap);
        return;
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
    const screen = this.#scratchScreen;
    for (const id of this.#sync.latestIds.keys()) {
      if (!this.#playerUnitScreenPosInto(id, now, screen)) continue;
      if (screen.x >= minX && screen.x <= maxX && screen.y >= minY && screen.y <= maxY) {
        sel.add(id);
      }
    }
    this.#setSel(sel);
  }

  /**
   * Send the selection somewhere. `attack` picks between the three orders:
   * `true` is an attack-move that engages enemies met along the way,
   * `'half'` walks the front half of the route as a plain move before going
   * live, and `false` is the plain move that ignores enemies throughout.
   * Touch taps default to the half order (a phone has one gesture for both
   * charging and fleeing); desktop right-click stays the plain move until
   * the `m`/`a` shortcuts land.
   */
  #issueMove(px: number, py: number, attack: boolean | 'half'): void {
    if (this.#selection.size === 0) return;
    const ground = screenToGround(this.#camera, this.#canvas, px, py, this.#heights);
    if (!ground) return;
    this.#host.sendCommands([
      {
        kind: 'moveUnits',
        unitIds: [...this.#selection],
        x: Math.floor(ground.x),
        y: Math.floor(ground.z),
        ...(attack ? { attack } : {}),
      },
    ]);
    this.#orderPulse(px, py, attack);
  }

  /** A ring blooming at the tap/click plus a tick of haptics: order taken.
   * Attack-moves pulse a solid red ring, plain moves a dashed gold one, and
   * the half order a dotted red — three border styles, so the shape carries
   * the difference where color vision cannot. */
  #orderPulse(px: number, py: number, attack: boolean | 'half'): void {
    const border =
      attack === true
        ? 'solid #bf4342'
        : attack === 'half'
          ? 'dotted #bf4342'
          : 'dashed #e5c469';
    const el = document.createElement('div');
    el.style.cssText =
      `position:fixed;left:${px}px;top:${py}px;width:44px;height:44px;` +
      `margin:-22px 0 0 -22px;border:2px ${border};` +
      'border-radius:50%;pointer-events:none;z-index:10;opacity:0.9;' +
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
