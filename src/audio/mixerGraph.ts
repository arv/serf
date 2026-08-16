/**
 * The one file that owns a live AudioContext: buses, master chain, and
 * voice playback. Kept thin on purpose — every decision about *whether*
 * and *how loud* was already made in voices.ts, where it is testable;
 * this file just wires what it is told.
 *
 *   voice gain -> voice StereoPanner -> bus gain -> master gain
 *                                    -> compressor -> destination
 *
 * The compressor is the safety net that lets the scheduler's caps be
 * approximate: a battle's worth of hits landing in the same 20 ms gets
 * squeezed, not clipped. Per-voice nodes disconnect themselves in
 * `onended` — an audio graph that only ever grows is the same leak the
 * renderer already fights with skeleton textures, wearing a different
 * hat.
 */

import type { BusId, CueDef } from './cues';
import type { PlayRequest } from './voices';

/** Fixed design mix per bus; only master is player-facing for now. */
const BUS_GAINS: Record<BusId, number> = {
  ui: 1,
  combat: 0.9,
  work: 0.8,
  world: 1,
  ambient: 0.7,
  music: 0.8,
};

/** While paused the world holds its breath but the UI stays crisp — the
 * pause menu's own clicks must not be caught in the duck. */
const PAUSE_DUCK: Partial<Record<BusId, number>> = {
  combat: 0.15,
  work: 0.15,
  ambient: 0.15,
};

const RAMP = 0.03;

export class MixerGraph {
  readonly ctx: AudioContext;
  #master: GainNode;
  #buses: Record<BusId, GainNode>;
  #volume = 1;
  #muted = false;
  #paused = false;
  #active = 0;
  /** Sounding voices by bus, so teardown can cut the world and spare the UI. */
  #live = new Map<AudioBufferSourceNode, BusId>();

  constructor(ctx: AudioContext) {
    this.ctx = ctx;
    const compressor = ctx.createDynamicsCompressor();
    compressor.threshold.value = -18;
    compressor.knee.value = 12;
    compressor.ratio.value = 6;
    compressor.attack.value = 0.003;
    compressor.release.value = 0.25;
    compressor.connect(ctx.destination);
    this.#master = ctx.createGain();
    this.#master.connect(compressor);
    const bus = (id: BusId): GainNode => {
      const g = ctx.createGain();
      g.gain.value = BUS_GAINS[id];
      g.connect(this.#master);
      return g;
    };
    this.#buses = {
      ui: bus('ui'),
      combat: bus('combat'),
      work: bus('work'),
      world: bus('world'),
      ambient: bus('ambient'),
      music: bus('music'),
    };
  }

  /** Voices still sounding — the scheduler's global cap counts these. */
  get activeVoices(): number {
    return this.#active;
  }

  /** Master gain (already perceptual, via volumeToGain). */
  setVolume(gain: number): void {
    this.#volume = gain;
    this.#applyMaster();
  }

  setMuted(muted: boolean): void {
    this.#muted = muted;
    this.#applyMaster();
  }

  setPaused(paused: boolean): void {
    if (this.#paused === paused) return;
    this.#paused = paused;
    const t = this.ctx.currentTime;
    for (const id of Object.keys(this.#buses) as BusId[]) {
      const duck = PAUSE_DUCK[id];
      if (duck === undefined) continue;
      const g = this.#buses[id].gain;
      g.cancelScheduledValues(t);
      g.setValueAtTime(g.value, t);
      g.linearRampToValueAtTime(BUS_GAINS[id] * (paused ? duck : 1), t + 0.2);
    }
  }

  #applyMaster(): void {
    // Always a ramp, never a step — a stepped gain is an audible click,
    // and mute is exactly when the player is listening for silence.
    const t = this.ctx.currentTime;
    const g = this.#master.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(this.#muted ? 0 : this.#volume, t + RAMP);
  }

  /**
   * Start one voice, `req.delay` seconds ahead when asked — the
   * loop-event percussion schedules impacts a fraction of a clip early,
   * and Web Audio keeps absolute-time appointments exactly.
   */
  play(buffer: AudioBuffer, def: CueDef, req: PlayRequest): void {
    const ctx = this.ctx;
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    const jitter = def.pitchJitter ?? 0;
    source.playbackRate.value = 1 + (req.seed * 2 - 1) * jitter;
    const gain = ctx.createGain();
    gain.gain.value = def.gain * req.gain;
    const panner = ctx.createStereoPanner();
    panner.pan.value = req.pan;
    source.connect(gain);
    gain.connect(panner);
    panner.connect(this.#buses[def.bus]);
    this.#active++;
    this.#live.set(source, def.bus);
    source.onended = () => {
      this.#active--;
      this.#live.delete(source);
      source.disconnect();
      gain.disconnect();
      panner.disconnect();
    };
    source.start(req.delay > 0 ? ctx.currentTime + req.delay : 0);
  }

  /**
   * Cut every voice the match owned. The UI bus plays on: the click that
   * quit is still sounding, and the menu it lands on has cues of its own.
   * Each stop() fires onended, which is what unhooks the nodes.
   */
  stopWorldVoices(): void {
    for (const [source, bus] of this.#live) {
      if (bus === 'ui') continue;
      try {
        source.stop();
      } catch {
        // Already ended between the frame and here: nothing to stop.
      }
    }
  }
}
