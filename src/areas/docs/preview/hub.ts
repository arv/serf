import * as THREE from 'three';
import { loadGlbAssets, makeGlbBuilding } from '../../../render/assets';
import {
  loadCharacterAssets,
  makeCharacter,
  playAnimation,
  type AnimKey,
  type CharacterVisual,
} from '../../../render/characters';
import { makeRoadPile } from '../../../render/models';
import { BUILDING_DEFS, type BuildingTypeId } from '../../../sim/defs/buildings';
import { UNIT_DEFS, type UnitTypeId } from '../../../sim/defs/units';
import { YAW, frame, frameFor, makeLights, makePlate, makeRenderer, type Framing } from './scene';

/**
 * One WebGL context for every preview on every wiki page.
 *
 * Twenty cards must not mean twenty contexts: browsers cap live WebGL
 * contexts around a dozen and silently evict the oldest, so a page of
 * per-card canvases kills its own first previews. One page-sized scissored
 * canvas fails differently — WebGL clamps its drawing buffer to
 * MAX_VIEWPORT_DIMS (8192 on plenty of phones) and a tall wiki page is
 * longer than that. So: the context lives on a small detached canvas, each
 * card owns a plain 2D canvas, and a render is blitted in with drawImage.
 * The pattern is proven in tools/modelLab/viewer.ts; this is that, plus
 * animation and card churn.
 *
 * The hub outlives page turns on purpose — the docs screen keeps one key
 * across its whole life (see screenKey() in app/main.ts) and disposes the
 * hub only when the reader leaves /docs entirely, handing the context back
 * before a match asks for its own.
 */

/** Device pixels per card. Above this the memory stops buying sharpness. */
const MAX_SHOT = 900;
/** Animated cards repaint at ~20fps: idle loops read fine and phones stay cool. */
const ANIM_INTERVAL_MS = 50;

/** A page of looping idle animations is exactly what this preference is
 * about, so those cards paint one frame and hold it. */
function motionAllowed(): boolean {
  return !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export interface CardSpec {
  stage: HTMLElement;
  canvas: HTMLCanvasElement;
  kind: 'building' | 'unit';
  id: string;
  animated: boolean;
  interactive: boolean;
  /** Desyncs idle loops so a row of units doesn't breathe in unison. */
  seed: number;
  onState: (state: 'ready' | 'fallback') => void;
}

interface CardContent {
  group: THREE.Group;
  framing: Framing;
  /** The turf this card built. Everything else in `group` is a clone that
   * shares its geometry and materials with the game's template cache, so
   * the plate is the only part a card may free. */
  plate: THREE.Group;
  visual?: CharacterVisual;
}

interface Card extends CardSpec {
  ctx: CanvasRenderingContext2D;
  content: CardContent | null;
  yaw: number;
  visible: boolean;
  painted: boolean;
  w: number;
  h: number;
  cleanupDrag?: () => void;
}

interface Hub {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.OrthographicCamera;
  holder: THREE.Group;
  io: IntersectionObserver;
  cards: Set<Card>;
  raf: number;
  lastAnimPaint: number;
  onVisibility: () => void;
}

let hub: Hub | null = null;
/** A context we asked for and were refused — every card falls back. */
let hubFailed = false;

// The game's loaders are not idempotent: a second call re-fetches every
// model and rebuilds the cache. Cards register lazily and concurrently, so
// the promise is memoized here — never call the loaders directly.
let buildingAssets: Promise<boolean> | null = null;
let unitAssets: Promise<boolean> | null = null;

function ensureBuildingAssets(): Promise<boolean> {
  buildingAssets ??= loadGlbAssets().catch(() => false);
  return buildingAssets;
}

function ensureUnitAssets(): Promise<boolean> {
  unitAssets ??= loadCharacterAssets().catch(() => false);
  return unitAssets;
}

function getHub(): Hub | null {
  if (hub) return hub;
  if (hubFailed) return null;
  let renderer: THREE.WebGLRenderer;
  try {
    renderer = makeRenderer(document.createElement('canvas'));
  } catch {
    hubFailed = true;
    return null;
  }
  const scene = new THREE.Scene();
  makeLights(scene);
  const holder = new THREE.Group();
  scene.add(holder);
  const io = new IntersectionObserver(
    (entries) => {
      const h = hub;
      if (!h) return;
      for (const e of entries) {
        for (const card of h.cards) {
          if (card.stage !== e.target) continue;
          card.visible = e.isIntersecting;
          if (card.visible && card.content && !card.painted) paint(card);
        }
      }
      wakeAnimLoop();
    },
    // Paint just before a card scrolls in, so the reader never sees it land.
    { rootMargin: '400px 0px' },
  );
  hub = {
    renderer,
    scene,
    camera: new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 60),
    holder,
    io,
    cards: new Set(),
    raf: 0,
    lastAnimPaint: 0,
    onVisibility: () => wakeAnimLoop(),
  };
  document.addEventListener('visibilitychange', hub.onVisibility);
  // A context can go away long after it was handed over — the GPU resets,
  // or the browser reclaims one because another page wanted it. Without
  // this the cards keep their last blit and the loop keeps rendering into
  // nothing, which is worse than the fallback they were promised.
  renderer.domElement.addEventListener('webglcontextlost', onContextLost);
  return hub;
}

