import {describe, expect, it} from 'vitest';
import * as CommandKind from './commandKindEnum.ts';
import {sanitizeCommand} from './commands.ts';
import * as GameEventKind from './gameEventKindEnum.ts';
import * as HeraldNote from './heraldNoteEnum.ts';
import {addStorehouse, bareWorld} from './testUtils.ts';
import {applyCommand} from './tick.ts';

/**
 * The herald command: a taunt with an address, logged like every order —
 * which is what lets a replay's heralds arrive exactly as they were sent.
 * Covered here: the wire screening (a socket frame is not a command until
 * sanitizeCommand says so) and the landing (an addressed heraldIncoming
 * event, and only for targets that can still read one).
 */

describe('the herald on the wire', () => {
  it('accepts the structured note and clamps the boast', () => {
    expect(
      sanitizeCommand({
        kind: CommandKind.herald,
        target: 1,
        note: HeraldNote.marchComing,
        count: 12,
      }),
    ).toEqual({
      kind: CommandKind.herald,
      target: 1,
      note: HeraldNote.marchComing,
      count: 12,
    });
    // A thousand-man boast prints as sixty-four; a garbled one is dropped
    // rather than guessed at.
    expect(
      sanitizeCommand({
        kind: CommandKind.herald,
        target: 1,
        note: HeraldNote.finalAssault,
        count: 1000,
      }),
    ).toMatchObject({count: 64});
    expect(
      sanitizeCommand({
        kind: CommandKind.herald,
        target: 1,
        note: HeraldNote.retribution,
        count: 'many',
      }),
    ).toEqual({
      kind: CommandKind.herald,
      target: 1,
      note: HeraldNote.retribution,
    });
  });

  it('refuses free text where a note id belongs', () => {
    expect(
      sanitizeCommand({kind: CommandKind.herald, target: 1, note: 'u r bad'}),
    ).toBeNull();
    expect(
      sanitizeCommand({kind: CommandKind.herald, target: -1, note: 1}),
    ).toBeNull();
  });
});

describe('the herald landing', () => {
  it('lands as an event addressed to the target', () => {
    const world = bareWorld(1, 2);
    addStorehouse(world, 10, 10, {});
    addStorehouse(world, 20, 10, {}, 1);
    applyCommand(world, 0, {
      kind: CommandKind.herald,
      target: 1,
      note: HeraldNote.marchComing,
      count: 7,
    });
    expect(world.pendingEvents).toEqual([
      {
        kind: GameEventKind.heraldIncoming,
        player: 1,
        attacker: 0,
        note: HeraldNote.marchComing,
        count: 7,
      },
    ]);
  });

  it('says nothing to the dead, and nothing to oneself', () => {
    const world = bareWorld(1, 2);
    addStorehouse(world, 10, 10, {});
    world.players[1]!.alive = false;
    applyCommand(world, 0, {
      kind: CommandKind.herald,
      target: 1,
      note: HeraldNote.marchComing,
    });
    applyCommand(world, 0, {
      kind: CommandKind.herald,
      target: 0,
      note: HeraldNote.marchComing,
    });
    expect(world.pendingEvents).toEqual([]);
  });
});
