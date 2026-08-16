/**
 * The audio facade: what the rest of the game imports. Everything here is
 * plain module state behind plain functions, pushToast-style.
 *
 * Invariant callers lean on: **this module constructs nothing at module
 * scope.** No AudioContext, no listeners, no storage reads at import
 * time. That is what makes it safe to import from ui/store.ts (which any
 * screen may load), and what keeps paths that never wire audio — the
 * wardrobe, the tests — free of it entirely. Until initAudio() runs,
 * every function is a cheap no-op.
 *
 * The context itself is created lazily on the first user gesture, because
 * autoplay policy starts it suspended and this game can boot straight
 * into a match with no gesture at all (?seed=…, a bookmark, a reload).
 * The single-player start menu can't hand us a gesture either — its
 * launch is a full page navigation, so anything unlocked there dies with
 * the page. Hence one-shot capture-phase listeners on window: capture, so
 * no stopPropagation deeper in the input stack can eat the unlock; once,
 * so they cost nothing after the first click. Before unlock, play() must
 * queue nothing — a backlog dumped into the speakers on the first click
 * would be worse than the silence it replaces.
 */

import { type CueId, CUES } from './cues';
import { MixerGraph } from './mixerGraph';
import { MIN_AUDIBLE, type Rect, type Spatial, spatialize } from './pan';
import { loadSamples } from './samples';
import { renderCue } from './synth';
import { CueScheduler, type PlayRequest } from './voices';

let graph: MixerGraph | null = null;
let scheduler: CueScheduler | null = null;
const buffers = new Map<CueId, AudioBuffer>();
/** Decoded sample files, kept apart from the synth renders so a sample
 * always wins the lookup and a late-arriving render can never shadow it. */
const sampleBuffers = new Map<CueId, AudioBuffer>();

let initialized = false;
let volumeGain = 1;
let muted = false;
let paused = false;
let hiddenNow = false;

const view: Rect = { minX: 0, maxX: 0, minZ: 0, maxZ: 0 };
let hasView = false;
const spatialScratch: Spatial = { pan: 0, gain: 0, audible: false };
const playPool: PlayRequest[] = [];
let fallbackFlush = 0;

/**
 * A match drives flushes from its frame loop; the menu has no loop, and a
 * request left queued there would sit until the next match dumped it.
 * So every request arms a short one-shot timer — on screens with a loop
 * the rAF flush lands first and the timer finds an empty queue.
 */
function armFallbackFlush(): void {
  if (fallbackFlush !== 0) return;
  fallbackFlush = window.setTimeout(() => {
    fallbackFlush = 0;
    audioFrame(performance.now());
  }, 32);
}

/**
 * Arm the system: remember the starting volume/mute (the UI's signals own
 * those; this module only applies them) and lie in wait for the first
 * gesture. Idempotent, called once from boot().
 */
export function initAudio(initial: { gain: number; muted: boolean }): void {
  volumeGain = initial.gain;
  muted = initial.muted;
  if (initialized) return;
  initialized = true;
  const opts = { once: true, capture: true, passive: true } as const;
  window.addEventListener('pointerdown', unlockAudio, opts);
  window.addEventListener('keydown', unlockAudio, opts);
  window.addEventListener('touchend', unlockAudio, opts);
}

/**
 * Create and resume the context. Safe to call from any real gesture;
 * every call after the first is a cheap resume-or-nothing.
 */
export function unlockAudio(): void {
  if (!initialized) return;
  if (!graph) {
    const ctx = new AudioContext();
    graph = new MixerGraph(ctx);
    graph.setVolume(volumeGain);
    graph.setMuted(muted);
    graph.setPaused(paused);
    scheduler = new CueScheduler(CUES);
    // Bake every recipe into a buffer, in the background. Rendering is
    // offline and fast, but the first click racing it may stay silent —
    // that beats blocking anything on audio.
    for (const id of Object.keys(CUES) as CueId[]) {
      void renderCue(CUES[id], ctx.sampleRate).then(
        (buffer) => buffers.set(id, buffer),
        () => undefined, // a failed render is just a cue that stays silent
      );
    }
    // Vendored recordings, where the catalogue names them — upgrading
    // cues from synth to sample as they decode, never blocking anything.
    void loadSamples(ctx, sampleBuffers);
    // iOS parks the context on 'interrupted' after a phone call or Siri
    // and never resumes it unprompted; any state droop while we're
    // visible gets nudged back. (While hidden, suspended is correct.)
    ctx.onstatechange = () => {
      if (!hiddenNow && ctx.state === 'suspended') void ctx.resume();
    };
  }
  if (!hiddenNow) void graph.ctx.resume();
}

/** A UI cue: centred, full design gain, no spatialization. */
export function play(cue: CueId): void {
  if (!scheduler || muted) return;
  scheduler.request(cue, 0, 1);
  armFallbackFlush();
}

/**
 * A world cue at world (x, z). Primitives only — this is called from
 * inside render loops that pool everything, and an options object per
 * request would undo that work. `delaySec` schedules the voice ahead
 * (loop-event percussion lands its impact mid-clip, not at the wrap).
 */
export function playAt(cue: CueId, x: number, z: number, gainScale = 1, delaySec = 0): void {
  if (!scheduler || muted || !hasView) return;
  const s = spatialize(x, z, view, spatialScratch);
  if (!s.audible) return;
  const gain = s.gain * gainScale;
  if (gain <= MIN_AUDIBLE) return;
  scheduler.request(cue, s.pan, gain, delaySec);
  armFallbackFlush();
}

/** The frame's view rect (world XZ) — pan and distance both read from it. */
export function setAudioView(b: Rect): void {
  view.minX = b.minX;
  view.maxX = b.maxX;
  view.minZ = b.minZ;
  view.maxZ = b.maxZ;
  hasView = true;
}

/** Flush the frame's requests into actual voices. Call once per rAF. */
export function audioFrame(now: number): void {
  if (!scheduler || !graph) return;
  const n = scheduler.flush(now, graph.activeVoices, playPool);
  for (let i = 0; i < n; i++) {
    const req = playPool[i]!;
    const cue = req.cue as CueId;
    const buffer = sampleBuffers.get(cue) ?? buffers.get(cue);
    if (buffer) graph.play(buffer, CUES[cue], req);
  }
}

/** speed() === 0, mirrored: the world holds its breath, the UI stays live. */
export function setAudioPaused(p: boolean): void {
  if (paused === p) return;
  paused = p;
  graph?.setPaused(p);
}

/**
 * Page hidden/shown, fed by HiddenSync. Suspending for real matters: a
 * live context keeps the device's audio hardware awake — the same battery
 * argument the sim worker's own hidden-freeze makes.
 */
export function setAudioHidden(h: boolean): void {
  if (hiddenNow === h) return;
  hiddenNow = h;
  if (!graph) return;
  if (h) void graph.ctx.suspend();
  else void graph.ctx.resume();
}

/** Master gain (already perceptual — callers convert via volumeToGain). */
export function setAudioVolume(gain: number): void {
  volumeGain = gain;
  graph?.setVolume(gain);
}

export function setAudioMuted(m: boolean): void {
  muted = m;
  graph?.setMuted(m);
}
