import {describe, expect, it} from 'vitest';
import {AiSeats} from './aiSeats';
import * as DifficultyId from './defs/difficultyEnum.ts';
import type {Owner} from './entities.ts';
import * as PlayerKind from './playerKindEnum.ts';
import {deserializeWorld, serializeWorld} from './save.ts';
import {tickWorld} from './tick';
import {createWorld} from './world';

/**
 * The brains themselves are covered by ai.test.ts and winnable.test.ts.
 * What is covered here is the *wiring*: that seats declared 'ai' actually
 * get driven by whoever owns the world. Both hosts — the sim worker in
 * single player and the server in multiplayer — go through this class, so
 * a seat silently sitting idle is one assertion away.
 */
describe('AI seats', () => {
  it('drives every ai seat and leaves human seats alone', () => {
    const world = createWorld({
      seed: 3,
      players: [
        {kind: PlayerKind.human},
        {kind: PlayerKind.ai},
        {kind: PlayerKind.ai},
      ],
      adminEnabled: false,
    });
    const seats = new AiSeats(world);
    expect(seats.count).toBe(2);

    const issuers = new Set<number>();
    for (let t = 0; t < 400; t++) {
      const commands = seats.decide(world);
      for (const c of commands) issuers.add(c.playerId);
      tickWorld(world, commands);
    }
    expect([...issuers].sort((a, b) => a - b)).toEqual([1, 2]);
  });

  it('actually gets the AI building — the wiring is live, not just called', () => {
    const world = createWorld({
      seed: 3,
      players: [{kind: PlayerKind.human}, {kind: PlayerKind.ai}],
      adminEnabled: false,
      banditsEnabled: false,
    });
    const seats = new AiSeats(world);
    const countFor = (owner: number): number =>
      [...world.buildings.values()].filter(b => !b.dead && b.owner === owner)
        .length;
    const before = countFor(1);

    for (let t = 0; t < 3000; t++) tickWorld(world, seats.decide(world));

    expect(countFor(1)).toBeGreaterThan(before);
    // The human seat was never touched: it has only what it started with.
    expect(countFor(0)).toBe(1);
  });

  it('has no brains at all in a world of humans', () => {
    const world = createWorld({
      seed: 3,
      players: [{kind: PlayerKind.human}, {kind: PlayerKind.human}],
      adminEnabled: false,
    });
    const seats = new AiSeats(world);
    expect(seats.count).toBe(0);
    expect(seats.decide(world)).toEqual([]);
  });
});

/**
 * The difficulty tier's wiring, on the same principle as the seats above:
 * the tiers themselves are covered by defs/difficulty.test.ts, and what is
 * covered here is that the setting travels — config to world to seat to
 * brain — and survives the round trip a save makes.
 */
describe('AI seats at a difficulty', () => {
  it('deals the match tier onto every seat, letting a seat name its own', () => {
    const world = createWorld({
      seed: 3,
      difficulty: DifficultyId.hard,
      players: [
        {kind: PlayerKind.human},
        {kind: PlayerKind.ai},
        {kind: PlayerKind.ai, difficulty: DifficultyId.easy},
      ],
      adminEnabled: false,
    });
    expect(world.players.map(p => p.difficulty)).toEqual([
      DifficultyId.hard,
      DifficultyId.hard,
      DifficultyId.easy,
    ]);
    const seats = new AiSeats(world);
    expect(seats.brainFor(1)?.difficulty).toBe(DifficultyId.hard);
    expect(seats.brainFor(2)?.difficulty).toBe(DifficultyId.easy);
  });

  it('leaves a match that names no tier playing the printed game', () => {
    const world = createWorld({
      seed: 3,
      players: [{kind: PlayerKind.human}, {kind: PlayerKind.ai}],
      adminEnabled: false,
    });
    expect(world.players[1]!.difficulty).toBeUndefined();
    expect(new AiSeats(world).brainFor(1)?.difficulty).toBeUndefined();
  });

  it('faces the same opponents at the same tier across a save', () => {
    // The promise PlayerState.difficulty exists for: brains are rebuilt
    // from scratch on a reload, and an opponent that got easier across one
    // would be as much a bug as one that changed its opening.
    const world = createWorld({
      seed: 3,
      difficulty: DifficultyId.hard,
      players: [{kind: PlayerKind.human}, {kind: PlayerKind.ai}],
      adminEnabled: false,
    });
    const reloaded = deserializeWorld(serializeWorld(world));
    expect(new AiSeats(reloaded).brainFor(1)?.difficulty).toBe(
      DifficultyId.hard,
    );
  });

  it('plays a playbook handed in over the one the seat was dealt', () => {
    // The search seam. It is the BASE layer, not advice: a candidate has
    // to be measured with its moods and its tier intact, or a searched
    // winner arrives in the shipped game a different animal.
    const world = createWorld({
      seed: 3,
      players: [{kind: PlayerKind.human}, {kind: PlayerKind.ai}],
      adminEnabled: false,
    });
    const dealt = new AiSeats(world).brainFor(1)!.strategy;
    const handed = {...dealt, serfTarget: dealt.serfTarget + 6};
    const seats = new AiSeats(world, new Map([[1 as Owner, handed]]));
    expect(seats.brainFor(1)!.strategy.serfTarget).toBe(dealt.serfTarget + 6);
    // The opening rides by reference: a handed-in playbook is its lineage
    // plus knobs, never a rewrite of the build order.
    expect(seats.brainFor(1)!.strategy.build).toBe(dealt.build);
  });

  it('leaves a seat nobody named on its own printed line', () => {
    const world = createWorld({
      seed: 3,
      players: [{kind: PlayerKind.ai}, {kind: PlayerKind.ai}],
      adminEnabled: false,
    });
    const dealt = new AiSeats(world);
    const handed = new AiSeats(
      world,
      new Map([[1 as Owner, {...dealt.brainFor(1)!.strategy, serfTarget: 19}]]),
    );
    expect(handed.brainFor(0)!.strategy).toBe(dealt.brainFor(0)!.strategy);
  });

  it('thinks on a slower beat when the seat is easy', () => {
    // The lever asked for by name: an easy lord is not dumber, it is late.
    // Seat 1 stands in for both tiers so the stagger offset is held fixed.
    const world = createWorld({
      seed: 3,
      difficulty: DifficultyId.easy,
      players: [{kind: PlayerKind.human}, {kind: PlayerKind.ai}],
      adminEnabled: false,
    });
    const easy = new AiSeats(world).brainFor(1)!;
    const printed = new AiSeats(
      createWorld({
        seed: 3,
        players: [{kind: PlayerKind.human}, {kind: PlayerKind.ai}],
        adminEnabled: false,
      }),
    ).brainFor(1)!;
    const beats = (b: {shouldDecide(t: number): boolean}): number => {
      let n = 0;
      for (let t = 0; t < 400; t++) if (b.shouldDecide(t)) n++;
      return n;
    };
    expect(beats(easy)).toBe(beats(printed) / 2);
  });
});
