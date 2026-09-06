import {describe, expect, it} from 'vitest';
import * as AiStrategyId from '../sim/defs/aiStrategyIdEnum.ts';
import * as UnitTypeId from '../sim/defs/unitTypeIdEnum.ts';
import {FIGURE_LOREKEEPER} from './characters';
import {DEFAULT_FIGURE, figureForStrategy} from './statue';

/**
 * The point of the monument is that a rival can see whose it is from across
 * the valley, so two playbooks must never raise the same likeness.
 */
describe('a seat’s monument figure', () => {
  const ALL = [
    AiStrategyId.steward,
    AiStrategyId.warlord,
    AiStrategyId.abbot,
    AiStrategyId.fletcher,
    AiStrategyId.mason,
  ];

  it('gives every playbook one', () => {
    for (const id of ALL) expect(figureForStrategy(id)).toBeDefined();
  });

  it('gives no two playbooks the same one', () => {
    const seen = ALL.map(id => {
      const f = figureForStrategy(id);
      return `${f.kind}:${f.pose.clip}:${f.pose.phase}:${f.pose.load}`;
    });
    expect(new Set(seen).size).toBe(ALL.length);
  });

  it('dresses each in the body its playbook is named for', () => {
    expect(figureForStrategy(AiStrategyId.warlord).kind).toBe(
      UnitTypeId.knight,
    );
    expect(figureForStrategy(AiStrategyId.fletcher).kind).toBe(
      UnitTypeId.archer,
    );
    expect(figureForStrategy(AiStrategyId.steward).kind).toBe(
      UnitTypeId.worker,
    );
    expect(figureForStrategy(AiStrategyId.mason).kind).toBe(UnitTypeId.serf);
    // No unit wears the Lorekeeper; he is addressed by a figure key.
    expect(figureForStrategy(AiStrategyId.abbot).kind).toBe(FIGURE_LOREKEEPER);
  });

  it('gives the human seat the serf', () => {
    // A human has no playbook, and their own monument should not change
    // shape because of who else was dealt in.
    expect(figureForStrategy(undefined)).toBe(DEFAULT_FIGURE);
    expect(figureForStrategy(undefined).kind).toBe(UnitTypeId.serf);
  });

  it('falls back rather than throwing on a playbook it does not know', () => {
    expect(figureForStrategy(999)).toBe(DEFAULT_FIGURE);
  });
});
