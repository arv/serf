/**
 * The cue catalogue: every sound the game can make, as data.
 *
 * Procedural-first, the same bargain the renderer strikes with its models:
 * every cue carries a synth recipe that needs zero asset bytes, and a cue
 * *may* later name a sample file that replaces the recipe at playback.
 * Call sites know only `CueId`s, so swapping a synthesized clang for a
 * recorded one is a one-line change here — no call site, no mixer, no
 * scheduler involved. A cue with no synth would be a cue that can go
 * silent when its file is missing, so the recipe is mandatory
 * (cues.test.ts holds that line).
 *
 * Pure data — nothing in this file may touch Web Audio, three, or the DOM,
 * so the catalogue's invariants are testable under vitest's node env
 * (isolation.lint.test.ts makes the import ban executable).
 */

export type BusId = 'ui' | 'combat' | 'work' | 'world' | 'ambient' | 'music';

/** Oscillator shapes, named locally so this module needs no DOM types. */
export type Wave = 'sine' | 'square' | 'sawtooth' | 'triangle';

/**
 * One layer of a recipe: a tone or a filtered noise burst. Times in
 * seconds, frequencies in Hz. `freqEnd` glides exponentially over the
 * layer's life — a falling glide reads as dying, a sweep as a swing.
 */
export interface ToneLayer {
  kind: 'tone';
  wave: Wave;
  freq: number;
  freqEnd?: number;
  gain: number;
  /** Seconds of linear rise before the decay starts. Default: instant. */
  attack?: number;
  /** Exponential-ish decay to silence, in seconds. */
  decay: number;
  /** Offset from the cue's start. Default 0. */
  delay?: number;
}

export interface NoiseLayer {
  kind: 'noise';
  filter: 'lowpass' | 'bandpass' | 'highpass';
  freq: number;
  freqEnd?: number;
  q?: number;
  gain: number;
  attack?: number;
  decay: number;
  delay?: number;
}

export type SynthLayer = ToneLayer | NoiseLayer;

export interface CueDef {
  bus: BusId;
  /** Base loudness, 0..1 — the design mix, before spatial gain. */
  gain: number;
  /** Re-trigger window: inside it, repeats fold into the running voice. */
  cooldownMs: number;
  /** Higher survives the voice caps. Ties broken by loudness. */
  priority: number;
  /** Cap on the collapsed-crowd gain multiple (default in voices.ts). */
  collapseCeiling?: number;
  /** ± playbackRate spread so a crowd of one cue isn't a phaser. */
  pitchJitter?: number;
  layers: SynthLayer[];
  /**
   * A path under /audio/ whose decoded buffer replaces the rendered
   * recipe at play time (samples.ts). The files are Kenney CC0 takes,
   * transcoded to mono AAC because Safari's decodeAudioData refuses Ogg
   * Vorbis; the manifest test keeps the path shape honest.
   */
  sample?: string;
}

const tone = (l: Omit<ToneLayer, 'kind'>): ToneLayer => ({ kind: 'tone', ...l });
const noise = (l: Omit<NoiseLayer, 'kind'>): NoiseLayer => ({ kind: 'noise', ...l });

/**
 * The catalogue. UI cues are wired now; the world cues ship here as the
 * reviewed spec and get their hook-ups when the render loops learn to ask
 * (loops — mill grind, well creak — wait for a loop player and are
 * deliberately absent).
 */
