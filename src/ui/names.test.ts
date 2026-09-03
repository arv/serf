import {describe, expect, it} from 'vitest';
import type {PlayerSnap} from '../protocol/messages';
import * as AiStrategyId from '../sim/defs/aiStrategyIdEnum.ts';
import {BANDIT} from '../sim/entities';
import * as PlayerKind from '../sim/playerKindEnum.ts';
import {seatName} from './names';

/** A seat's block, with only what a name is read from. */
function seat(id: number, strategy?: PlayerSnap['strategy']): PlayerSnap {
  return {
    id,
    kind: strategy === undefined ? PlayerKind.human : PlayerKind.ai,
    alive: true,
    ...(strategy !== undefined ? {strategy} : {}),
    stock: {},
    toolWants: {},
    techs: {
      researched: [],
      festivalTicksLeft: 0,
      pavingUnlocked: false,
      hasAbbey: false,
    },
    pop: 0,
    popCap: 0,
  };
}

describe('seatName', () => {
  it('names a computer seat by its playbook and a person by number', () => {
    const players = [seat(0), seat(1, AiStrategyId.abbot)];
    expect(seatName(0, players)).toBe('Player 1');
    expect(seatName(1, players)).toBe('The Abbot');
    expect(seatName(BANDIT, players)).toBe('Bandits');
  });

  it('tells two seats dealt the same playbook apart by seat', () => {
    // ?bots=abbot,abbot — the name alone would point at both villages.
    const players = [
      seat(0),
      seat(1, AiStrategyId.abbot),
      seat(2, AiStrategyId.abbot),
      seat(3, AiStrategyId.warlord),
    ];
    expect(seatName(1, players)).toBe('The Abbot (seat 2)');
    expect(seatName(2, players)).toBe('The Abbot (seat 3)');
    // The one Warlord needs no such help.
    expect(seatName(3, players)).toBe('The Warlord');
  });
});
