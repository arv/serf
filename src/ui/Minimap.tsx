import { onCleanup, onMount } from 'solid-js';
import type { BuildingSnap, MapSnapshot } from '../protocol/messages';
import { ACTION, AUX_STRIDE, type SlotCopy } from '../protocol/sabLayout';
import type { FogQuery } from '../render/fogOfWar';
import { factionTint } from '../render/factionPalette';
import { playMin } from '../sim/map';
import { clamp } from '../shared/math';
import { play } from '../audio/audio';
import { paintBase, type MinimapTiles } from './minimapPaint';

/**
 * What the minimap reads and drives — assembled in main.ts where the
 * mirror, the fog, the SAB reader and the camera rig all live. Everything
 * here is a live handle, not a snapshot: the component polls on its own
 * clock, so nothing upstream has to know the chart exists.
 */
export interface MinimapSource {
  /** The mirror's map — live arrays, mutated in place as deltas land. */
  map: MapSnapshot;
  fog: FogQuery;
  buildings(): Iterable<BuildingSnap>;
  /** The newest published unit slot (the SAB reader's `latest`). */
  units(): SlotCopy;
  /** The camera's ground footprint, from CameraRig.viewQuad. */
  viewQuad(out: Float64Array): Float64Array;
  /** Center the camera now — the drag that steers by the chart. */
  jumpTo(x: number, z: number): void;
  /** Glide the camera over — the tap that jumps and looks. */
  glideTo(x: number, z: number): void;
  myPlayerId: number;
}

/** Bandits keep their in-world grey on the chart too — a camp should read
 * as somebody's, and grey is whose it is. */
const BANDIT_TINT = 0x9d968a;

const css = (color: number): string => `#${color.toString(16).padStart(6, '0')}`;

/** How often the ground and the dots repaint. The fog itself only moves at
 * 12 Hz and units publish at 20; the view rectangle alone escapes this
 * throttle, so a pan never shows the chart lagging the world. */
const REPAINT_MS = 150;

/**
 * The minimap: the play square at a pixel or three per tile — terrain and
 * deposits under the fog's own shading, buildings as faction rectangles,
 * units as faction dots, and the camera's actual ground footprint (a 45°
 * parallelogram, this being a fixed-yaw isometric rig) as the view frame.
 *
 * Two manners, picked by the frame it is mounted in:
 *   · 'pan' — the standing desktop card: press anywhere and the camera is
 *     there, drag and it follows, the classic RTS steering wheel.
 *   · 'jump' — the phone sheet: a tap glides the camera over and reports
 *     via onNavigate (the sheet closes itself on it), so the chart never
 *     has to share a small screen with the place it just showed you.
 */