/** The context is gone: stop drawing and let every card show its tile. */
function onContextLost(event: Event): void {
  event.preventDefault();
  const h = hub;
  if (!h) return;
  hubFailed = true;
  if (h.raf !== 0) cancelAnimationFrame(h.raf);
  h.raf = 0;
  for (const card of h.cards) {
    card.content = null;
    card.painted = false;
    card.onState('fallback');
  }
}

function paint(card: Card): void {
  const h = hub;
  if (!h || !card.content) return;
  const rect = card.stage.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const scale = Math.min(1, MAX_SHOT / Math.max(rect.width * dpr, rect.height * dpr));
  const w = Math.max(1, Math.round(rect.width * dpr * scale));
  const h2 = Math.max(1, Math.round(rect.height * dpr * scale));
  if (card.w !== w || card.h !== h2) {
    card.canvas.width = w;
    card.canvas.height = h2;
    card.w = w;
    card.h = h2;
  }
  h.renderer.setSize(w, h2, false);
  h.holder.clear();
  h.holder.add(card.content.group);
  frame(h.camera, card.content.framing, card.yaw, w / h2);
  h.renderer.render(h.scene, h.camera);
  card.ctx.clearRect(0, 0, w, h2);
  card.ctx.drawImage(h.renderer.domElement, 0, 0, w, h2);
  card.painted = true;
}

// --- the one animation loop -------------------------------------------------
// Runs only while an animated card is actually on screen and the tab is
// visible; otherwise there is no rAF at all. Static building cards never
// wake it — they paint once and keep their last frame for free.

function animCards(): Card[] {
  const h = hub;
  if (!h) return [];
  if (!motionAllowed()) return [];
  return [...h.cards].filter((c) => c.animated && c.visible && c.content?.visual);
}

function wakeAnimLoop(): void {
  const h = hub;
  if (!h || h.raf !== 0 || document.hidden) return;
  if (animCards().length === 0) return;
  h.lastAnimPaint = performance.now();
  h.raf = requestAnimationFrame(animTick);
}

function animTick(t: number): void {
  const h = hub;
  if (!h) return;
  h.raf = 0;
  if (document.hidden) return;
  const cards = animCards();
  if (cards.length === 0) return;
  const elapsed = t - h.lastAnimPaint;
  if (elapsed >= ANIM_INTERVAL_MS) {
    h.lastAnimPaint = t;
    const dt = Math.min(elapsed / 1000, 0.1);
    for (const card of cards) {
      card.content?.visual?.mixer.update(dt);
      paint(card);
    }
  }
  h.raf = requestAnimationFrame(animTick);
}

// --- content ------------------------------------------------------------------

function buildContent(card: Card): CardContent | null {
  if (card.kind === 'building') {
    const id = card.id as BuildingTypeId;
    // The road is the one type without a model of its own; its site pile
    // stands in, exactly as it does in the world.
    const model = makeGlbBuilding(id, 0) ?? (BUILDING_DEFS[id].isRoad ? makeRoadPile() : null);
    if (!model) return null;
    const def = BUILDING_DEFS[id];
    const plateR = Math.max(def.w, def.h) * 0.95 + 0.5;
    const group = new THREE.Group();
    const plate = makePlate(plateR, Math.floor(card.seed * 997));
    group.add(plate, model);
    return { group, framing: frameFor(model, plateR), plate };
  }
  const made = makeCharacter(UNIT_DEFS[card.id as UnitTypeId].kindCode, 0, 0);
  if (!made) return null;
  const plateR = 0.62;
  const group = new THREE.Group();
  const plate = makePlate(plateR, Math.floor(card.seed * 997));
  group.add(plate, made.group);
  playAnimation(made.visual, 'idle', card.seed % 1);
  return { group, framing: frameFor(made.group, plateR), plate, visual: made.visual };
}

/**
 * Give back what this card owns.
 *
 * The hub deliberately outlives page turns, so a reader walking twenty
 * building pages registers and drops twenty cards inside one context —
 * anything not freed here accumulates until they leave the guide.
 *
 * What a card owns is narrow: the plate it built, its character's skeleton
 * (a clone gets its own bone texture) and its mixer's cached clips. The
 * models themselves are clones that share geometry and materials with the
 * template caches in assets.ts and characters.ts — disposing those would
 * blank the same building on every other card, and in the match after.
 */
