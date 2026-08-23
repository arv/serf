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
    const vision = new SeatVision(world.map.size);
    vision.recompute(world, 0);
    expect(pickAttackTarget(world, vision, 0, 31, 31, false)).toBeUndefined();
  });

  it('targets the camp once someone has stood close enough to see it', () => {
    const world = musterWorld();
    spawnUnit(world, 'knight', 0, 8.5, 8.5); // a scout within sight of the camp
    const vision = new SeatVision(world.map.size);
    vision.recompute(world, 0);
    expect(pickAttackTarget(world, vision, 0, 31, 31, false)?.type).toBe('banditCamp');
  });

  it('counts a hostile at the gates only when it stands in lit ground', () => {
    const world = bareWorld();
    addStorehouse(world, 30, 30, {});
    // Well inside a homeGuard radius of 14, but beyond the castle's sight.
    spawnUnit(world, 'bandit', BANDIT, 43.5, 31.5);
    const vision = new SeatVision(world.map.size);
    vision.recompute(world, 0);
    expect(hostileNear(world, vision, 0, 31, 31, 14)).toBe(false);
    // A watchman near the raider lights the ground under it.
    spawnUnit(world, 'knight', 0, 40.5, 31.5);
    vision.recompute(world, 0);
    expect(hostileNear(world, vision, 0, 31, 31, 14)).toBe(true);
  });

  it('sends a full muster scouting when its map holds no target', () => {
    const world = musterWorld();
    const brain = new AiBrain(0, AI_STRATEGIES.steward, world.map.size);
    const moves = moveOrders(brain.decide(world));
    expect(moves).toHaveLength(1);
    const { x, y } = moves[0]!;
    // Not the blind beeline to the camp the omniscient brain used to make…
    expect(Math.abs(x - 6) + Math.abs(y - 6)).toBeGreaterThan(4);
    // …but a march that will light ground the seat has never observed
    // (the destination stops a few tiles short of the goal on purpose, so
    // it is the sight circle around it that must reach into the dark).
    const vision = new SeatVision(world.map.size);
    vision.recompute(world, 0);
    let lightsNewGround = false;
    for (let dy = -6; dy <= 6 && !lightsNewGround; dy++) {
      for (let dx = -6; dx <= 6 && !lightsNewGround; dx++) {
        const tx = x + dx;
        const ty = y + dy;
        if (tx < 0 || ty < 0 || tx >= 64 || ty >= 64) continue;
        if (dx * dx + dy * dy > 6.5 * 6.5) continue;
        if (!vision.explored[tileIdx(tx, ty, world.map.size)]) lightsNewGround = true;
      }
    }
    expect(lightsNewGround).toBe(true);
  });

  it('keeps the sweep goal while marching, and re-aims once it lights up', () => {
    const world = musterWorld();
    const brain = new AiBrain(0, AI_STRATEGIES.steward, world.map.size);
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
    const brain = new AiBrain(0, AI_STRATEGIES.steward, world.map.size);
    const moves = moveOrders(brain.decide(world));
    expect(moves).toHaveLength(1);
    // The camp's footprint origin is (5,5); the brain aims at its center.
    expect(moves[0]).toMatchObject({ x: 6, y: 6 });
  });

  it('forges and trains the counter to what scouting has seen', () => {
    // Steward vs a spear wall: light is countered by heavy, so the smiths
    // turn to swords (the second one against its playbook line of spears)
    // and the barracks trains the knight the sword in stock can arm.
    const world = bareWorld(1, 2);
    addStorehouse(world, 30, 30, { sword: 1, spear: 1 });
    world.players[0]!.techs.researched.push('soldiery', 'ironworking');
    placeBuiltBuilding(world, 'barracks', 0, 34, 34);
    placeBuiltBuilding(world, 'weaponsmith', 0, 26, 34);
    placeBuiltBuilding(world, 'weaponsmith', 0, 26, 26);
    for (let i = 0; i < 4; i++) spawnUnit(world, 'spearman', 1, 35.5, 30.5 + i);
    world.tick = 1000;
    const brain = new AiBrain(0, AI_STRATEGIES.steward, world.map.size);
    const commands = brain.decide(world);
    const recipes = commands.filter((c) => c.kind === 'setBuildingRecipe');
    expect(recipes).toHaveLength(2);
    for (const r of recipes) expect(r).toMatchObject({ index: 1 }); // sword
    expect(commands.find((c) => c.kind === 'trainUnit')).toMatchObject({ unit: 'knight' });
  });

  it('keeps the playbook line when the counter is out of its reach', () => {
    // Fletcher vs archers: the counter is spears, but the spear recipe is
    // behind ironworking the fletcher never researches — the forges stay
    // on bows and the barracks trains the archer it can actually arm.
    const world = bareWorld(1, 2);
    addStorehouse(world, 30, 30, { bow: 2 });
    world.players[0]!.techs.researched.push('soldiery', 'archery');
    placeBuiltBuilding(world, 'barracks', 0, 34, 34);
    placeBuiltBuilding(world, 'weaponsmith', 0, 26, 34);
    placeBuiltBuilding(world, 'weaponsmith', 0, 26, 26);
    for (let i = 0; i < 4; i++) spawnUnit(world, 'archer', 1, 35.5, 30.5 + i);
    world.tick = 1000;
    const brain = new AiBrain(0, AI_STRATEGIES.fletcher, world.map.size);
    const commands = brain.decide(world);
    const recipes = commands.filter((c) => c.kind === 'setBuildingRecipe');
    expect(recipes).toHaveLength(2);
    for (const r of recipes) expect(r).toMatchObject({ index: 2 }); // bowstaves
    expect(commands.find((c) => c.kind === 'trainUnit')).toMatchObject({ unit: 'archer' });
  });

  it('keeps a trusted sighting through a doorstep read that saw nothing', () => {
    // The picture: four rival spearmen, seen and filed. They march off, the
    // clock goes stale, and the scout re-reads an empty doorstep. The read
    // resets the clock — but must not erase what was actually seen: the
    // sighting is still inside its trust window, and the forges keep
    // answering it with swords.
    const world = bareWorld(1, 2);
    addStorehouse(world, 30, 30, { sword: 1, spear: 1 });
    addStorehouse(world, 44, 44, {}, 1);
    world.players[0]!.techs.researched.push('soldiery', 'ironworking');
    placeBuiltBuilding(world, 'weaponsmith', 0, 26, 34);
    placeBuiltBuilding(world, 'weaponsmith', 0, 26, 26);
    const foes = Array.from({ length: 4 }, (_, i) => spawnUnit(world, 'spearman', 1, 35.5, 30.5 + i));
    world.tick = 1000;
    const brain = new AiBrain(0, AI_STRATEGIES.steward, world.map.size);
    expect(brain.decide(world).filter((c) => c.kind === 'setBuildingRecipe')).toHaveLength(2);
    // The spearmen vanish; the scout finds their yard empty well past the
    // refresh clock but well inside the trust window.
    for (const u of foes) u.dead = true;
    spawnUnit(world, 'knight', 0, 45.5, 48.5); // already standing at the doorstep
    world.tick = 5200;
    brain.decide(world); // the errand starts
    world.tick = 5220;
    brain.decide(world); // standing at the yard: the read stamps the clock
    world.tick = 5240;
    const recipes = brain.decide(world).filter((c) => c.kind === 'setBuildingRecipe');
    expect(recipes).toHaveLength(2); // both smiths still ordered to swords
    for (const r of recipes) expect(r).toMatchObject({ index: 1 });
  });

  it('sends the scout to read a rival doorstep once a target is known', () => {
    // Discovery found the castle; intelligence asks what defends it. With
    // a target on the map and no picture of the rival's army, the scout
    // heads for their garrison ground — gate leg first, as always.
    const world = bareWorld(1, 2);
    addStorehouse(world, 30, 30, {});
    addStorehouse(world, 66, 66, {}, 1); // the rival's castle, on its start
    for (let i = 0; i < 3; i++) spawnUnit(world, 'knight', 0, 33.5, 27.5 + i);
    spawnUnit(world, 'knight', 0, 64.5, 65.5); // close enough to have seen it
    world.tick = 1000;
    const brain = new AiBrain(0, AI_STRATEGIES.steward, world.map.size);
    const commands = brain.decide(world);
    const single = moveOrders(commands).filter((c) => c.unitIds.length === 1);
    expect(single).toHaveLength(1);
    // The doorstep sits at (67, 71): south of the rival castle (start
    // 66,66 on the 96-map two-seat layout), where their garrison stands.
    // The scout's first leg is the gate 13 north of it.
    expect(single[0]).toMatchObject({ x: 67, y: 58 });
  });

  it('finishes that read from the watch point it was sent to', () => {
    // The errand and the arrival test have to agree. The brain walks the
    // scout to a watch point six tiles north of the doorstep — close
    // enough that the yard sits inside his sight circle, far enough that
    // the garrison does not chase him. If "close enough to read the yard"
    // is measured tighter than the walk the brain orders, the read can
    // never land: the doorstep stays stale, the errand is never retired,
    // and scoutLeg re-issues the gate leg the instant he arrives. Seen in
    // a real match as a lone AI soldier pacing the same two tiles at the
    // player's castle from the fourth minute to the end of the game.
    const world = bareWorld(1, 2);
    addStorehouse(world, 30, 30, {});
    addStorehouse(world, 66, 66, {}, 1);
    for (let i = 0; i < 3; i++) spawnUnit(world, 'knight', 0, 33.5, 27.5 + i);
    spawnUnit(world, 'knight', 0, 64.5, 65.5);
    world.tick = 1000;
    const brain = new AiBrain(0, AI_STRATEGIES.steward, world.map.size);
    const gateLeg = moveOrders(brain.decide(world)).filter((c) => c.unitIds.length === 1)[0]!;
    expect(gateLeg).toMatchObject({ x: 67, y: 58 });
    const scout = world.units.get(gateLeg.unitIds[0]!)!;
    const legs: { x: number; y: number }[] = [];

    // Walk what he is told to walk, beat by beat: teleport him to the last
    // leg he was given and let the brain pick the next one.
    for (let beat = 0; beat < 40; beat++) {
      const last = legs.at(-1) ?? gateLeg;
      scout.x = last.x + 0.5;
      scout.y = last.y + 0.5;
      world.tick += 20;
      for (const c of moveOrders(brain.decide(world))) {
        if (c.unitIds.includes(scout.id)) legs.push({ x: c.x, y: c.y });
      }
    }

    // The descent to the watch point, and then the errand is over: the
    // read is filed and he is never sent back to the gate.
    expect(legs[0]).toEqual({ x: 67, y: 65 });
    expect(brain.intelReport().find((r) => r.owner === 1)?.reads).toBe(1);
    expect(legs.filter((l) => l.x === 67 && l.y === 58)).toHaveLength(0);
    // And with nothing left to read he goes back to the muster, rather
    // than pacing the rival's gate for the rest of the match.
    expect(legs.at(-1)).toEqual({ x: 31, y: 35 });
  });

  it('sweeps in force but never to the last man, and calls the garrison in', () => {
    // The whole army is out in the field when the next sweep leg is picked.
    // Losing the race home against a raid wave is the failure this guards:
    // a seat only sees raiders once they are at the gates, so a recall
    // cannot cover for a castle that was left empty in the first place.
    const world = musterWorld();
    for (const u of world.units.values()) {
      if (u.kind === 'knight') {
        u.x = 55.5;
        u.y = 55.5;
      }
    }
    const brain = new AiBrain(0, AI_STRATEGIES.steward, world.map.size);
    const moves = moveOrders(brain.decide(world));
    expect(moves).toHaveLength(2);

    const home = moves.find((m) => m.x === 31 && m.y === 35); // base is sh.x+1, +4 south
    const sweep = moves.find((m) => m !== home);
    expect(home, 'the garrison is called back to the castle').toBeDefined();
    expect(sweep, 'the party still marches on the frontier').toBeDefined();
    // Seven knights: three hold the castle, four search. Both orders are
    // attack-moves — an army that walks past a raid it meets is no army.
    expect(home!.unitIds).toHaveLength(3);
    expect(sweep!.unitIds).toHaveLength(4);
    for (const m of moves) expect(m.attack).toBe(true);
    // Nobody is in both, and between them they are the whole army.
    expect(new Set([...home!.unitIds, ...sweep!.unitIds]).size).toBe(7);
  });

  it('abandons sweep goals the army stood down in front of', () => {
    const world = musterWorld();
    const brain = new AiBrain(0, AI_STRATEGIES.steward, world.map.size);
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
