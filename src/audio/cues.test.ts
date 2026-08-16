import { describe, expect, it } from 'vitest';
import { BUS_CAPS } from './voices';
import { type CueDef, type CueId, CUES } from './cues';

const entries = Object.entries(CUES) as [CueId, CueDef][];

describe('cue catalogue', () => {
  it('every cue names a bus the scheduler has a cap for', () => {
    for (const [id, def] of entries) {
      expect(BUS_CAPS[def.bus], `${id} -> ${def.bus}`).toBeGreaterThan(0);
    }
  });

  it('gains, cooldowns and priorities stay in their lanes', () => {
    for (const [id, def] of entries) {
      expect(def.gain, id).toBeGreaterThan(0);
      expect(def.gain, id).toBeLessThanOrEqual(1);
      expect(def.cooldownMs, id).toBeGreaterThanOrEqual(0);
      expect(def.priority, id).toBeGreaterThan(0);
      if (def.pitchJitter !== undefined) {
        expect(def.pitchJitter, id).toBeGreaterThan(0);
        expect(def.pitchJitter, id).toBeLessThan(0.5);
      }
    }
  });

  // The recipe is what guarantees the game never goes silent for a
  // missing file — a sample may replace it, never displace it.
  it('no cue is sample-only', () => {
    for (const [id, def] of entries) {
      expect(def.layers.length, id).toBeGreaterThan(0);
    }
  });

  it('recipes are physically renderable: positive times, positive frequencies', () => {
    for (const [id, def] of entries) {
      for (const l of def.layers) {
        expect(l.gain, id).toBeGreaterThan(0);
        expect(l.decay, id).toBeGreaterThan(0);
        expect(l.freq, id).toBeGreaterThan(0);
        if (l.freqEnd !== undefined) expect(l.freqEnd, id).toBeGreaterThan(0);
        if (l.attack !== undefined) expect(l.attack, id).toBeGreaterThanOrEqual(0);
        if (l.delay !== undefined) expect(l.delay, id).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('samples, once named, point under /audio/ (the step-4 seam)', () => {
    for (const [id, def] of entries) {
      if (def.sample !== undefined) {
        expect(def.sample, id).toMatch(/^\/audio\/.+\.(m4a|ogg|mp3|wav)$/);
      }
    }
  });
});
