import { describe, expect, it } from 'vitest';
import { tileIdx } from '../shared/grid.ts';
import { SeatVision } from './visibility.ts';
import { AiBrain, hostileNear, pickAttackTarget } from './systems/ai.ts';
import { AI_STRATEGIES } from './defs/aiStrategies.ts';
import { BANDIT } from './entities.ts';
import { placeBuiltBuilding, spawnUnit } from './world.ts';
import { addStorehouse, bareWorld } from './testUtils.ts';
import type { SimCommand } from './commands.ts';

/**
 * The brain plays under the fog. These are the two rules the server holds
 * humans to (server/src/sync.ts), applied to the AI: buildings are targets
 * only on explored ground, units count only in lit ground — and a muster
 * with nothing on its map goes scouting rather than marching straight at
 * a camp nobody has found.
 */

/** The campaign fixture: a castle, a muster of knights beside it, and a
 * bandit camp in the far corner nobody has been to. */
function musterWorld(): ReturnType<typeof bareWorld> {
  const world = bareWorld();
  addStorehouse(world, 30, 30, {});
  for (let i = 0; i < 7; i++) spawnUnit(world, 'knight', 0, 33.5, 27.5 + i);
  placeBuiltBuilding(world, 'banditCamp', BANDIT, 5, 5);
  // Past the steward's attack cooldown, so the army logic is live.
  world.tick = 1000;
  return world;
}

function moveOrders(commands: SimCommand[]): Extract<SimCommand, { kind: 'moveUnits' }>[] {
  return commands.filter((c) => c.kind === 'moveUnits');
}

describe('the AI under fog of war', () => {
  it('does not target a camp it has never seen', () => {
    const world = musterWorld();
    const vision = new SeatVision();
    vision.recompute(world, 0);
    expect(pickAttackTarget(world, vision, 0, 31, 31, false)).toBeUndefined();
  });

  it('targets the camp once someone has stood close enough to see it', () => {
    const world = musterWorld();
    spawnUnit(world, 'knight', 0, 8.5, 8.5); // a scout within sight of the camp
    const vision = new SeatVision();
    vision.recompute(world, 0);
    expect(pickAttackTarget(world, vision, 0, 31, 31, false)?.type).toBe('banditCamp');
  });

  it('counts a hostile at the gates only when it stands in lit ground', () => {
    const world = bareWorld();
    addStorehouse(world, 30, 30, {});
    // Well inside a homeGuard radius of 14, but beyond the castle's sight.
    spawnUnit(world, 'bandit', BANDIT, 43.5, 31.5);
    const vision = new SeatVision();
    vision.recompute(world, 0);
    expect(hostileNear(world, vision, 0, 31, 31, 14)).toBe(false);
    // A watchman near the raider lights the ground under it.
    spawnUnit(world, 'knight', 0, 40.5, 31.5);
    vision.recompute(world, 0);
    expect(hostileNear(world, vision, 0, 31, 31, 14)).toBe(true);
  });

  it('sends a full muster scouting when its map holds no target', () => {
    const world = musterWorld();
    const brain = new AiBrain(0, AI_STRATEGIES.steward);
    const moves = moveOrders(brain.decide(world));
    expect(moves).toHaveLength(1);
    const { x, y } = moves[0]!;
    // Not the blind beeline to the camp the omniscient brain used to make…
    expect(Math.abs(x - 6) + Math.abs(y - 6)).toBeGreaterThan(4);
    // …but a march that will light ground the seat has never observed
    // (the destination stops a few tiles short of the goal on purpose, so
    // it is the sight circle around it that must reach into the dark).
    const vision = new SeatVision();
    vision.recompute(world, 0);
    let lightsNewGround = false;
    for (let dy = -6; dy <= 6 && !lightsNewGround; dy++) {
      for (let dx = -6; dx <= 6 && !lightsNewGround; dx++) {
        const tx = x + dx;
        const ty = y + dy;
        if (tx < 0 || ty < 0 || tx >= 64 || ty >= 64) continue;
        if (dx * dx + dy * dy > 6.5 * 6.5) continue;
        if (!vision.explored[tileIdx(tx, ty)]) lightsNewGround = true;
      }
    }
    expect(lightsNewGround).toBe(true);
  });

  it('keeps the sweep goal while marching, and re-aims once it lights up', () => {
    const world = musterWorld();
    const brain = new AiBrain(0, AI_STRATEGIES.steward);
    const first = moveOrders(brain.decide(world))[0]!;
    // Mid-march (units busy, goal still dark) the brain leaves the army be.
    for (const u of world.units.values()) {
      if (u.kind === 'knight') u.task = { t: 'move' };
    }
    world.tick += 20;
    expect(moveOrders(brain.decide(world))).toHaveLength(0);
    // The goal lights up: a knight now stands on it, so the next beat picks
    // a fresh patch of dark ground instead of re-ordering the same march.
    const scout = [...world.units.values()].find((u) => u.kind === 'knight')!;
    scout.x = first.x + 0.5;
    scout.y = first.y + 0.5;
    world.tick += 20;
    const next = moveOrders(brain.decide(world));
    expect(next).toHaveLength(1);
    expect(next[0]!.x !== first.x || next[0]!.y !== first.y).toBe(true);
  });

  it('marches on the camp as soon as the sweep uncovers it', () => {
    const world = musterWorld();
    spawnUnit(world, 'knight', 0, 8.5, 8.5); // the sweep got this far
    const brain = new AiBrain(0, AI_STRATEGIES.steward);
    const moves = moveOrders(brain.decide(world));
    expect(moves).toHaveLength(1);
    // The camp's footprint origin is (5,5); the brain aims at its center.
    expect(moves[0]).toMatchObject({ x: 6, y: 6 });
  });

  it('abandons sweep goals the army stood down in front of', () => {
    const world = musterWorld();
    const brain = new AiBrain(0, AI_STRATEGIES.steward);
    // The army never goes anywhere (every order falls on deaf feet in this
    // fixture — decide() output is never applied): each beat finds everyone
    // idle with the goal still dark. The brain must write goals off and try
    // elsewhere rather than re-picking the same impossible tile forever.
    const seen = new Set<string>();
    for (let beat = 0; beat < 4; beat++) {
      const moves = moveOrders(brain.decide(world));
      expect(moves, `beat ${beat} went quiet`).toHaveLength(1);
      seen.add(`${moves[0]!.x},${moves[0]!.y}`);
      world.tick += 20;
    }
    expect(seen.size).toBeGreaterThan(1);
  });
});
