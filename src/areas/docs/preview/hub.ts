import type { Enum } from '../../../shared/enum.ts';
import * as THREE from 'three';
import { loadGlbAssets, makeGlbBuilding } from '../../../render/assets';
import {
  loadCharacterAssets,
  makeCharacter,
  playAnimation,
  type CharacterVisual,
} from '../../../render/characters';
import { makeRoadPile } from '../../../render/models';
import { BUILDING_DEFS, type BuildingTypeId, buildingFromKey } from '../../../sim/defs/buildings';
import { BANDIT } from '../../../sim/entities';
import { UNIT_DEFS, type UnitTypeId, unitFromKey } from '../../../sim/defs/units';
import { RAIDER_BUILDINGS, RAIDER_UNITS } from '../data';
import { YAW, frame, frameFor, makeLights, makePlate, makeRenderer, type Framing } from './scene';
import * as AnimKey from '../../../render/animKeyEnum.ts';

type AnimKey = Enum<typeof AnimKey>;

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
/** How far outside the viewport a card is still worth painting. */
const PREPAINT_MARGIN = 400;

/**
 * Is this card near enough to paint, measured rather than observed?
 *
 * The observers are the cheap path and the right one, but they are not
 * guaranteed to have reported yet — and in an environment that composites
 * only on demand (headless Chrome driving a screenshot, notably) they may
 * not report at all, which would leave every card blank forever.
 * tools/modelLab/viewer.ts kept a timed sweep for the same reason; this
 * measures instead, which is exact and costs one rect.
 */
function withinViewport(card: Card, margin: number): boolean {
  const r = card.stage.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return false;
  return r.bottom > -margin && r.top < window.innerHeight + margin;
}

/** Near enough to paint — the observer's answer once it has given one. */
function isNear(card: Card): boolean {
  return card.reported ? card.near : withinViewport(card, PREPAINT_MARGIN);
}

/** On screen, for deciding what may animate. */
function isOnScreen(card: Card): boolean {
  return card.screenReported ? card.visible : withinViewport(card, 0);
}

/** A page of looping idle animations is exactly what this preference is
 * about, so those cards paint one frame and hold it. */
