import { describe, expect, it } from 'vitest';
import { cloneWorld } from './clone.ts';
import { hashWorld } from './hash.ts';
import { deserializeWorld, serializeWorld } from './save.ts';
import { createWorld, type World } from './world.ts';
import { tickWorld } from './tick.ts';
import type { Unit } from './units.ts';

function run(world: World, ticks: number): void {
  for (let t = 0; t < ticks; t++) tickWorld(world, []);
}

describe('cloneWorld — the rollback snapshot primitive', () => {
  it('clones equal and mutation-isolated', () => {
    const world = createWorld({ seed: 5, players: [{ kind: 'ai' }, { kind: 'ai' }] });
    run(world, 800);
    const snap = cloneWorld(world);
    expect(hashWorld(snap)).toBe(hashWorld(world));
    const before = hashWorld(snap);

    // Sim the original 500 ticks; the clone must not move.
    run(world, 500);
    expect(hashWorld(snap)).toBe(before);
    expect(hashWorld(world)).not.toBe(before);

    // The clone re-simulates to the same place as the original (the exact
    // property rollback re-simulation depends on).
    run(snap, 500);
    expect(hashWorld(snap)).toBe(hashWorld(world));
  });

  it('pins clone, save, and hash to each other', () => {
    // A forgotten field diverges one of the three copies of the world
    // schema — this catches it structurally.
    const world = createWorld({ seed: 6, players: [{ kind: 'ai' }] });
    run(world, 600);
    const viaClone = cloneWorld(world);
    const viaSave = deserializeWorld(serializeWorld(world));
    expect(hashWorld(viaClone)).toBe(hashWorld(world));
    expect(hashWorld(viaSave)).toBe(hashWorld(world));
    // And they keep agreeing after further simulation.
    run(world, 400);
    run(viaClone, 400);
    run(viaSave, 400);
    expect(hashWorld(viaClone)).toBe(hashWorld(world));
    expect(hashWorld(viaSave)).toBe(hashWorld(world));
  });

  it('stays cheap enough to snapshot a live world', () => {
    const world = createWorld({
      seed: 8,
      players: [{ kind: 'ai' }, { kind: 'ai' }, { kind: 'ai' }, { kind: 'ai' }],
    });
    run(world, 3000); // a grown 4-economy world

    const t0 = performance.now();
    let snap = world;
    for (let i = 0; i < 20; i++) snap = cloneWorld(world);
    const cloneMs = (performance.now() - t0) / 20;

    const t1 = performance.now();
    run(snap, 100);
    const tickMs = (performance.now() - t1) / 100;

    // eslint-disable-next-line no-console
    console.log(`cloneWorld ${cloneMs.toFixed(2)}ms, tick ${tickMs.toFixed(3)}ms at 4p scale`);
    // Rollback is gone, so there is no per-frame burst to fit any more. This
    // is a regression tripwire: cloning a whole world should stay in the
    // small-milliseconds, or something has started deep-copying the map.
    expect(cloneMs).toBeLessThan(5);
  });
});

describe('hashWorld', () => {
  it('is stable across identical runs and differs across seeds', () => {
    const a = createWorld({ seed: 21, players: [{ kind: 'ai' }] });
    const b = createWorld({ seed: 21, players: [{ kind: 'ai' }] });
    const c = createWorld({ seed: 22, players: [{ kind: 'ai' }] });
    run(a, 400);
    run(b, 400);
    run(c, 400);
    expect(hashWorld(a)).toBe(hashWorld(b));
    expect(hashWorld(a)).not.toBe(hashWorld(c));
  });

  it('sees the state that steers a unit before it has moved a step', () => {
    // Each of these changes what a unit will do for many ticks while leaving
    // every position, hp and task tag identical. A digest blind to them calls
    // two worlds the same right up until the fight resolves differently —
    // which is exactly when it is too late to be told.
    const world = createWorld({ seed: 21, players: [{ kind: 'ai' }] });
    run(world, 400);
    const base = hashWorld(world);
    const mutations: ((u: Unit) => void)[] = [
      (u) => {
        u.targetId = 4242;
        u.targetIsBuilding = false;
      },
      (u) => {
        u.targetIsBuilding = !u.targetIsBuilding;
      },
      (u) => {
        u.cooldownLeft += 1;
      },
      (u) => {
        u.path = [...(u.path ?? []), 999];
      },
    ];
    for (const mutate of mutations) {
      const w = cloneWorld(world);
      const first = [...w.units.values()][0]!;
      mutate(first);
      expect(hashWorld(w)).not.toBe(base);
    }
  });
});
