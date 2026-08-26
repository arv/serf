import { onCleanup, onMount } from 'solid-js';
import type { BuildingSnap, MapSnapshot } from '../protocol/messages';
import { ACTION, AUX_STRIDE, type SlotCopy } from '../protocol/sabLayout';
import type { FogQuery } from '../render/fogOfWar';
import { batteryFramePacer } from '../render/framePacer';
import { playMin } from '../sim/map';
import { clamp } from '../shared/math';
import { play } from '../audio/audio';
import { capturePointer } from '../input/mouseCapture';
import { paintBase, ownerTint } from './minimapPaint';
import { toasts } from './store';

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

const css = (color: number): string => `#${color.toString(16).padStart(6, '0')}`;

/** How often the ground and the dots repaint. The fog itself only moves at
 * 12 Hz and units publish at 20; the view rectangle and the alert ripples
 * escape this throttle, so a pan never shows the chart lagging the world
 * and a warning never freezes mid-pulse. */
const REPAINT_MS = 150;

/** How far a finger may wobble and still mean the spot it touched. */
const TAP_SLOP_PX = 10;

/**
 * The minimap: the play square at a pixel or three per tile — terrain and
 * deposits under the fog's own shading, buildings as faction rectangles,
 * units as faction dots (the viewer's own in white — the one banner that
 * must read instantly), the camera's actual ground footprint as the view
 * frame — a rectangle turned by the camera's yaw, leaning 30° on the
 * default line and square to the chart once the camera has been turned to
 * the grid (Shift+wheel, Insert/Delete, [ ]); the chart itself stays north-up
 * the way Warcraft's does, rather than turning with the camera — and a
 * ripple wherever a standing alert toast knows a place.
 *
 * Three manners, picked by the frame it is mounted in:
 *   · 'pan' — the standing desktop card: press anywhere and the camera is
 *     there, drag and it follows, the classic RTS steering wheel.
 *   · 'jump' — the phone sheet: a tap glides the camera over and reports
 *     via onNavigate (the sheet closes itself on it); a hold-and-drag
 *     steers the camera live — the world above the sheet shows the ride —
 *     and the release closes too. Either way one gesture ends looking at
 *     the place, so the chart never has to share a small screen with it.
 *   · 'thumb' — a live face for the button that opens the sheet: same
 *     painting, no pointers of its own (the button takes the tap). What a
 *     glance buys is standing awareness at no cost the button wasn't
 *     already paying: your white blob, rival colors, a ripple when
 *     something is wrong.
 */
