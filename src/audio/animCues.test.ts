import { describe, expect, it } from 'vitest';
import type { AnimKey } from '../render/characters';
import { CUES } from './cues';
import { animCue, LOOP_CUES } from './animCues';

const KEYS: AnimKey[] = [
  'idle',
  'walk',
  'jog',
  'attack',
  'shoot',
  'work',
  'pickaxe',
  'hammer',
  'dig',
  'tend',
  'draw',
  'fish',
  'carry',
  'carryIdle',
  'death',
];

describe('animCue', () => {
  it('the full matrix: only entering death makes a state-entry sound', () => {
    for (const prev of [null, ...KEYS]) {
      for (const next of KEYS) {
        const cue = animCue(prev, next);
        if (next === 'death' && prev !== 'death') {
          expect(cue, `${String(prev)} -> ${next}`).toBe('unitDeath');
        } else {
          expect(cue, `${String(prev)} -> ${next}`).toBeNull();
        }
      }
    }
  });

  it('a unit first seen mid-state stays quiet — except one dying', () => {
    // prev === null is "scrolled into view" or "just spawned": announcing
    // either would machine-gun the speakers on every camera pan.
    for (const next of KEYS) {
      const cue = animCue(null, next);
      if (next === 'death') expect(cue).toBe('unitDeath');
      else expect(cue).toBeNull();
    }
  });

  it('no transition fires into its own state', () => {
    for (const key of KEYS) expect(animCue(key, key)).toBeNull();
  });
});

describe('LOOP_CUES', () => {
  it('every entry names a real cue with a sane phase', () => {
    for (const [key, spec] of Object.entries(LOOP_CUES)) {
      expect(CUES[spec.cue], key).toBeDefined();
      expect(spec.impactPhase01, key).toBeGreaterThanOrEqual(0);
      expect(spec.impactPhase01, key).toBeLessThan(1);
    }
  });

  it('gaits are two footfalls a cycle; strikes are one', () => {
    expect(LOOP_CUES.walk?.perCycle).toBe(2);
    expect(LOOP_CUES.jog?.perCycle).toBe(2);
    expect(LOOP_CUES.carry?.perCycle).toBe(2);
    expect(LOOP_CUES.work?.perCycle).toBe(1);
    expect(LOOP_CUES.attack?.perCycle).toBe(1);
  });

  it('death and the idles have no percussion', () => {
    expect(LOOP_CUES.death).toBeUndefined();
    expect(LOOP_CUES.idle).toBeUndefined();
    expect(LOOP_CUES.carryIdle).toBeUndefined();
  });
});
