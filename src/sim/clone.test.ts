import { describe, expect, it } from 'vitest';
import { cloneWorld } from './clone';
import { hashWorld } from './hash';
import { deserializeWorld, serializeWorld } from './save';
import { createWorld, type World } from './world';
import { tickWorld } from './tick';

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

  it('meets the rollback time budget', () => {
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
    // Budget: a 40-tick rollback burst (MAX_PREDICTION) must fit a frame.
    expect(cloneMs + 40 * tickMs).toBeLessThan(16);
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
});
