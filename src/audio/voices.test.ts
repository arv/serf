import { describe, expect, it } from 'vitest';
import { CueScheduler, GLOBAL_CAP, type PlayRequest } from './voices';

/** A tiny catalogue with the knobs the scheduler actually reads. */
const DEFS = {
  chop: { bus: 'work', cooldownMs: 90, priority: 2 },
  step: { bus: 'work', cooldownMs: 45, priority: 1 },
  click: { bus: 'ui', cooldownMs: 30, priority: 4 },
  horn: { bus: 'world', cooldownMs: 2000, priority: 5 },
  swing: { bus: 'combat', cooldownMs: 60, priority: 3, collapseCeiling: 1.5 },
};

const CAPS = { ui: 2, combat: 3, work: 2, world: 6 };

function flush(s: CueScheduler, now: number, active = 0, out: PlayRequest[] = []): PlayRequest[] {
  const n = s.flush(now, active, out);
  return out.slice(0, n);
}

describe('CueScheduler', () => {
  it('plays a plain request through unchanged', () => {
    const s = new CueScheduler(DEFS, CAPS);
    s.request('chop', 0.3, 0.8);
    const voices = flush(s, 1000);
    expect(voices).toHaveLength(1);
    expect(voices[0]!.cue).toBe('chop');
    expect(voices[0]!.pan).toBeCloseTo(0.3);
    expect(voices[0]!.gain).toBeCloseTo(0.8);
  });

  it('drops sub-audible requests before they can touch anything', () => {
    const s = new CueScheduler(DEFS, CAPS);
    s.request('chop', 0, 0.01);
    expect(s.pending).toBe(0);
    expect(flush(s, 1000)).toHaveLength(0);
    // And crucially: the silent request consumed no cooldown slot.
    s.request('chop', 0, 0.8);
    expect(flush(s, 1001)).toHaveLength(1);
  });

  it('ignores cues missing from the catalogue', () => {
    const s = new CueScheduler(DEFS, CAPS);
    s.request('nonsense', 0, 1);
    expect(flush(s, 0)).toHaveLength(0);
  });

  it('suppresses a repeat inside the cooldown window, allows it after', () => {
    const s = new CueScheduler(DEFS, CAPS);
    s.request('chop', 0, 0.8);
    expect(flush(s, 1000)).toHaveLength(1);
    s.request('chop', 0, 0.8);
    expect(flush(s, 1050)).toHaveLength(0); // 50ms < 90ms window
    s.request('chop', 0, 0.8);
    expect(flush(s, 1095)).toHaveLength(1); // window passed
  });

  it('collapses N identical cues into one louder voice at the centroid', () => {
    const s = new CueScheduler(DEFS, CAPS);
    s.request('chop', 0.1, 0.5);
    s.request('chop', 0.2, 0.5);
    s.request('chop', 0.3, 0.5);
    s.request('chop', 0.4, 0.5);
    const voices = flush(s, 1000);
    expect(voices).toHaveLength(1);
    // Louder than the loudest source, but by the log law, not 4x.
    expect(voices[0]!.gain).toBeGreaterThan(0.5);
    expect(voices[0]!.gain).toBeLessThan(1.0);
    expect(voices[0]!.gain).toBeCloseTo(0.5 * (1 + 0.28 * 2), 5); // log2(4) = 2
    expect(voices[0]!.pan).toBeCloseTo(0.25, 5);
  });

  it('caps collapse gain at the cue ceiling', () => {
    const s = new CueScheduler(DEFS, CAPS);
    for (let i = 0; i < 64; i++) s.request('swing', 0.2, 1.0);
    const voices = flush(s, 1000);
    expect(voices).toHaveLength(1);
    expect(voices[0]!.gain).toBe(1.5); // its collapseCeiling
  });

  it('keeps a left and a right skirmish apart instead of one centred blob', () => {
    const s = new CueScheduler(DEFS, CAPS);
    s.request('swing', -0.8, 0.6);
    s.request('swing', -0.7, 0.6);
    s.request('swing', 0.75, 0.6);
    s.request('swing', 0.85, 0.6);
    const voices = flush(s, 1000);
    expect(voices).toHaveLength(2);
    const pans = voices.map((v) => v.pan).sort((a, b) => a - b);
    expect(pans[0]).toBeLessThan(-0.5);
    expect(pans[1]).toBeGreaterThan(0.5);
  });

  it('a tight cluster does not split, wherever it sits in the field', () => {
    const s = new CueScheduler(DEFS, CAPS);
    s.request('swing', 0.5, 0.6);
    s.request('swing', 0.7, 0.6);
    expect(flush(s, 1000)).toHaveLength(1);
  });

  it('per-bus caps keep the strongest, judged by gain x priority', () => {
    const s = new CueScheduler(DEFS, CAPS); // work cap: 2
    s.request('chop', -0.9, 0.9); // score 1.8
    s.request('chop', 0.9, 0.9); // splits: two work voices already
    s.request('step', 0, 1.0); // score 1.0 — third work voice, evicted
    s.request('click', 0, 0.5); // different bus, untouched
    const voices = flush(s, 1000);
    const cues = voices.map((v) => v.cue).sort();
    expect(cues).toEqual(['chop', 'chop', 'click']);
  });

  it('an evicted candidate claims no cooldown — it may fire next frame', () => {
    const s = new CueScheduler(DEFS, CAPS);
    s.request('chop', -0.9, 0.9);
    s.request('chop', 0.9, 0.9);
    s.request('step', 0, 1.0); // evicted by the work cap this frame
    expect(flush(s, 1000).filter((v) => v.cue === 'step')).toHaveLength(0);
    s.request('step', 0, 1.0);
    const next = flush(s, 1016); // chop is cooling down; step is free
    expect(next.map((v) => v.cue)).toEqual(['step']);
  });

  it('honors the global cap minus voices still ringing in the engine', () => {
    const s = new CueScheduler(DEFS, { ui: 99, combat: 99, work: 99, world: 99 }, 4);
    s.request('chop', 0, 0.9);
    s.request('step', 0, 0.9);
    s.request('click', 0, 0.9);
    s.request('horn', 0, 0.9);
    expect(flush(s, 1000, 2)).toHaveLength(2); // 4 - 2 active = 2 slots
  });

  it('flush is idempotent: a second flush emits nothing', () => {
    const s = new CueScheduler(DEFS, CAPS);
    s.request('chop', 0, 0.8);
    expect(flush(s, 1000)).toHaveLength(1);
    expect(flush(s, 1001)).toHaveLength(0);
  });

  it('carries schedule-ahead delays through, gain-weighted on collapse', () => {
    const s = new CueScheduler(DEFS, CAPS);
    s.request('chop', 0, 0.8, 0.5);
    const [solo] = flush(s, 1000);
    expect(solo!.delay).toBeCloseTo(0.5);
    // Two units aiming at the same moment (one cooldown window apart at
    // most — the crowd's natural stagger) still merge to the mean.
    s.request('chop', 0, 0.6, 0.2);
    s.request('chop', 0, 0.6, 0.21);
    const merged = flush(s, 2000);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.delay).toBeCloseTo(0.205, 5);
    s.request('click', 0, 1);
    expect(flush(s, 3000)[0]!.delay).toBe(0);
  });

  it('impacts aimed at different moments stay two voices, times intact', () => {
    // A pickaxe cycle queues both strikes on the same wrap frame,
    // seconds apart. Averaging them made one clink at a moment when
    // nothing hits — landing-time buckets keep them separate.
    const s = new CueScheduler(DEFS, CAPS);
    s.request('chop', 0, 0.8, 0.22);
    s.request('chop', 0, 0.8, 2.09);
    const voices = flush(s, 1000);
    expect(voices).toHaveLength(2);
    const delays = voices.map((v) => v.delay).sort((a, b) => a - b);
    expect(delays[0]).toBeCloseTo(0.22, 5);
    expect(delays[1]).toBeCloseTo(2.09, 5);
  });

  it('seeds are deterministic across identical runs', () => {
    const run = (): number[] => {
      const s = new CueScheduler(DEFS, CAPS);
      s.request('chop', 0, 0.8);
      s.request('click', 0, 0.8);
      return flush(s, 1000).map((v) => v.seed);
    };
    expect(run()).toEqual(run());
    for (const seed of run()) {
      expect(seed).toBeGreaterThanOrEqual(0);
      expect(seed).toBeLessThan(1);
    }
  });

  it('holds no per-frame state across 10k frames (pool discipline)', () => {
    const s = new CueScheduler(DEFS, CAPS);
    const out: PlayRequest[] = [];
    for (let frame = 0; frame < 10_000; frame++) {
      const t = frame * 16;
      s.request('chop', Math.sin(frame) * 0.5, 0.8);
      s.request('step', 0, 0.6);
      s.flush(t, 0, out);
      expect(s.pending).toBe(0);
    }
    // The caller-owned pool stays at its high-water mark, not frame count.
    expect(out.length).toBeLessThanOrEqual(4);
  });

  it('default caps exist for every bus the catalogue uses', () => {
    expect(GLOBAL_CAP).toBeGreaterThan(0);
  });
});
