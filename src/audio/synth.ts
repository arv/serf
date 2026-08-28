/**
 * Renders a cue's recipe into an AudioBuffer, once, offline.
 *
 * Deliberately not a live node graph per playback: rendering through an
 * OfflineAudioContext at startup means every voice at play time is a
 * single AudioBufferSourceNode — byte-for-byte the same path a decoded
 * sample file takes. That identity is the whole procedural-first bargain:
 * when a real recording replaces a recipe (cues.ts's `sample` seam), the
 * mixer, the scheduler and every call site are provably indifferent.
 * It also makes voices cheap enough that the caps in voices.ts are a
 * design choice rather than a performance necessity.
 *
 * Impure and untestable under the node test env by nature; everything
 * with decisions in it lives in cues.ts (the recipes) and noise.ts (the
 * deterministic noise table), which are covered.
 */

import type {CueDef, SynthLayer} from './cues';
import {fillNoise} from './noise';

/** Post-decay tail so exponential ramps land at silence, not a click. */
const TAIL = 0.05;
const NOISE_SECONDS = 1;
const NOISE_SEED = 1013;

function layerEnd(l: SynthLayer): number {
  return (l.delay ?? 0) + (l.attack ?? 0) + l.decay;
}

/** Shared noise source material, rendered once per sample rate. */
let noiseTable: {rate: number; data: Float32Array<ArrayBuffer>} | null = null;

function noiseFor(rate: number): Float32Array<ArrayBuffer> {
  if (!noiseTable || noiseTable.rate !== rate) {
    const data = new Float32Array(
      new ArrayBuffer(4 * Math.ceil(rate * NOISE_SECONDS)),
    );
    fillNoise(data, NOISE_SEED);
    noiseTable = {rate, data};
  }
  return noiseTable.data;
}

/**
 * Schedule one layer into an offline context. The gain envelope is a
 * linear attack (or an instant 1-sample rise) into an exponential decay —
 * exponential because that is what struck and plucked things do, and what
 * the ear reads as "a hit" rather than "a fade".
 */
function buildLayer(ctx: OfflineAudioContext, l: SynthLayer): void {
  const at = l.delay ?? 0;
  const attack = l.attack ?? 0.003;
  const end = at + attack + l.decay;

  const env = ctx.createGain();
  env.gain.setValueAtTime(0, at);
  env.gain.linearRampToValueAtTime(l.gain, at + attack);
  // exponentialRamp cannot reach 0; land near -60 dB and let the buffer end.
  env.gain.exponentialRampToValueAtTime(Math.max(l.gain * 0.001, 1e-4), end);
  env.connect(ctx.destination);

  if (l.kind === 'tone') {
    const osc = ctx.createOscillator();
    osc.type = l.wave;
    osc.frequency.setValueAtTime(l.freq, at);
    if (l.freqEnd !== undefined)
      osc.frequency.exponentialRampToValueAtTime(l.freqEnd, end);
    osc.connect(env);
    osc.start(at);
    osc.stop(end + TAIL);
    return;
  }

  const table = noiseFor(ctx.sampleRate);
  const buffer = ctx.createBuffer(1, table.length, ctx.sampleRate);
  buffer.copyToChannel(table, 0);
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.loop = true;
  const filter = ctx.createBiquadFilter();
  filter.type = l.filter;
  filter.frequency.setValueAtTime(l.freq, at);
  if (l.freqEnd !== undefined)
    filter.frequency.exponentialRampToValueAtTime(l.freqEnd, end);
  filter.Q.value = l.q ?? 1;
  src.connect(filter);
  filter.connect(env);
  src.start(at);
  src.stop(end + TAIL);
}

/** Render a recipe to a mono buffer at the live context's sample rate. */
export async function renderCue(
  def: CueDef,
  sampleRate: number,
): Promise<AudioBuffer> {
  let duration = 0;
  for (const l of def.layers) duration = Math.max(duration, layerEnd(l));
  duration += TAIL;
  const ctx = new OfflineAudioContext(
    1,
    Math.ceil(duration * sampleRate),
    sampleRate,
  );
  for (const l of def.layers) buildLayer(ctx, l);
  return ctx.startRendering();
}
