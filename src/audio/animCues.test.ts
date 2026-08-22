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
      for (const [clip, phase] of Object.entries(spec.byClip ?? {})) {
        expect(phase, `${key} ${clip}`).toBeGreaterThanOrEqual(0);
        expect(phase, `${key} ${clip}`).toBeLessThan(1);
      }
    }
  });

  it('gaits are two footfalls a cycle; so are the pack tool loops', () => {
    expect(LOOP_CUES.walk?.perCycle).toBe(2);
    expect(LOOP_CUES.jog?.perCycle).toBe(2);
    expect(LOOP_CUES.carry?.perCycle).toBe(2);
    // Pickaxing and Hammering genuinely strike twice per clip, on the
    // half-cycle (animImpacts.mjs measures 0.06/0.56 and 0.09/0.59).
    expect(LOOP_CUES.pickaxe?.perCycle).toBe(2);
    expect(LOOP_CUES.hammer?.perCycle).toBe(2);
    expect(LOOP_CUES.work?.perCycle).toBe(1);
    expect(LOOP_CUES.attack?.perCycle).toBe(1);
    expect(LOOP_CUES.shoot?.perCycle).toBe(1);
  });

  it('a twice-a-cycle phase stays in the first half — the mirror lands +0.5', () => {
    for (const [key, spec] of Object.entries(LOOP_CUES)) {
      if (spec.perCycle !== 2) continue;
      expect(spec.impactPhase01, key).toBeLessThan(0.5);
      for (const [clip, phase] of Object.entries(spec.byClip ?? {})) {
        expect(phase, `${key} ${clip}`).toBeLessThan(0.5);
      }
    }
  });

  it('carry keeps step with the legs it borrowed — walk by default, jog by clip', () => {
    // characters.ts composites Carry_Walk from Walking_A and Carry_Jog
    // from Running_A; the footfalls are those gaits' own.
    expect(LOOP_CUES.carry?.impactPhase01).toBe(LOOP_CUES.walk?.impactPhase01);
    expect(LOOP_CUES.carry?.byClip?.Carry_Jog).toBe(LOOP_CUES.jog?.impactPhase01);
  });

  it('the attack key covers each attackClip a kind can swap in', () => {
    // characters.ts KKSpecs override the melee clip for the staff knight
    // and the barbarian; their impacts land elsewhere in the clip, so
    // each needs its own phase. Shape, not exact constants (animCues.ts
    // owns the measurements): the stab thrusts in the clip's first half
    // where both chops swing in the second — a slide back toward one
    // shared phase trips these.
    const attack = LOOP_CUES.attack!;
    const stab = attack.byClip?.Melee_1H_Attack_Stab ?? NaN;
    const chop2h = attack.byClip?.Melee_2H_Attack_Chop ?? NaN;
    expect(stab).toBeGreaterThan(0);
    expect(stab).toBeLessThan(0.35);
    expect(chop2h).toBeGreaterThan(0.35);
    expect(chop2h).toBeLessThanOrEqual(attack.impactPhase01);
    expect(attack.impactPhase01).toBeGreaterThan(0.35);
  });

  it('death and the idles have no percussion', () => {
    expect(LOOP_CUES.death).toBeUndefined();
    expect(LOOP_CUES.idle).toBeUndefined();
    expect(LOOP_CUES.carryIdle).toBeUndefined();
  });
});
