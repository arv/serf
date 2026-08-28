import { describe, expect, it } from 'vitest';
import { AiSeats } from './aiSeats';
import { createWorld } from './world';
import { tickWorld } from './tick';
import * as PlayerKind from './playerKindEnum.ts';

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
      players: [{ kind: PlayerKind.human }, { kind: PlayerKind.ai }, { kind: PlayerKind.ai }],
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
    expect([...issuers].sort()).toEqual([1, 2]);
  });

  it('actually gets the AI building — the wiring is live, not just called', () => {
    const world = createWorld({
      seed: 3,
      players: [{ kind: PlayerKind.human }, { kind: PlayerKind.ai }],
      adminEnabled: false,
      banditsEnabled: false,
    });
    const seats = new AiSeats(world);
    const countFor = (owner: number): number =>
      [...world.buildings.values()].filter((b) => !b.dead && b.owner === owner).length;
    const before = countFor(1);

    for (let t = 0; t < 3000; t++) tickWorld(world, seats.decide(world));

    expect(countFor(1)).toBeGreaterThan(before);
    // The human seat was never touched: it has only what it started with.
    expect(countFor(0)).toBe(1);
  });

  it('has no brains at all in a world of humans', () => {
    const world = createWorld({
      seed: 3,
      players: [{ kind: PlayerKind.human }, { kind: PlayerKind.human }],
      adminEnabled: false,
    });
    const seats = new AiSeats(world);
    expect(seats.count).toBe(0);
    expect(seats.decide(world)).toEqual([]);
  });
});
