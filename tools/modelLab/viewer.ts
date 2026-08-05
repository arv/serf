import * as THREE from 'three';
import { Kit } from './kit';
import { VARIANTS, requiredFiles, type Variant } from './variants';
import { makeDiorama, makeLights, makeRenderer, frame, YAW, type Diorama } from './scene';

/**
 * One WebGL context, many cards — but the context lives on a small detached
 * canvas, and each card owns a plain 2D canvas that the render is blitted
 * into.
 *
 * The obvious alternative (one page-sized canvas, each card drawn into its
 * own scissor rectangle) breaks wherever the page is embedded in a frame
 * that is sized to its content rather than scrolled: the canvas then spans
 * the whole document, and WebGL silently clamps its drawing buffer to
 * MAX_VIEWPORT_DIMS — 8192 on plenty of phones, against a 12000px page.
 * Every rectangle lands outside the buffer and nothing appears. Blitting
 * has no such ceiling, needs no scroll bookkeeping, and each card keeps its
 * last frame for free.
 */

/** Device pixels per card. Above this the memory stops buying sharpness. */
const MAX_SHOT = 900;

interface Card {
  el: HTMLElement;
  stage: HTMLElement;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  variant: Variant;
  diorama: Diorama;
  yaw: number;
  /** Backing-store size in device pixels. */
  w: number;
  h: number;
}

export interface MountOpts {
  /** Rewrites asset URLs (the gallery build inlines everything). */
  manager?: THREE.LoadingManager;
  onReady?: () => void;
}

/** A failure the reader can act on, instead of an empty page. */
function fail(message: string, detail?: unknown): void {
  const box = document.createElement('p');
  box.className = 'lab-error';
  box.textContent = detail ? `${message} — ${String(detail)}` : message;
  document.querySelector('main')?.prepend(box);
  document.documentElement.classList.add('lab-ready');
}

export async function mountGallery(opts: MountOpts = {}): Promise<void> {
  const K = new Kit(opts.manager);
  try {
    await K.load(requiredFiles());
  } catch (err) {
    fail('The models could not be loaded', err);
    return;
  }

  const glCanvas = document.createElement('canvas');
  let renderer: THREE.WebGLRenderer;
  try {
    renderer = makeRenderer(glCanvas);
  } catch (err) {
    fail('This browser would not give the page a WebGL context', err);
    return;
  }

  const scene = new THREE.Scene();
  makeLights(scene);
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 60);
  const holder = new THREE.Group();
  scene.add(holder);

  const cards: Card[] = [];
  for (const v of VARIANTS) {
    const el = document.querySelector<HTMLElement>(`[data-variant="${v.id}"]`);
    if (!el) continue;
    const stage = el.querySelector<HTMLElement>('[data-stage]') ?? el;
    const canvas = document.createElement('canvas');
    canvas.className = 'shot';
    const ctx = canvas.getContext('2d');
    if (!ctx) continue;
    stage.prepend(canvas);
    cards.push({
      el,
      stage,
      canvas,
      ctx,
      variant: v,
      diorama: makeDiorama(K, v),
      yaw: YAW,
      w: 0,
      h: 0,
    });
  }
  if (cards.length === 0) {
    fail('No cards to draw — the page markup and the variant list disagree');
    return;
  }

  /** Draw one card at its current angle. */
  function paint(c: Card): void {
    const rect = c.stage.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const scale = Math.min(1, MAX_SHOT / Math.max(rect.width * dpr, rect.height * dpr));
    const w = Math.max(1, Math.round(rect.width * dpr * scale));
    const h = Math.max(1, Math.round(rect.height * dpr * scale));
    if (c.w !== w || c.h !== h) {
      c.canvas.width = w;
      c.canvas.height = h;
      c.w = w;
      c.h = h;
    }
    renderer.setSize(w, h, false);
    holder.clear();
    holder.add(c.diorama.group);
    frame(camera, c.diorama, c.yaw, w / h);
    renderer.render(scene, camera);
    c.ctx.clearRect(0, 0, w, h);
    c.ctx.drawImage(glCanvas, 0, 0, w, h);
  }

  // Cards paint when they first come into view, and repaint on resize. In a
  // frame sized to its own content everything is "in view" at once, which is
  // exactly right: the page arrives finished rather than filling in.
  const io = new IntersectionObserver(
    (entries, obs) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const c = cards.find((x) => x.el === e.target);
        if (c) paint(c);
        obs.unobserve(e.target);
      }
    },
    { rootMargin: '400px 0px' },
  );
  for (const c of cards) io.observe(c.el);
  // Belt and braces: anything the observer has not reached within a beat
  // (a frame that reports no intersection at all) still gets its picture.
  setTimeout(() => {
    for (const c of cards) if (c.w === 0) paint(c);
  }, 1200);

  // --- turning ------------------------------------------------------------
  // A horizontal drag turns the model; a vertical one is left alone so the
  // page still scrolls under a thumb.
  let active: Card | null = null;
  let startX = 0;
  let startY = 0;
  let startYaw = 0;
  let axis: 'x' | 'y' | null = null;
  let queued = false;

  const repaint = (c: Card): void => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      paint(c);
    });
  };

  document.body.addEventListener('pointerdown', (e) => {
    const el = (e.target as HTMLElement | null)?.closest?.('[data-variant]');
    const c = cards.find((x) => x.el === el);
    if (!c) return;
    active = c;
    startX = e.clientX;
    startY = e.clientY;
    startYaw = c.yaw;
    axis = e.pointerType === 'mouse' ? 'x' : null;
  });

  window.addEventListener(
    'pointermove',
    (e) => {
      const c = active;
      if (!c) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (!axis) {
        if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return;
        axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
        if (axis === 'y') {
          active = null;
          return;
        }
      }
      if (e.cancelable) e.preventDefault();
      c.yaw = startYaw - dx * 0.012;
      repaint(c);
    },
    { passive: false },
  );

  const release = (): void => {
    active = null;
    axis = null;
  };
  window.addEventListener('pointerup', release);
  window.addEventListener('pointercancel', release);

  let resizeTimer = 0;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => {
      for (const c of cards) if (c.w > 0) paint(c);
    }, 200);
  });

  opts.onReady?.();
}
