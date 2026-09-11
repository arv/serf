import {describe, expect, it} from 'vitest';
import * as BuildingState from './buildingStateEnum.ts';
import {cloneWorld} from './clone.ts';
import * as DifficultyId from './defs/difficultyEnum.ts';
import * as GoodId from './defs/goodIdEnum.ts';
import * as TechId from './defs/techIdEnum.ts';
import {hashWorld} from './hash.ts';
import type {PlayerState} from './player.ts';
import * as PlayerKind from './playerKindEnum.ts';
import {deserializeWorld, serializeWorld} from './save.ts';
import {tickWorld} from './tick.ts';
import type {Unit} from './units.ts';
import {createWorld, type World} from './world.ts';

function run(world: World, ticks: number): void {
  for (let t = 0; t < ticks; t++) tickWorld(world, []);
}

describe('cloneWorld — the rollback snapshot primitive', () => {
  it('clones equal and mutation-isolated', () => {
    const world = createWorld({
      seed: 5,
      players: [{kind: PlayerKind.ai}, {kind: PlayerKind.ai}],
    });
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
    const world = createWorld({seed: 6, players: [{kind: PlayerKind.ai}]});
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

  it('isolates a study bill in flight — researchNeeds must not be shared', () => {
    // The same hazard as the repair bill below, and for the same reason:
    // researchNeeds is decremented in place at the Abbey's door (deliver in
    // systems/logistics.ts), so a clone sharing it by reference watches the
    // original's loads land as if they were its own.
    const world = createWorld({seed: 5, players: [{kind: PlayerKind.ai}]});
    run(world, 200);
    const b = [...world.buildings.values()].find(
      x => x.state === BuildingState.built,
    )!;
    b.researchNeeds = {[GoodId.wood]: 3};
    const snap = cloneWorld(world);
    b.researchNeeds[GoodId.wood] = 2; // the original takes a load in
    expect(snap.buildings.get(b.id)!.researchNeeds).toEqual({
      [GoodId.wood]: 3,
    });
  });

  it('isolates a repair bill in flight — repairNeeds must not be shared', () => {
    // repairNeeds is the one GoodAmounts the repair flow decrements in
    // place (applyRepairMaterial), so a clone sharing it by reference sees
    // the original's spending — both worlds watch the bill fall twice as
    // fast, and the save round-trip reference this file exists for lies.
    const world = createWorld({seed: 5, players: [{kind: PlayerKind.ai}]});
    run(world, 200);
    const b = [...world.buildings.values()].find(
      x => x.state === BuildingState.built,
    )!;
    b.repairNeeds = {[GoodId.wood]: 3};
    const snap = cloneWorld(world);
    b.repairNeeds[GoodId.wood] = 2; // the original works a plank in
    expect(snap.buildings.get(b.id)!.repairNeeds).toEqual({[GoodId.wood]: 3});
  });

  it('stays cheap enough to snapshot a live world', () => {
    const world = createWorld({
      seed: 8,
      players: [
        {kind: PlayerKind.ai},
        {kind: PlayerKind.ai},
        {kind: PlayerKind.ai},
        {kind: PlayerKind.ai},
      ],
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
    console.log(
      `cloneWorld ${cloneMs.toFixed(2)}ms, tick ${tickMs.toFixed(3)}ms at 4p scale`,
    );
    // Rollback is gone, so there is no per-frame burst to fit any more. This
    // is a regression tripwire: cloning a whole world should stay in the
    // small-milliseconds, or something has started deep-copying the map.
    expect(cloneMs).toBeLessThan(5);
  });
});

describe('hashWorld', () => {
  it('is stable across identical runs and differs across seeds', () => {
    const a = createWorld({seed: 21, players: [{kind: PlayerKind.ai}]});
    const b = createWorld({seed: 21, players: [{kind: PlayerKind.ai}]});
    const c = createWorld({seed: 22, players: [{kind: PlayerKind.ai}]});
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
    const world = createWorld({seed: 21, players: [{kind: PlayerKind.ai}]});
    run(world, 400);
    const base = hashWorld(world);
    const mutations: ((u: Unit) => void)[] = [
      u => {
        u.targetId = 4242;
        u.targetIsBuilding = false;
      },
      u => {
        u.targetIsBuilding = !u.targetIsBuilding;
      },
      u => {
        u.cooldownLeft += 1;
      },
      u => {
        u.path = [...(u.path ?? []), 999];
      },
      // Fractional damage: the counter table's multipliers land fractional
      // blows, so two worlds can differ ONLY below the integer line — the
      // mutation keeps the integer part so a truncating digest sees nothing.
      u => {
        u.hp = Math.trunc(u.hp) + (u.hp % 1 < 0.5 ? 0.75 : 0.25);
      },
      // The repath backoff steers a blocked walker's next 45 ticks.
      u => {
        u.repathAt = 4242;
      },
    ];
    for (const mutate of mutations) {
      const w = cloneWorld(world);
      const first = [...w.units.values()][0]!;
      mutate(first);
      expect(hashWorld(w)).not.toBe(base);
    }
  });

  it('sees the whole of a player, not just a count of his techs', () => {
    // Each of these leaves `alive` and the researched count where they
    // were — the two things the digest used to read per seat — and changes
    // what every post in the village does next. A save that dropped any of
    // them round-tripped to an identical hash, so the clone/save/hash
    // triangle test above could not catch it (#259).
    const world = createWorld({
      seed: 21,
      players: [{kind: PlayerKind.ai, difficulty: DifficultyId.hard}],
    });
    run(world, 400);
    const seat = world.players[0]!;
    seat.techs.researched = [TechId.irrigation];
    seat.techs.active = {
      tech: TechId.millstones,
      ticksLeft: 300,
      abbey: 7,
      started: false,
    };
    seat.techs.festivalTicksLeft = 100;
    const base = hashWorld(world);
    expect(hashWorld(cloneWorld(world))).toBe(base);
    const mutations: ((p: PlayerState) => void)[] = [
      // Which tech, not how many.
      p => {
        p.techs.researched = [TechId.cobbledBoots];
      },
      // Every field of the study in hand...
      p => {
        p.techs.active!.tech = TechId.brewing;
      },
      p => {
        p.techs.active!.ticksLeft -= 1;
      },
      p => {
        p.techs.active!.abbey = 8;
      },
      p => {
        p.techs.active!.started = true;
      },
      // ...and whether there is one at all.
      p => {
        p.techs.active = undefined;
      },
      p => {
        p.techs.festivalTicksLeft = 0;
      },
      p => {
        p.pavingUnlocked = !p.pavingUnlocked;
      },
      // Fixed for the life of a world, but a save that dropped them comes
      // back a different match.
      p => {
        p.strategy = undefined;
      },
      p => {
        p.difficulty = undefined;
      },
      p => {
        p.kind = PlayerKind.human;
      },
    ];
    for (const mutate of mutations) {
      const w = cloneWorld(world);
      mutate(w.players[0]!);
      expect(hashWorld(w)).not.toBe(base);
    }
  });

  it('sees fractional building damage', () => {
    // An arrow against masonry lands at half strength (BUILDING_DAMAGE_MULT),
    // so building hp lives below the integer line too: a digest that
    // truncates it calls two walls the same until one falls a tick earlier.
    const world = createWorld({seed: 21, players: [{kind: PlayerKind.ai}]});
    run(world, 400);
    const base = hashWorld(world);
    const w = cloneWorld(world);
    const b = [...w.buildings.values()][0]!;
    // Only the fraction moves: a truncating digest sees the same wall.
    b.hp = Math.trunc(b.hp) + (b.hp % 1 < 0.5 ? 0.75 : 0.25);
    expect(hashWorld(w)).not.toBe(base);
  });

  it("sees a building's FIFO clocks, and who is keeping them", () => {
    // Neither moves a good or a unit: the stamp decides which demand a serf
    // answers first, and the marks decide whether the next matcher pass
    // keeps it or starts it over. A save that dropped either would play on
    // as the same world until two hauls went out in a different order.
    const world = createWorld({seed: 21, players: [{kind: PlayerKind.ai}]});
    run(world, 400);
    const b = [...world.buildings.values()][0]!;
    b.demandSince[GoodId.wood] = 100;
    b.demandHeld = {...b.demandHeld, [GoodId.wood]: 1};
    const base = hashWorld(world);
    expect(hashWorld(cloneWorld(world))).toBe(base);
    const mutations: ((x: typeof b) => void)[] = [
      x => {
        x.demandSince[GoodId.wood] = 101;
      },
      // A stamp at tick 0 is not the same as no clock at all.
      x => {
        x.demandSince[GoodId.wood] = 0;
      },
      x => {
        delete x.demandSince[GoodId.wood];
      },
      x => {
        x.demandHeld![GoodId.wood] = 2;
      },
    ];
    for (const mutate of mutations) {
      const w = cloneWorld(world);
      mutate(w.buildings.get(b.id)!);
      expect(hashWorld(w)).not.toBe(base);
    }
  });
});
