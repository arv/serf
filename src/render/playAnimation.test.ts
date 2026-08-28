import * as THREE from 'three';
import {describe, expect, it} from 'vitest';
import * as AnimKey from './animKeyEnum.ts';
import {gaitAnimKey, playAnimation, type CharacterVisual} from './characters';
import * as Gait from './gaitEnum.ts';

/**
 * The two ways a clip switch has gone wrong, pinned:
 *
 * - Gait and AnimKey are separate numeric enums whose values collide
 *   (Gait.walk === AnimKey.idle), so handing a gait to playAnimation raw
 *   put every walking serf in the idle clip. gaitAnimKey is the spelled
 *   hop between them.
 *
 * - The off-screen cull nulls `current` so re-entry restarts the clip; but
 *   a fade only ever reaches the clip recorded in `current`, so a unit
 *   whose state changed while culled came back with its old action still
 *   at full weight — soldiers whose fight ended off-screen kept swinging
 *   at thin air forever. playAnimation now sweeps the other actions when
 *   it has no predecessor to fade.
 */

function makeVisual(): {
  visual: CharacterVisual;
  mixer: THREE.AnimationMixer;
} {
  const root = new THREE.Object3D();
  const bone = new THREE.Object3D();
  bone.name = 'b';
  root.add(bone);
  const mixer = new THREE.AnimationMixer(root);
  const clipFor = (name: string): THREE.AnimationClip =>
    new THREE.AnimationClip(name, 1, [
      new THREE.VectorKeyframeTrack('b.position', [0, 1], [0, 0, 0, 1, 0, 0]),
    ]);
  const actions = new Map<AnimKey, THREE.AnimationAction>([
    [AnimKey.idle, mixer.clipAction(clipFor('Idle_A'))],
    [AnimKey.walk, mixer.clipAction(clipFor('Walking_A'))],
    [AnimKey.attack, mixer.clipAction(clipFor('Melee'))],
  ]);
  const visual: CharacterVisual = {
    mixer,
    actions,
    current: null,
    gait: Gait.walk,
    gaitNat: {walk: 0, jog: 0},
    gaitSpeed: 0,
    ranged: false,
    toolKind: 0,
  };
  return {visual, mixer};
}

type AnimKey = import('../shared/enum.ts').Enum<typeof AnimKey>;

describe('gaitAnimKey', () => {
  it('maps each gait to its locomotion clip, across the numeric collision', () => {
    expect(gaitAnimKey(Gait.walk)).toBe(AnimKey.walk);
    expect(gaitAnimKey(Gait.jog)).toBe(AnimKey.jog);
    // The collision this guards: the raw gait numbers land on the wrong
    // keys, so any future "simplification" back to the raw value regresses.
    expect(Gait.walk).not.toBe(AnimKey.walk);
  });
});

describe('playAnimation', () => {
  it('crossfades out a known predecessor', () => {
    const {visual, mixer} = makeVisual();
    playAnimation(visual, AnimKey.attack, 0);
    mixer.update(0.05);
    playAnimation(visual, AnimKey.idle, 0);
    mixer.update(0.5); // fade is 0.16s — well past it
    const attack = visual.actions.get(AnimKey.attack)!;
    expect(attack.getEffectiveWeight()).toBe(0);
    expect(visual.actions.get(AnimKey.idle)!.isRunning()).toBe(true);
  });

  it('silences a stale action left running across an off-screen cull', () => {
    const {visual, mixer} = makeVisual();
    // Fighting on screen...
    playAnimation(visual, AnimKey.attack, 0);
    mixer.update(0.05);
    // ...then culled (sceneSync nulls `current`; the mixer stops being
    // sampled but the attack action stays enabled at full weight)...
    visual.current = null;
    // ...and the fight ends before the unit is back on screen.
    playAnimation(visual, AnimKey.idle, 0);
    mixer.update(0.05);
    const attack = visual.actions.get(AnimKey.attack)!;
    // Stopped means deactivated: the mixer no longer samples it at all
    // (its stale effectiveWeight field is dead memory, not a blend input).
    expect(attack.isRunning()).toBe(false);
    expect(visual.actions.get(AnimKey.idle)!.isRunning()).toBe(true);
  });
});
