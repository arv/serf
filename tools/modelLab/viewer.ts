import * as THREE from 'three';
import { Kit } from './kit';
import { VARIANTS, requiredFiles, type Variant } from './variants';
import { makeDiorama, makeLights, makeRenderer, frame, YAW, type Diorama } from './scene';

/**
 * One WebGL context, many cards. A page of fifteen live canvases would blow
 * past the browser's context limit (and a phone's patience), so a single
 * full-viewport canvas sits behind the layout and each card is drawn into
 * its own scissor rectangle — the standard three.js multi-view trick.
 *
 * Cards render on demand: once when they scroll into view, and every frame
 * while a finger or a pointer is turning one. Nothing spins on its own, so
 * a parked gallery costs nothing.
 */

interface Card {
  el: HTMLElement;
  variant: Variant;
  diorama: Diorama;
  yaw: number;
  dirty: boolean;
  visible: boolean;
}

export interface MountOpts {
  /** Rewrites asset URLs (the gallery build inlines everything). */
  manager?: THREE.LoadingManager;
  /** Called once the models are in and the first frame is drawn. */
  onReady?: () => void;
}

export async function mountGallery(opts: MountOpts = {}): Promise<void> {
  const K = new Kit(opts.manager);
  await K.load(requiredFiles());

  const canvas = document.createElement('canvas');
  canvas.id = 'lab-canvas';
  document.body.appendChild(canvas);

  const renderer = makeRenderer(canvas);
  renderer.setScissorTest(true);
  const scene = new THREE.Scene();
  makeLights(scene);
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 60);

  const holder = new THREE.Group();
  scene.add(holder);

  const cards: Card[] = [];
  for (const v of VARIANTS) {
    const el = document.querySelector<HTMLElement>(`[data-variant="${v.id}"]`);
    if (!el) continue;
    cards.push({ el, variant: v, diorama: makeDiorama(K, v), yaw: YAW, dirty: true, visible: false });
  }

  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        const card = cards.find((c) => c.el === e.target);
        if (!card) continue;
        card.visible = e.isIntersecting;
        if (e.isIntersecting) card.dirty = true;
      }
      request();
    },
    { rootMargin: '200px 0px' },
  );
  for (const c of cards) io.observe(c.el);

  // --- turning ------------------------------------------------------------
  // A horizontal drag turns the model; a vertical one is left alone so the
  // page still scrolls under a thumb.
  let active: Card | null = null;
  let startX = 0;
  let startYaw = 0;
  let axisLocked: 'x' | 'y' | null = null;
  let startY = 0;

  const cardAt = (t: EventTarget | null): Card | null => {
    const el = (t as HTMLElement | null)?.closest?.('[data-variant]');
    return cards.find((c) => c.el === el) ?? null;
  };

  canvasLayer().addEventListener('pointerdown', (e) => {
    const c = cardAt(e.target);
    if (!c) return;
    active = c;
    startX = e.clientX;
    startY = e.clientY;
    startYaw = c.yaw;
    axisLocked = e.pointerType === 'mouse' ? 'x' : null;
  });
  window.addEventListener(
    'pointermove',
    (e) => {
      if (!active) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (!axisLocked) {
        if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return;
        axisLocked = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
        if (axisLocked === 'y') {
          active = null;
          return;
        }
      }
      if (e.cancelable) e.preventDefault();
      active.yaw = startYaw - dx * 0.012;
      active.dirty = true;
      request();
    },
    { passive: false },
  );
  const release = (): void => {
    active = null;
    axisLocked = null;
  };
  window.addEventListener('pointerup', release);
  window.addEventListener('pointercancel', release);

  // Reset / quarter-turn buttons, if the page provides them.
  document.querySelectorAll<HTMLElement>('[data-turn]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const c = cards.find((x) => x.el === btn.closest('[data-variant]'));
      if (!c) return;
      c.yaw += (Number(btn.dataset.turn) || 1) * (Math.PI / 2);
      c.dirty = true;
      request();
    });
  });

  // --- the frame ----------------------------------------------------------
  let pending = false;
  function request(): void {
    if (pending) return;
    pending = true;
    requestAnimationFrame(draw);
  }

  /**
   * The canvas floats over the cards (transparent, pointer-events: none) so
   * each stage's own backdrop shows through. That means the whole surface
   * has to be wiped and every visible card redrawn in one pass — a scissored
   * render only clears its own rectangle, and anything left outside it would
   * hang over the page as a ghost after a scroll.
   */
  function draw(): void {
    pending = false;
    const dpr = Math.min(window.devicePixelRatio, 2);
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      renderer.setPixelRatio(dpr);
      renderer.setSize(w, h, false);
    }
    renderer.setScissorTest(false);
    renderer.clear();
    renderer.setScissorTest(true);
    for (const c of cards) {
      if (!c.visible) continue;
      const stage = c.el.querySelector<HTMLElement>('[data-stage]') ?? c.el;
      const r = stage.getBoundingClientRect();
      if (r.bottom < 0 || r.top > h || r.width === 0) continue;
      const bottom = h - r.bottom;
      renderer.setViewport(r.left, bottom, r.width, r.height);
      renderer.setScissor(r.left, bottom, r.width, r.height);
      holder.clear();
      holder.add(c.diorama.group);
      frame(camera, c.diorama, c.yaw, r.width / r.height);
      renderer.render(scene, camera);
      c.dirty = false;
    }
    if (active) request();
  }

  // Scrolling and resizing both move every card's rectangle.
  const markAll = (): void => {
    request();
  };
  window.addEventListener('scroll', markAll, { passive: true });
  window.addEventListener('resize', markAll);

  markAll();
  opts.onReady?.();
}

/** Pointer events land on the cards, not on the canvas behind them. */
function canvasLayer(): HTMLElement {
  return document.body;
}
