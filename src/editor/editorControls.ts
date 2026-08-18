import { screenToGround } from '../input/picking';
import type { CameraRig } from '../render/cameraRig';
import type { HeightField } from '../render/heightField';
import { inBounds } from '../shared/grid.ts';
import type { StartSpot } from '../sim/map.ts';
import { toolApplies, type Tool } from './brush.ts';
import type { BrushCursor } from './brushCursor.ts';
import type { StartMarkers } from './markers.ts';
import {
  BRUSH_MAX,
  BRUSH_MIN,
  PALETTE,
  activeFolds,
  brushRadius,
  setBrushRadius,
  setKaleido,
  setShowBounds,
  setTool,
  kaleido,
  showBounds,
  tool,
} from './uiState.ts';

import type { EditorMapState } from './editorMap.ts';

/** What the controls need from the screen; the screen owns all mutation. */
export interface EditorSurface {
  /** Live editing state (bounds checks, cursor validity). */
  state(): EditorMapState;
  /** A paint stroke is starting here — snapshot for undo, anchor jitter. */
  strokeBegin(x: number, y: number): void;
  /** Paint one stroke segment with the active tool/brush/folds. */
  stroke(t: Tool, x0: number, y0: number, x1: number, y1: number): void;
  /** A stroke finished (pointer up) — flush the heavyweight refreshes. */
  strokeEnd(): void;
  /** A start-spot drag is beginning — snapshot for undo. */
  startDragBegin(): void;
  undo(): void;
  redo(): void;
  /** Drag one seat's start to a footprint origin (kaleidoscope-aware). */
  moveStart(seat: number, spot: StartSpot): void;
  startDragEnd(seat: number): void;
  /** Toggle between top-down and the game's isometric view. */
  toggleView(): void;
}

/**
 * Pointer and keyboard input for the editor: left-drag paints (or drags a
 * start), the CameraRig keeps middle-drag pan / wheel zoom / arrows /
 * edge-scroll for itself. Desktop-only by design — no touch handling.
 */
export class EditorControls {
  #off = new AbortController();
  #canvas: HTMLCanvasElement;
  #rig: CameraRig;
  #heights: HeightField;
  #cursor: BrushCursor;
  #markers: StartMarkers;
  #surface: EditorSurface;
  /** Grid point of the previous stroke stamp, while the button is down. */
  #stroking: { x: number; y: number } | null = null;
  /** Seat being dragged plus the grab offset inside its footprint. */
  #dragging: { seat: number; dx: number; dy: number } | null = null;

  constructor(
    canvas: HTMLCanvasElement,
    rig: CameraRig,
    heights: HeightField,
    cursor: BrushCursor,
    markers: StartMarkers,
    surface: EditorSurface,
  ) {
    this.#canvas = canvas;
    this.#rig = rig;
    this.#heights = heights;
    this.#cursor = cursor;
    this.#markers = markers;
    this.#surface = surface;
    const signal = this.#off.signal;

    canvas.addEventListener('pointerdown', (e) => this.#onDown(e), { signal });
    canvas.addEventListener('pointermove', (e) => this.#onMove(e), { signal });
    canvas.addEventListener('pointerup', (e) => this.#onUp(e), { signal });
    canvas.addEventListener('pointercancel', (e) => this.#onUp(e), { signal });
    canvas.addEventListener('pointerleave', () => this.#cursor.hide(), { signal });
    window.addEventListener('keydown', (e) => this.#onKey(e), { signal });
  }

  dispose(): void {
    this.#off.abort();
  }

  #ground(e: PointerEvent): { x: number; y: number } | null {
    const p = screenToGround(this.#rig.camera, this.#canvas, e.clientX, e.clientY, this.#heights);
    return p === null ? null : { x: p.x, y: p.z };
  }

  #onDown(e: PointerEvent): void {
    if (e.button !== 0) return;
    const p = this.#ground(e);
    if (!p) return;
    const t = tool();
    if (t.kind === 'start') {
      const seat = this.#markers.hitTest(Math.floor(p.x), Math.floor(p.y));
      if (seat < 0) return;
      const s = this.#markers.starts[seat]!;
      this.#dragging = { seat, dx: p.x - s.x, dy: p.y - s.y };
      this.#canvas.setPointerCapture(e.pointerId);
      this.#surface.startDragBegin();
      return;
    }
    this.#stroking = { x: p.x, y: p.y };
    this.#canvas.setPointerCapture(e.pointerId);
    this.#surface.strokeBegin(p.x, p.y);
    this.#surface.stroke(t, p.x, p.y, p.x, p.y);
  }

  #onMove(e: PointerEvent): void {
    const p = this.#ground(e);
    if (!p) {
      this.#cursor.hide();
      return;
    }
    const t = tool();
    if (this.#dragging) {
      const spot = {
        x: Math.round(p.x - this.#dragging.dx),
        y: Math.round(p.y - this.#dragging.dy),
      };
      this.#surface.moveStart(this.#dragging.seat, spot);
      return;
    }
    if (this.#stroking && t.kind !== 'start') {
      this.#surface.stroke(t, this.#stroking.x, this.#stroking.y, p.x, p.y);
      this.#stroking = { x: p.x, y: p.y };
    }
    this.#updateCursor(t, p);
  }

  #onUp(e: PointerEvent): void {
    if (e.button !== 0 && e.type !== 'pointercancel') return;
    if (this.#dragging) {
      this.#surface.startDragEnd(this.#dragging.seat);
      this.#dragging = null;
    }
    if (this.#stroking) {
      this.#stroking = null;
      this.#surface.strokeEnd();
    }
  }

  #updateCursor(t: ReturnType<typeof tool>, p: { x: number; y: number }): void {
    if (t.kind === 'start') {
      // The marker ghosts are their own preview; no ring.
      this.#cursor.hide();
      return;
    }
    const state = this.#surface.state();
    const size = state.map.size;
    if (!inBounds(Math.floor(p.x), Math.floor(p.y), size)) {
      this.#cursor.hide();
      return;
    }
    this.#cursor.update(p.x, p.y, brushRadius(), activeFolds(), size, (cx, cy) =>
      toolApplies(state, t, cx, cy),
    );
  }

  #onKey(e: KeyboardEvent): void {
    // Typing a map name must not swap tools under the cursor.
    const el = e.target;
    if (
      el instanceof HTMLInputElement ||
      el instanceof HTMLTextAreaElement ||
      (el instanceof HTMLElement && el.isContentEditable)
    ) {
      return;
    }
    if (e.metaKey || e.ctrlKey) {
      // The canvas has no native undo; the browser must not eat these.
      const key = e.key.toLowerCase();
      if (key === 'z' && !e.altKey) {
        e.preventDefault();
        if (e.shiftKey) this.#surface.redo();
        else this.#surface.undo();
      } else if (key === 'y' && !e.altKey && !e.shiftKey) {
        e.preventDefault();
        this.#surface.redo();
      }
      return;
    }
    if (e.altKey) return;
    const entry = PALETTE.find((p) => p.key === e.key.toLowerCase());
    if (entry) {
      setTool(entry.tool);
      return;
    }
    switch (e.key) {
      case '[':
        setBrushRadius(Math.max(BRUSH_MIN, brushRadius() - 1));
        break;
      case ']':
        setBrushRadius(Math.min(BRUSH_MAX, brushRadius() + 1));
        break;
      case 'v':
      case 'V':
        this.#surface.toggleView();
        break;
      case 'k':
      case 'K':
        setKaleido(!kaleido());
        break;
      case 'b':
      case 'B':
        setShowBounds(!showBounds());
        break;
    }
  }
}