function motionAllowed(): boolean {
  return !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * Put the chosen clip on the skeleton, once.
 *
 * playAnimation only starts an action — nothing reaches the bones until a
 * mixer update runs. Without this a reduced-motion card held the bind pose
 * instead of an idle frame, and picking a different clip changed nothing
 * on screen. Long enough to carry playAnimation's crossfade past its end,
 * or the new clip would be sampled at zero weight and show the old one.
 */
function sampleOnce(visual: CharacterVisual): void {
  visual.mixer.update(0.25);
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
  /**
   * What this card allocated and must give back: its turf, and the road's
   * procedural pile when it has one. Everything else in `group` is a clone
   * sharing geometry and materials with the game's template caches, which
   * a card must not free.
   */
  owned: THREE.Object3D[];
  visual?: CharacterVisual;
}

interface Card extends CardSpec {
  ctx: CanvasRenderingContext2D;
  content: CardContent | null;
  yaw: number;
  /** Close enough to be worth painting before it is scrolled to. */
  near: boolean;
  /** Whether the prepaint observer has ever reported on this card. */
  reported: boolean;
  /** Whether the on-screen observer has. */
  screenReported: boolean;
  /** Actually on screen. Animation follows this one — a card half a screen
   * below the fold should not be spending a phone's GPU. */
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
  onScreen: IntersectionObserver;
  cards: Set<Card>;
  raf: number;
  lastAnimPaint: number;
  onVisibility: () => void;
  onResize: () => void;
  resizeTimer: number;
}

let hub: Hub | null = null;
/** A context we asked for and were refused — every card falls back. */
let hubFailed = false;

// The loaders coalesce concurrent calls themselves and drop their memo on
// failure, so these only translate *this* attempt's rejection into a
// fallback. Memoising the result here as well would cache that `false`
// forever and leave one flaky fetch disabling previews for the rest of the
// page's life, retry or no retry.
function ensureBuildingAssets(): Promise<boolean> {
  return loadGlbAssets().catch(() => false);
}

function ensureUnitAssets(): Promise<boolean> {
  return loadCharacterAssets().catch(() => false);
}

function getHub(): Hub | null {
  // The flag first: after a lost context `hub` may still be non-null while
  // it is unusable, and handing it back would let a fresh card render into
  // a dead context and restart the loop.
  if (hubFailed) return null;
  if (hub) return hub;
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
  // Two observers, because "paint it before the reader arrives" and
  // "animate it while they are looking" are different distances.
  const io = new IntersectionObserver(
    (entries) => {
      if (!hub) return;
      for (const e of entries) {
        for (const card of hub.cards) {
          if (card.stage !== e.target) continue;
          card.near = e.isIntersecting;
          card.reported = true;
          if (card.near && card.content && !card.painted) paint(card);
        }
      }
    },
    // Paint just before a card scrolls in, so the reader never sees it land.
    { rootMargin: '400px 0px' },
  );
  const onScreen = new IntersectionObserver((entries) => {
    if (!hub) return;
    for (const e of entries) {
      for (const card of hub.cards) {
        if (card.stage !== e.target) continue;
        card.visible = e.isIntersecting;
        card.screenReported = true;
      }
    }
    wakeAnimLoop();
  });
  hub = {
    renderer,
    scene,
    camera: new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 60),
    holder,
    io,
    onScreen,
    cards: new Set(),
    raf: 0,
    lastAnimPaint: 0,
    onVisibility: () => wakeAnimLoop(),
    // A card is blitted at the size it had when it was painted, so a
    // window resize or a turned phone leaves a stretched bitmap behind a
    // camera framed for the old aspect. Static cards have no loop to
    // correct them, so they are repainted here.
    onResize: () => {
      const h = hub;
      if (!h) return;
      clearTimeout(h.resizeTimer);
      h.resizeTimer = window.setTimeout(() => {
        if (!hub) return;
        for (const card of hub.cards) if (card.painted && isNear(card)) paint(card);
      }, 200);
    },
    resizeTimer: 0,
  };
  document.addEventListener('visibilitychange', hub.onVisibility);
  window.addEventListener('resize', hub.onResize);
  // A context can go away long after it was handed over — the GPU resets,
  // or the browser reclaims one because another page wanted it. Without
  // this the cards keep their last blit and the loop keeps rendering into
  // nothing, which is worse than the fallback they were promised.
  renderer.domElement.addEventListener('webglcontextlost', onContextLost);
  return hub;
}

/**
 * The context is gone: stop drawing and let every card show its tile.
 *
 * A full teardown rather than a flag, because a half-dead hub is worse
 * than none — every path out of here has to agree that there is nothing to
 * draw into. The GPU resources are already gone, so nothing is disposed;
 * `hubFailed` stays set until the reader leaves the guide, which is when a
 * fresh context becomes worth trying again.
 */
