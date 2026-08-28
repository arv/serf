import { describe, expect, it } from 'vitest';
import { describeAdvice } from './insight.ts';
import type { SeatKnobs } from './summary.ts';
import * as UnitTypeId from '../sim/defs/unitTypeIdEnum.ts';

/**
 * The humanizer is judged the way the prompt is: a reader who knows
 * nothing about ticks or recipe indices gets the whole story, and the
 * playbook delta appears exactly when the advice moved a dial off its
 * printed value.
 */

const playbook: SeatKnobs = {
  serfTarget: 8,
  armyAttackSize: 6,
  attackCooldown: 600,
  homeGuard: 0,
  prefersRivals: false,
  trainPreference: [UnitTypeId.spearman, UnitTypeId.archer],
  weaponMix: [0, 2],
  barracksQueueDepth: 2,
  houseLimit: 3,
  housingHeadroom: 2,
  researchReserve: 5,
  // The march gate ships off in every playbook (sim/combatOdds.ts), so a
  // fixture standing in for a printed line holds it there too.
  marchConfidence: 0,
};

describe('describeAdvice', () => {
  it('translates every knob into English, units included', () => {
    const lines = describeAdvice(
      {
        serfTarget: 11,
        armyAttackSize: 10,
        attackCooldown: 700,
        homeGuard: 10,
        prefersRivals: true,
        trainPreference: [UnitTypeId.archer],
        weaponMix: [2],
        barracksQueueDepth: 3,
        houseLimit: 4,
        housingHeadroom: 3,
        researchReserve: 8,
        reason: 'not a knob — never a line',
      },
      playbook,
    );
    expect(lines.map((l) => l.text)).toEqual([
      'serfs: hire toward 11 (playbook 8)',
      'army: march at 10 soldiers (playbook 6)',
      'marches: every 35s (playbook 30s)',
      'home guard: recall within 10 tiles (playbook never)',
      'targets: hold out for rival castles (playbook nearest)',
      'training: archer (playbook spearman > archer)',
      'forges: bow (playbook spear, bow)',
      'barracks queue: 3 deep (playbook 2)',
      'houses: up to 4 (playbook 3)',
      'housing headroom: 3 beds (playbook 2)',
      'research reserve: 8 silver (playbook 5)',
    ]);
    expect(lines.every((l) => l.moved)).toBe(true);
  });

  it('tells a real change from an echo of the print', () => {
    const lines = describeAdvice({ armyAttackSize: 6, homeGuard: 12 }, playbook);
    expect(lines).toEqual([
      // Restating the playbook's own 6 is not a change, and says so.
      { text: 'army: march at 6 soldiers', moved: false },
      { text: 'home guard: recall within 12 tiles (playbook never)', moved: true },
    ]);
  });

  it('reads fine with no playbook to compare against — every line counts as a move', () => {
    expect(describeAdvice({ attackCooldown: 400, homeGuard: 0 })).toEqual([
      { text: 'marches: every 20s', moved: true },
      { text: 'home guard: never recall', moved: true },
    ]);
    expect(describeAdvice({})).toEqual([]);
  });
});