export function Minimap(props: {
  source: MinimapSource;
  mode: 'pan' | 'jump';
  onNavigate?: () => void;
}) {
  let canvas!: HTMLCanvasElement;
  const src = props.source;
  const { play: playSide } = src.map;
  const p0 = playMin(src.map);

  // The ground layer, cached at one pixel per tile and scaled up crisp at
  // draw time. Rebuilt whole on the repaint clock — play² tiles is small
  // enough that dirty-tracking would cost more than it saves.
  const base = document.createElement('canvas');
  base.width = playSide;
  base.height = playSide;
  const baseCtx = base.getContext('2d')!;
  const img = baseCtx.createImageData(playSide, playSide);
  /** Fog shading for the ground: the scene's own presentation light, with
   * a floor under remembered ground — at a couple of pixels per tile the
   * shader's near-black memory would read as unexplored. */
  const shade = (x: number, z: number): number => {
    const lit = src.fog.litAt(x, z);
    return src.fog.exploredAt(x, z) ? Math.max(lit, 0.4) : lit;
  };

  const quad = new Float64Array(8);
  const prevQuad = new Float64Array(8).fill(NaN);
  let lastPaint = -Infinity;
  let raf = 0;

  const repaint = (now: number): void => {
    // Sized from what CSS says it is, on every paint: the sheet takes its
    // width from the viewport and a rotation changes it under us.
    const cssW = canvas.clientWidth;
    if (cssW === 0) return;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(cssW * dpr));
    if (canvas.width !== w) {
      canvas.width = w;
      canvas.height = w;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const s = w / playSide; // device pixels per tile

    if (now - lastPaint >= REPAINT_MS) {
      lastPaint = now;
      paintBase(src.map, shade, img.data);
      baseCtx.putImageData(img, 0, 0);
    }
    // Crisp tiles, not a blur: the chart is read by shape and color patch,
    // and bilinear scaling melts a three-tile ore seam into mud.
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(base, 0, 0, w, w);

    // Buildings: footprint rectangles in faction color, on ground the
    // player has at least seen — same memory rule the scene draws by.
    const fog = src.fog;
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.55)';
    ctx.lineWidth = 1;
    for (const b of src.buildings()) {
      if (!fog.exploredAt(b.x + b.w / 2, b.y + b.h / 2)) continue;
      ctx.fillStyle = css(factionTint(b.owner) ?? BANDIT_TINT);
      const bw = Math.max(b.w * s, 3);
      const bh = Math.max(b.h * s, 3);
      const bx = (b.x - p0) * s;
      const bz = (b.y - p0) * s;
      ctx.fillRect(bx, bz, bw, bh);
      ctx.strokeRect(bx + 0.5, bz + 0.5, bw - 1, bh - 1);
    }

    // Units: a dot apiece, enemies only where the fog lights them right
    // now — the chart must answer exactly what the map answers.
    const u = src.units();
    const dot = Math.max(2, Math.round(s));
    for (let i = 0; i < u.count; i++) {
      const a = i * AUX_STRIDE;
      if (u.aux[a + 4] === ACTION.dead) continue;
      const owner = u.aux[a + 1]!;
      const x = u.xs[i]!;
      const z = u.ys[i]!;
      if (owner !== src.myPlayerId && !fog.visibleAt(x, z)) continue;
      ctx.fillStyle = css(factionTint(owner) ?? BANDIT_TINT);
      ctx.fillRect((x - p0) * s - dot / 2, (z - p0) * s - dot / 2, dot, dot);
    }

    // The view frame, twice: a dark underline first so the white reads
    // over bright meadow and dark forest alike.
    ctx.beginPath();
    for (let i = 0; i < 4; i++) {
      const qx = (quad[i * 2]! - p0) * s;
      const qz = (quad[i * 2 + 1]! - p0) * s;
      if (i === 0) ctx.moveTo(qx, qz);
      else ctx.lineTo(qx, qz);
    }
    ctx.closePath();
    ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.5)';
    ctx.lineWidth = 2.5 * dpr;
    ctx.stroke();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
    ctx.lineWidth = 1.25 * dpr;
    ctx.stroke();
    prevQuad.set(quad);
  };

  onMount(() => {
    const loop = (now: number): void => {
      raf = requestAnimationFrame(loop);
      src.viewQuad(quad);
      let moved = false;
      for (let i = 0; i < 8; i++) {
        if (quad[i] !== prevQuad[i]) {
          moved = true;
          break;
        }
      }
      // The repaint clock covers the world changing; a camera pan redraws
      // immediately, so the frame tracks the drag it is part of.
      if (moved || now - lastPaint >= REPAINT_MS) repaint(now);
    };
    raf = requestAnimationFrame(loop);
  });
  onCleanup(() => cancelAnimationFrame(raf));

  const toWorld = (e: PointerEvent): { x: number; z: number } => {
    const r = canvas.getBoundingClientRect();
    return {
      x: clamp(p0 + ((e.clientX - r.left) / r.width) * playSide, p0, p0 + playSide),
      z: clamp(p0 + ((e.clientY - r.top) / r.height) * playSide, p0, p0 + playSide),
    };
  };
  let dragging = false;
  let downX = 0;
  let downY = 0;

  return (
    <canvas
      ref={canvas}
      class="minimap-canvas"
      onPointerDown={(e) => {
        e.preventDefault();
        downX = e.clientX;
        downY = e.clientY;
        if (props.mode !== 'pan') return;
        dragging = true;
        canvas.setPointerCapture(e.pointerId);
        const p = toWorld(e);
        src.jumpTo(p.x, p.z);
      }}
      onPointerMove={(e) => {
        if (!dragging) return;
        const p = toWorld(e);
        src.jumpTo(p.x, p.z);
      }}
      onPointerUp={(e) => {
        dragging = false;
        if (props.mode !== 'jump') return;
        // A tap, not a stray swipe over the sheet: fingers wobble a few
        // pixels, a scroll travels further.
        if (Math.hypot(e.clientX - downX, e.clientY - downY) > 10) return;
        const p = toWorld(e);
        play('uiClick');
        src.glideTo(p.x, p.z);
        props.onNavigate?.();
      }}
      onPointerCancel={() => {
        dragging = false;
      }}
    />
  );
}