export function Minimap(props: {
  source: MinimapSource;
  mode: 'pan' | 'jump' | 'thumb';
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

  /** The alert toasts that know a place — each is a ripple on the chart.
   * Their eight-second lives bound the ripples' too: the chart warns
   * exactly as long as the toast does. */
  const alerts = (): { x: number; y: number }[] =>
    toasts().flatMap((t) => (t.focus ? [t.focus] : []));

  const quad = new Float64Array(8);
  const prevQuad = new Float64Array(8).fill(NaN);
  let lastPaint = -Infinity;
  let raf = 0;
  /** The canvas's 2D context, fetched once: getContext returns the same
   * object for the canvas's whole life (resizes included), so the lookup
   * has no business in the repaint path. */
  let ctx2d: CanvasRenderingContext2D | null = null;

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
    const ctx = (ctx2d ??= canvas.getContext('2d'));
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

    // Buildings: footprint rectangles, on ground the player has at least
    // seen — same memory rule the scene draws by.
    const fog = src.fog;
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.55)';
    ctx.lineWidth = 1;
    for (const b of src.buildings()) {
      if (!fog.exploredAt(b.x + b.w / 2, b.y + b.h / 2)) continue;
      ctx.fillStyle = css(ownerTint(b.owner, src.myPlayerId));
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
      ctx.fillStyle = css(ownerTint(owner, src.myPlayerId));
      ctx.fillRect((x - p0) * s - dot / 2, (z - p0) * s - dot / 2, dot, dot);
    }

    // The view frame. The standing chart draws it twice — a dark
    // underline so the white reads over bright meadow and dark forest
    // alike. The thumb draws it once and quietly: at forty-six pixels
    // the full-weight frame was the face, and the face should be map.
    ctx.beginPath();
    for (let i = 0; i < 4; i++) {
      const qx = (quad[i * 2]! - p0) * s;
      const qz = (quad[i * 2 + 1]! - p0) * s;
      if (i === 0) ctx.moveTo(qx, qz);
      else ctx.lineTo(qx, qz);
    }
    ctx.closePath();
    ctx.lineJoin = 'round';
    if (props.mode === 'thumb') {
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.55)';
      ctx.lineWidth = 1;
      ctx.stroke();
    } else {
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.5)';
      ctx.lineWidth = 2.5 * dpr;
      ctx.stroke();
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
      ctx.lineWidth = 1.25 * dpr;
      ctx.stroke();
    }

    // Alert ripples, over everything: "here" is the chart's whole answer
    // to a raid horn, and it must not hide under a forest or the frame.
    // The game's own danger tone (the clickable toast's border).
    for (const f of alerts()) {
      const px = (f.x - p0) * s;
      const pz = (f.y - p0) * s;
      // Two rings half a cycle apart: one is always mid-flight, so the
      // marker can't fade out for the instant a glance lands on it.
      for (const off of [0, 0.5]) {
        const ph = (now / 1100 + off) % 1;
        ctx.beginPath();
        ctx.arc(px, pz, (2.5 + ph * 10) * dpr, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(214, 106, 80, ${(1 - ph).toFixed(3)})`;
        ctx.lineWidth = 1.8 * dpr;
        ctx.stroke();
      }
      // The pin itself, ringed dark so it holds on lit meadow and in
      // the unexplored murk alike.
      ctx.beginPath();
      ctx.arc(px, pz, 2.5 * dpr, 0, Math.PI * 2);
      ctx.fillStyle = '#d66a50';
      ctx.fill();
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.6)';
      ctx.lineWidth = dpr;
      ctx.stroke();
    }
    prevQuad.set(quad);
  };

  onMount(() => {
    // The chart draws on the same main thread the valley does, and on the
    // same clock — the battery cap, not the panel's own refresh. Following
    // a pan is what makes that matter: the branch below deliberately
    // escapes the 150ms repaint clock, and unpaced that meant a phone
    // repainting the whole chart 90 or 120 times a second — every
    // building, every unit, a scaled blit apiece — for the length of a
    // swipe, against the pan those frames were competing with. The cap is
    // taken plain, with no interaction boost: what the finger is dragging
    // is the valley, and the chart is a chart. Desktop is uncapped, as
    // before.
    const pacer = batteryFramePacer();
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
      // as fast as the device draws anything so the frame tracks the drag
      // it is part of, and a standing alert redraws too so its ripple
      // actually travels.
      if (!(moved || alerts().length > 0 || now - lastPaint >= REPAINT_MS)) return;
      // Asked only once there is something to draw, so a chart that has
      // been idle repaints on the first frame that needs it rather than
      // waiting out an interval nothing was spending.
      if (!pacer.due(now)) return;
      repaint(now);
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
  /** A press is live (either steering mode). */
  let down = false;
  /** The press has traveled past the tap slop and is steering the camera. */
  let scrubbing = false;
  let downX = 0;
  let downY = 0;
  const reset = (): void => {
    down = false;
    scrubbing = false;
  };

  return (
    <canvas
      ref={canvas}
      class="minimap-canvas"
      classList={{ thumb: props.mode === 'thumb' }}
      onPointerDown={(e) => {
        if (props.mode === 'thumb') return;
        e.preventDefault();
        capturePointer(canvas, e);
        down = true;
        scrubbing = false;
        downX = e.clientX;
        downY = e.clientY;
        // The desktop card answers the press itself; the sheet waits to
        // see whether this is a tap or a drag.
        if (props.mode === 'pan') {
          scrubbing = true;
          const p = toWorld(e);
          src.jumpTo(p.x, p.z);
        }
      }}
      onPointerMove={(e) => {
        if (!down) return;
        if (!scrubbing && Math.hypot(e.clientX - downX, e.clientY - downY) > TAP_SLOP_PX) {
          scrubbing = true;
        }
        if (!scrubbing) return;
        const p = toWorld(e);
        src.jumpTo(p.x, p.z);
      }}
      onPointerUp={(e) => {
        if (!down) return;
        const wasScrub = scrubbing;
        reset();
        if (props.mode !== 'jump') return;
        if (wasScrub) {
          // The drag already steered the camera where it was let go; the
          // release just gets the sheet out of the way of looking at it.
          props.onNavigate?.();
          return;
        }
        const p = toWorld(e);
        play('uiClick');
        src.glideTo(p.x, p.z);
        props.onNavigate?.();
      }}
      onPointerCancel={reset}
    />
  );
}