function onContextLost(event: Event): void {
  event.preventDefault();
  const h = hub;
  if (!h) return;
  hubFailed = true;
  hub = null;
  if (h.raf !== 0) cancelAnimationFrame(h.raf);
  h.io.disconnect();
  h.onScreen.disconnect();
  clearTimeout(h.resizeTimer);
  h.renderer.domElement.removeEventListener('webglcontextlost', onContextLost);
  document.removeEventListener('visibilitychange', h.onVisibility);
  window.removeEventListener('resize', h.onResize);
  for (const card of h.cards) {
    card.cleanupDrag?.();
    card.cleanupDrag = undefined;
    card.content = null;
    card.painted = false;
    card.onState('fallback');
  }
  h.cards.clear();
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
  return [...h.cards].filter((c) => c.animated && isOnScreen(c) && c.content?.visual);
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
    const id = buildingFromKey(card.id);
    if (id === undefined) return null;
    // Owner picks the team-colour slot; the camp belongs to the raiders,
    // and BANDIT is the one owner factionTint leaves untinted.
    const owner = RAIDER_BUILDINGS.includes(id) ? BANDIT : 0;
    const cloned = makeGlbBuilding(id, owner);
    // The road is the one type without a model of its own; its site pile
    // stands in, exactly as it does in the world — and unlike every other
    // model here it is built fresh rather than cloned from a cache, so it
    // is this card's to give back.
    const pile = cloned === null && BUILDING_DEFS[id].isRoad ? makeRoadPile() : null;
    const model = cloned ?? pile;
    if (!model) return null;
    const def = BUILDING_DEFS[id];
    const plateR = Math.max(def.w, def.h) * 0.95 + 0.5;
    const group = new THREE.Group();
    const plate = makePlate(plateR, Math.floor(card.seed * 997));
    group.add(plate, model);
    const owned: THREE.Object3D[] = pile ? [plate, pile] : [plate];
    return { group, framing: frameFor(model, plateR), owned };
  }
  const unit = unitFromKey(card.id);
  if (unit === undefined) return null;
  const made = makeCharacter(unit, 0, RAIDER_UNITS.includes(unit) ? BANDIT : 0);
  if (!made) return null;
  const plateR = 0.62;
  const group = new THREE.Group();
  const plate = makePlate(plateR, Math.floor(card.seed * 997));
  group.add(plate, made.group);
  playAnimation(made.visual, AnimKey.idle, card.seed % 1);
  // Sampled here so the very first paint shows an idle pose rather than
  // the bind pose — the animation loop may never run at all.
  sampleOnce(made.visual);
  return { group, framing: frameFor(made.group, plateR), owned: [plate], visual: made.visual };
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
  for (const owned of content.owned) {
    owned.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      o.geometry.dispose();
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
        // Not m.map: the ground speckle is one canvas shared by every plate.
        m.dispose();
      }
    });
  }
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
    near: false,
    reported: false,
    visible: false,
    screenReported: false,
    painted: false,
    w: 0,
    h: 0,
  };
  h.cards.add(card);
  h.io.observe(card.stage);
  h.onScreen.observe(card.stage);

  const assets = card.kind === 'building' ? ensureBuildingAssets() : ensureUnitAssets();
  void assets.then((ok) => {
    // The card may be gone (page turned), the hub torn down (left /docs),
    // or the context lost while the models were in flight.
    if (hubFailed || !hub || !hub.cards.has(card)) return;
    card.content = ok ? buildContent(card) : null;
    if (!card.content) {
      card.cleanupDrag?.();
      card.cleanupDrag = undefined;
      card.onState('fallback');
      return;
    }
    card.onState('ready');
    // Drag is only meaningful once there is something to turn: a fallback
    // tile advertising a grab (and swallowing horizontal gestures with
    // preventDefault) is a promise the card cannot keep.
    if (card.interactive) attachDrag(card);
    if (isNear(card)) paint(card);
    wakeAnimLoop();
  });

  return {
    setAnim(key: AnimKey): void {
      const visual = card.content?.visual;
      if (!visual) return;
      // The seed desyncs looping clips, but death plays once (LoopOnce in
      // characters.ts) — started part-way through, a card would show the
      // last third of a fall. sceneSync makes the same exception.
      playAnimation(visual, key, key === AnimKey.death ? 0 : card.seed);
      // Put the new clip on the skeleton before painting: under reduced
      // motion no loop will do it, so the picker would change nothing.
      sampleOnce(visual);
      if (isNear(card)) paint(card);
      wakeAnimLoop();
    },
    dispose(): void {
      const live = hub;
      card.cleanupDrag?.();
      if (!live) return;
      live.io.unobserve(card.stage);
      live.onScreen.unobserve(card.stage);
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
  // A new visit deserves a new context: whatever killed the last one is
  // usually long over by the time anyone opens the guide again.
  hubFailed = false;
  if (!h) return;
  hub = null;
  if (h.raf !== 0) cancelAnimationFrame(h.raf);
  clearTimeout(h.resizeTimer);
  document.removeEventListener('visibilitychange', h.onVisibility);
  window.removeEventListener('resize', h.onResize);
  h.io.disconnect();
  h.onScreen.disconnect();
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
