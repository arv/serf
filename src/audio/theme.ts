/**
 * The menu's theme: one looping track, streamed.
 *
 * Not a cue. audio.ts decodes each one whole into an AudioBuffer, and
 * this track is 109s — about 42MB of PCM — to play one thing at a time
 * that needs no scheduling or panning. A media element streams it.
 *
 * Same rule as audio.ts: nothing is constructed at module scope, so
 * importing this from a screen that never plays it costs nothing.
 */

import {clamp} from '../shared/math';

const SRC = '/audio/menuTheme.mp3';

/** Music sits under the effects; applied on top of the UI's volume. */
const TRIM = 0.42;

/** Long enough that leaving for a match reads as walking out. */
const FADE_MS = 900;

let el: HTMLAudioElement | null = null;
/** What the UI asked for, 0..1, mute already folded in. */
let uiGain = 0;
/** Whether the menu currently wants the theme running. */
let wanted = false;
/** Where the fade has actually got to, which is what the element wears. */
let level = 0;
let raf = 0;
let lastFrame = 0;
let hidden = false;
/**
 * The retry a refused play() is holding, so it can be called off. Null
 * whenever nothing is armed, which is also the "already waiting" check.
 */
let waiting: (() => void) | null = null;

function target(): number {
  return wanted && !hidden ? uiGain * TRIM : 0;
}

/** Ease toward the target, parking only once a fade to silence lands. */
function fade(now: number): void {
  raf = 0;
  const a = el;
  if (a === null) return;
  // A frame delta, not a fixed step: a throttled tab would stretch it.
  const dt = lastFrame === 0 ? 16 : Math.min(64, now - lastFrame);
  lastFrame = now;
  const to = target();
  const by = dt / FADE_MS;
  level = level < to ? Math.min(to, level + by) : Math.max(to, level - by);
  a.volume = clamp(level, 0, 1);
  if (level !== to) {
    raf = requestAnimationFrame(fade);
    return;
  }
  lastFrame = 0;
  if (to === 0) a.pause();
}

function settle(): void {
  const a = el;
  if (a === null) return;
  // A fade to zero parked it, so raising the target must restart it too:
  // unmuting used to climb the volume back up on a paused element.
  if (target() > 0 && a.paused) playOrWait(a);
  if (raf !== 0) return;
  lastFrame = 0;
  raf = requestAnimationFrame(fade);
}

/**
 * Disarm the retry. Every exit runs this: a gesture that never comes must
 * not leave two window listeners on the page for as long as it lives.
 */
function clearPending(): void {
  if (waiting === null) return;
  window.removeEventListener('pointerdown', waiting, true);
  window.removeEventListener('keydown', waiting, true);
  waiting = null;
}

/**
 * A cold visit's first play() is expected to fail — no gesture has paid
 * for it yet — so retry on the next one. Capture-phase so nothing deeper
 * eats it, and both listeners come off together.
 */
function playOrWait(a: HTMLAudioElement): void {
  void a.play().catch(() => {
    // play() settles a microtask later, so the menu may have closed in the
    // meantime — a theme nobody wants must not sit on the next click.
    if (!wanted || waiting !== null) return;
    const go = (): void => {
      clearPending();
      if (wanted && el !== null) void el.play().catch(() => undefined);
    };
    waiting = go;
    window.addEventListener('pointerdown', go, true);
    window.addEventListener('keydown', go, true);
  });
}

/** Start (or resume) the theme, fading up from wherever it is. */
export function startTheme(): void {
  wanted = true;
  if (el === null) {
    el = new Audio();
    el.loop = true;
    el.preload = 'auto';
    // Or the first frame lands at full volume before the first rAF.
    el.volume = 0;
    el.src = SRC;
    // Cosmetic: a theme that will not load leaves a menu that is quiet.
    el.addEventListener('error', () => undefined);
  }
  playOrWait(el);
  settle();
}

/** Fade the theme out and park it. Safe to call when it never started. */
export function stopTheme(): void {
  wanted = false;
  clearPending();
  if (el === null) return;
  settle();
}

/** The UI's volume, mute already applied. */
export function setThemeGain(gain: number): void {
  uiGain = clamp(gain, 0, 1);
  settle();
}

/** A hidden tab sings to nobody. Resumes only if the menu still wants it. */
export function setThemeHidden(h: boolean): void {
  if (hidden === h) return;
  hidden = h;
  if (!h && wanted && el !== null) playOrWait(el);
  settle();
}

/** Give the element up entirely; the next startTheme builds a fresh one. */
export function releaseTheme(): void {
  wanted = false;
  clearPending();
  if (raf !== 0) cancelAnimationFrame(raf);
  raf = 0;
  lastFrame = 0;
  level = 0;
  if (el !== null) {
    el.pause();
    // Rather than leave it buffering a track nothing will play.
    el.removeAttribute('src');
    el.load();
    el = null;
  }
}
