import * as THREE from 'three';
import {describe, expect, it, vi} from 'vitest';
import {
  ACTION,
  SAB_BYTES,
  SabReader,
  SabWriter,
  WORK,
  type UnitSnapshot,
} from '../protocol/sabLayout';
import type {HeightField} from './heightField';

/**
 * Which way a standing worker is turned. The renderer faces a unit by the
 * ground it covered between publishes, so a man who stops to work has no
 * delta to face by and keeps the yaw he walked up in — that is how a
 * builder came to raise a whole house with his back to it. The sim sends
 * the bearing to the work in the facing byte and the range to it in the
 * next one; the range off zero is what says the bearing means anything.
 *
 * Only the character body is stubbed (an empty clip library, which every
 * call in the loop tolerates); the turn itself is the real update().
 */
const groups: THREE.Group[] = [];
vi.mock('./characters', async importOriginal => {
  const real = await importOriginal<typeof import('./characters')>();
  return {
    ...real,
    makeCharacter: () => {
      const group = new THREE.Group();
      groups.push(group);
      return {
        group,
        visual: {
          mixer: new THREE.AnimationMixer(group),
          actions: new Map(),
          current: null,
          gait: 0,
          gaitNat: {walk: 0, jog: 0},
          gaitSpeed: 0,
          ranged: false,
          toolKind: 0,
        },
      };
    },
  };
});

const {SceneSync} = await import('./sceneSync');

const flat = {at: () => 0} as unknown as HeightField;

/** A quarter turn per 64 of the facing byte: 192 is three quarters. */
const WEST = 192;

function worker(over: Partial<UnitSnapshot> = {}): UnitSnapshot {
  return {
    id: 1,
    // Parked east of a site centred on (30.5, 30.5) — the side the path
    // came in on, which is the side he used to hammer from.
    x: 32,
    y: 30.5,
    kind: 5,
    owner: 0,
    hpPct: 255,
    maxHp: 80,
    carrying: 0,
    action: ACTION.work,
    workKind: WORK.hammer,
    ...over,
  };
}

/** Publish a run of frames and hand back the body's yaw. */
function yawAfter(...frames: UnitSnapshot[]): number {
  groups.length = 0;
  const sab = new SharedArrayBuffer(SAB_BYTES);
  const writer = new SabWriter(sab);
  const reader = new SabReader(sab);
  const sync = new SceneSync(new THREE.Scene(), reader, flat);
  let now = 0;
  for (const f of frames) {
    now += 1000 / 60;
    writer.publish([f]);
    reader.poll(now);
    sync.update(now);
  }
  return groups[0]!.rotation.y;
}

describe('a standing worker faces his work', () => {
  it('turns a hammering builder onto the bearing the sim sent', () => {
    const stand = worker({facing: WEST, targetDist: 12});
    // Two identical publishes: no movement delta, so nothing but the
    // bearing can be facing him.
    expect(yawAfter(stand, stand)).toBeCloseTo(Math.PI * 1.5);
  });

  it('leaves the walk-in yaw alone when there is nothing to face', () => {
    // Walked in heading east, then stood with a bearing byte but no range
    // — 0 is the wire's "nothing to face", and a 0 bearing would otherwise
    // spin every unit in the valley due south.
    const stand = worker({x: 32, facing: 0, targetDist: 0});
    const yaw = yawAfter(worker({x: 31, targetDist: 0}), stand, stand);
    expect(yaw).toBeCloseTo(Math.PI / 2);
  });

  it('faces the walk, not the work, while he is still on the road', () => {
    // Same bearing, but he is covering ground: the step wins, so a builder
    // walking up to his site does not sidle in facing the frame.
    const yaw = yawAfter(
      worker({x: 32, facing: WEST, targetDist: 12}),
      worker({x: 32.5, facing: WEST, targetDist: 12}),
    );
    expect(yaw).toBeCloseTo(Math.PI / 2);
  });

  it('ignores a bearing under an action that is not work or a fight', () => {
    const idle = worker({action: ACTION.idle, facing: WEST, targetDist: 12});
    expect(yawAfter(idle, idle)).toBeCloseTo(0);
  });

  // The pier, the rows and the windlass are placed by the render, which
  // turns those workers on the frames it moves them and leaves the heading
  // standing on the frames it does not: a farmer mid-stroke is holding the
  // row he walked in along. Writing the sim's bearing over that would have
  // him scything at the farm building for the length of every stroke.
  for (const [name, kind] of [
    ['fisherman', WORK.fish],
    ['farmer', WORK.mow],
    ['hauler at a windlass', WORK.draw],
  ] as const) {
    it(`keeps the bearing off the ${name}, whose post the render turns`, () => {
      const stand = worker({
        x: 32,
        workKind: kind,
        facing: WEST,
        targetDist: 12,
      });
      const yaw = yawAfter(
        worker({x: 31, workKind: kind, facing: WEST, targetDist: 12}),
        stand,
        stand,
      );
      expect(yaw).toBeCloseTo(Math.PI / 2); // the walk in, not the bearing
    });
  }
});