function releaseContent(card: Card): void {
  const content = card.content;
  card.content = null;
  card.painted = false;
  if (!content) return;
  // The last card painted is still parented to the holder.
  content.group.removeFromParent();
  content.plate.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    o.geometry.dispose();
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
      // Not m.map: the ground speckle is one canvas shared by every plate.
      m.dispose();
    }
  });
  const visual = content.visual;
  if (visual) {
    visual.mixer.stopAllAction();
    visual.mixer.uncacheRoot(content.group);
    content.group.traverse((o) => {
      if (o instanceof THREE.SkinnedMesh) o.skeleton.dispose();
    });
  }
}

function attachDrag(card: Card): void {
  let startX = 0;
  let startY = 0;
  let startYaw = 0;
  let axis: 'x' | 'y' | null = null;
  let dragging = false;
  let queued = false;
  const repaint = (): void => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      paint(card);
    });
  };
  const down = (e: PointerEvent): void => {
    dragging = true;
    startX = e.clientX;
    startY = e.clientY;
    startYaw = card.yaw;
    axis = e.pointerType === 'mouse' ? 'x' : null;
  };
  // Move/up live on the window so a drag that leaves the card keeps turning
  // it; a vertical start hands the gesture back to the page scroll.
  const move = (e: PointerEvent): void => {
    if (!dragging) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (!axis) {
      if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return;
      axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
      if (axis === 'y') {
        dragging = false;
        return;
      }
    }
    if (e.cancelable) e.preventDefault();
    card.yaw = startYaw - dx * 0.012;
    repaint();
  };
  const up = (): void => {
    dragging = false;
    axis = null;
  };
  card.stage.addEventListener('pointerdown', down);
  window.addEventListener('pointermove', move, { passive: false });
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);
  card.cleanupDrag = () => {
    card.stage.removeEventListener('pointerdown', down);
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', up);
  };
}

// --- public surface -----------------------------------------------------------

export interface CardHandle {
  /** Swap the clip an animated unit card is playing. */
  setAnim(key: AnimKey): void;
  dispose(): void;
}

/**
 * Put a preview on a card. Registers with the shared context, loads the
 * right asset set (memoized — first building card pays ~3.6 MB once, first
 * unit card ~7.4 MB more), and reports 'ready' or 'fallback' so the wrapper
 * can drop its shimmer or show the drawn silhouette instead.
 */
export function registerCard(spec: CardSpec): CardHandle {
  const h = getHub();
  const ctx = spec.canvas.getContext('2d');
  if (!h || !ctx) {
    spec.onState('fallback');
    return { setAnim: () => undefined, dispose: () => undefined };
  }
  const card: Card = {
    ...spec,
    ctx,
    content: null,
    yaw: YAW,
    visible: false,
    painted: false,
    w: 0,
    h: 0,
  };
  h.cards.add(card);
  h.io.observe(card.stage);
  if (card.interactive) attachDrag(card);

  const assets = card.kind === 'building' ? ensureBuildingAssets() : ensureUnitAssets();
  void assets.then((ok) => {
    // The card may be gone (page turned) or the hub torn down (left /docs)
    // by the time the models land.
    if (!hub || !hub.cards.has(card)) return;
    card.content = ok ? buildContent(card) : null;
    if (!card.content) {
      card.onState('fallback');
      return;
    }
    card.onState('ready');
    if (card.visible) paint(card);
    wakeAnimLoop();
  });

  return {
    setAnim(key: AnimKey): void {
      const visual = card.content?.visual;
      if (!visual) return;
      playAnimation(visual, key, card.seed);
      // The loop carries the crossfade from here; a card that is somehow
      // between loops still gets one frame.
      if (card.visible) paint(card);
      wakeAnimLoop();
    },
    dispose(): void {
      const live = hub;
      card.cleanupDrag?.();
      if (!live) return;
      live.io.unobserve(card.stage);
      live.cards.delete(card);
      releaseContent(card);
    },
  };
}

/**
 * Tear the shared context down. Called by the docs screen's dispose, after
 * the Solid tree (and with it every card) is gone — a match booted next
 * deserves a browser with a free context slot, not one keyed to a wiki
 * nobody is reading.
 */
export function disposePreviewHub(): void {
  const h = hub;
  if (!h) return;
  hub = null;
  if (h.raf !== 0) cancelAnimationFrame(h.raf);
  document.removeEventListener('visibilitychange', h.onVisibility);
  h.io.disconnect();
  h.renderer.domElement.removeEventListener('webglcontextlost', onContextLost);
  for (const card of h.cards) {
    card.cleanupDrag?.();
    releaseContent(card);
  }
  h.cards.clear();
  h.renderer.dispose();
  // Prompt release rather than GC-timed: the next screen may want a
  // context immediately.
  h.renderer.forceContextLoss();
}