export const CUES = {
  // ---- ui ---------------------------------------------------------------
  uiClick: {
    bus: 'ui',
    gain: 0.35,
    cooldownMs: 30,
    priority: 4,
    layers: [tone({ wave: 'square', freq: 900, gain: 0.5, decay: 0.03 })],
    sample: '/audio/uiClick.m4a',
  },
  uiOpen: {
    bus: 'ui',
    gain: 0.3,
    cooldownMs: 60,
    priority: 4,
    layers: [
      tone({ wave: 'triangle', freq: 520, gain: 0.5, decay: 0.06 }),
      tone({ wave: 'triangle', freq: 660, gain: 0.5, decay: 0.08, delay: 0.05 }),
    ],
    sample: '/audio/uiOpen.m4a',
  },
  uiClose: {
    bus: 'ui',
    gain: 0.3,
    cooldownMs: 60,
    priority: 4,
    layers: [
      tone({ wave: 'triangle', freq: 660, gain: 0.5, decay: 0.06 }),
      tone({ wave: 'triangle', freq: 520, gain: 0.5, decay: 0.08, delay: 0.05 }),
    ],
    sample: '/audio/uiClose.m4a',
  },
  uiSelect: {
    bus: 'ui',
    gain: 0.3,
    cooldownMs: 50,
    priority: 4,
    layers: [tone({ wave: 'triangle', freq: 880, gain: 0.5, decay: 0.06 })],
    sample: '/audio/uiSelect.m4a',
  },
  uiOrder: {
    bus: 'ui',
    gain: 0.35,
    cooldownMs: 60,
    priority: 4,
    layers: [
      noise({ filter: 'bandpass', freq: 1200, q: 2, gain: 0.4, decay: 0.05 }),
      tone({ wave: 'sine', freq: 220, gain: 0.5, decay: 0.05 }),
    ],
    sample: '/audio/uiOrder.m4a',
  },
  uiPlace: {
    bus: 'ui',
    gain: 0.5,
    cooldownMs: 80,
    priority: 4,
    layers: [
      tone({ wave: 'sine', freq: 180, freqEnd: 120, gain: 0.6, decay: 0.09 }),
      noise({ filter: 'lowpass', freq: 400, gain: 0.4, decay: 0.08 }),
    ],
    sample: '/audio/uiPlace.m4a',
  },
  uiRefused: {
    bus: 'ui',
    gain: 0.4,
    cooldownMs: 150,
    priority: 4,
    layers: [
      tone({ wave: 'square', freq: 330, gain: 0.35, decay: 0.09 }),
      tone({ wave: 'square', freq: 311, gain: 0.35, decay: 0.12, delay: 0.1 }),
    ],
    sample: '/audio/uiRefused.m4a',
  },
  uiToast: {
    bus: 'ui',
    gain: 0.25,
    cooldownMs: 200,
    priority: 3,
    layers: [noise({ filter: 'highpass', freq: 3000, gain: 0.3, decay: 0.1 })],
    sample: '/audio/uiToast.m4a',
  },
  uiCoin: {
    bus: 'ui',
    gain: 0.35,
    cooldownMs: 90,
    priority: 4,
    layers: [
      tone({ wave: 'triangle', freq: 2100, gain: 0.3, decay: 0.12 }),
      tone({ wave: 'triangle', freq: 2700, gain: 0.25, decay: 0.14, delay: 0.03 }),
      tone({ wave: 'triangle', freq: 3300, gain: 0.2, decay: 0.16, delay: 0.06 }),
    ],
    sample: '/audio/uiCoin.m4a',
  },

  // ---- work -------------------------------------------------------------
  chop: {
    bus: 'work',
    gain: 0.5,
    cooldownMs: 90,
    priority: 2,
    pitchJitter: 0.06,
    layers: [
      noise({ filter: 'bandpass', freq: 900, q: 1.5, gain: 0.55, decay: 0.07 }),
      tone({ wave: 'sine', freq: 120, gain: 0.4, decay: 0.05 }),
    ],
    sample: '/audio/chop.m4a',
  },
  pickaxe: {
    bus: 'work',
    gain: 0.5,
    cooldownMs: 90,
    priority: 2,
    pitchJitter: 0.06,
    layers: [
      noise({ filter: 'bandpass', freq: 2500, q: 3, gain: 0.45, decay: 0.05 }),
      tone({ wave: 'triangle', freq: 300, gain: 0.35, decay: 0.12 }),
    ],
    sample: '/audio/pickaxe.m4a',
  },
  hammer: {
    bus: 'work',
    gain: 0.5,
    cooldownMs: 90,
    priority: 2,
    pitchJitter: 0.06,
    layers: [
      noise({ filter: 'bandpass', freq: 600, q: 1.5, gain: 0.5, decay: 0.06 }),
      tone({ wave: 'sine', freq: 150, gain: 0.4, decay: 0.05 }),
    ],
    sample: '/audio/hammer.m4a',
  },
  footstep: {
    bus: 'work',
    gain: 0.18,
    cooldownMs: 45,
    priority: 1,
    pitchJitter: 0.1,
    layers: [noise({ filter: 'lowpass', freq: 500, gain: 0.35, decay: 0.04 })],
    sample: '/audio/footstep.m4a',
  },

  // ---- combat -----------------------------------------------------------
  swordSwing: {
    bus: 'combat',
    gain: 0.45,
    cooldownMs: 60,
    priority: 3,
    pitchJitter: 0.08,
    layers: [
      noise({ filter: 'bandpass', freq: 400, freqEnd: 3000, q: 1.2, gain: 0.5, decay: 0.12 }),
    ],
    sample: '/audio/swordSwing.m4a',
  },
  bowRelease: {
    bus: 'combat',
    gain: 0.4,
    cooldownMs: 60,
    priority: 3,
    pitchJitter: 0.08,
    layers: [
      noise({ filter: 'bandpass', freq: 1800, q: 4, gain: 0.45, decay: 0.05 }),
      tone({ wave: 'sine', freq: 90, gain: 0.3, decay: 0.03 }),
    ],
  },
  unitDeath: {
    bus: 'combat',
    gain: 0.5,
    cooldownMs: 120,
    priority: 4,
    pitchJitter: 0.08,
    layers: [
      tone({ wave: 'sawtooth', freq: 220, freqEnd: 70, gain: 0.35, decay: 0.45 }),
      noise({ filter: 'lowpass', freq: 300, gain: 0.4, decay: 0.12, delay: 0.28 }),
    ],
    sample: '/audio/unitDeath.m4a',
  },
  buildingHit: {
    bus: 'combat',
    gain: 0.55,
    cooldownMs: 150,
    priority: 4,
    layers: [
      noise({ filter: 'lowpass', freq: 250, gain: 0.55, decay: 0.3 }),
      tone({ wave: 'sine', freq: 60, gain: 0.5, decay: 0.25 }),
    ],
    sample: '/audio/buildingHit.m4a',
  },

  // ---- world ------------------------------------------------------------
  raidHorn: {
    bus: 'world',
    gain: 0.6,
    cooldownMs: 2000,
    priority: 5,
    layers: [
      tone({ wave: 'sawtooth', freq: 155, gain: 0.3, attack: 0.5, decay: 0.9 }),
      tone({ wave: 'sawtooth', freq: 156.5, gain: 0.25, attack: 0.5, decay: 0.9 }),
      tone({ wave: 'sawtooth', freq: 233, gain: 0.2, attack: 0.6, decay: 0.8, delay: 0.1 }),
    ],
  },
  buildingComplete: {
    bus: 'world',
    gain: 0.45,
    cooldownMs: 250,
    priority: 4,
    layers: [
      tone({ wave: 'triangle', freq: 523, gain: 0.35, decay: 0.25 }),
      tone({ wave: 'triangle', freq: 659, gain: 0.35, decay: 0.28, delay: 0.12 }),
      tone({ wave: 'triangle', freq: 784, gain: 0.35, decay: 0.4, delay: 0.24 }),
      noise({ filter: 'lowpass', freq: 350, gain: 0.25, decay: 0.1 }),
    ],
    sample: '/audio/buildingComplete.m4a',
  },
  buildingCollapse: {
    bus: 'world',
    gain: 0.6,
    cooldownMs: 300,
    priority: 5,
    layers: [
      noise({ filter: 'lowpass', freq: 400, freqEnd: 80, gain: 0.55, attack: 0.05, decay: 1.0 }),
      tone({ wave: 'sine', freq: 50, gain: 0.5, attack: 0.05, decay: 0.8 }),
    ],
    sample: '/audio/buildingCollapse.m4a',
  },
  objectiveDone: {
    bus: 'world',
    gain: 0.45,
    cooldownMs: 400,
    priority: 5,
    layers: [
      tone({ wave: 'triangle', freq: 659, gain: 0.3, decay: 0.22 }),
      tone({ wave: 'triangle', freq: 784, gain: 0.3, decay: 0.24, delay: 0.1 }),
      tone({ wave: 'triangle', freq: 988, gain: 0.3, decay: 0.26, delay: 0.2 }),
      tone({ wave: 'triangle', freq: 1319, gain: 0.3, decay: 0.45, delay: 0.3 }),
    ],
    sample: '/audio/objectiveDone.m4a',
  },
  distantBell: {
    bus: 'world',
    gain: 0.35,
    cooldownMs: 1000,
    priority: 4,
    layers: [
      // Two inharmonic partials read as bronze; long and quiet reads as far.
      tone({ wave: 'sine', freq: 440, gain: 0.35, decay: 1.2 }),
      tone({ wave: 'sine', freq: 587, gain: 0.2, decay: 0.9 }),
    ],
    sample: '/audio/distantBell.m4a',
  },
  victory: {
    bus: 'music',
    gain: 0.55,
    cooldownMs: 5000,
    priority: 6,
    layers: [
      tone({ wave: 'triangle', freq: 523, gain: 0.3, decay: 0.5 }),
      tone({ wave: 'triangle', freq: 659, gain: 0.3, decay: 0.55, delay: 0.15 }),
      tone({ wave: 'triangle', freq: 784, gain: 0.3, decay: 0.6, delay: 0.3 }),
      tone({ wave: 'triangle', freq: 1046, gain: 0.35, decay: 1.1, delay: 0.45 }),
      tone({ wave: 'sine', freq: 131, gain: 0.3, attack: 0.05, decay: 1.4 }),
    ],
    sample: '/audio/victory.m4a',
  },
  defeat: {
    bus: 'music',
    gain: 0.5,
    cooldownMs: 5000,
    priority: 6,
    layers: [
      tone({ wave: 'sawtooth', freq: 392, gain: 0.18, decay: 0.7 }),
      tone({ wave: 'sawtooth', freq: 311, gain: 0.18, decay: 0.8, delay: 0.35 }),
      tone({ wave: 'sawtooth', freq: 262, gain: 0.2, decay: 1.4, delay: 0.7 }),
      tone({ wave: 'sine', freq: 65, gain: 0.3, attack: 0.1, decay: 1.6, delay: 0.7 }),
    ],
    sample: '/audio/defeat.m4a',
  },
} as const satisfies Record<string, CueDef>;

export type CueId = keyof typeof CUES;
