import {describe, expect, it} from 'vitest';
import * as AiStrategyId from '../../src/sim/defs/aiStrategyIdEnum.ts';
import {intArg} from './args.ts';
import {MUTABLE_RANGES} from './mutate.ts';
import {byKey, parseKeys, parseSweep, valueOf} from './probe.ts';

/**
 * The probe's flags decide what a run MEASURES, so every one of these
 * failures is worse than a crash: each produces a plausible table of a
 * different experiment than the one that was asked for.
 */
describe('probe flags', () => {
  it('resolves a playbook by the key the reports print', () => {
    expect(byKey('mason')).toBe(AiStrategyId.mason);
    expect(byKey('steward')).toBe(AiStrategyId.steward);
    expect(() => byKey('masonn')).toThrow(/unknown playbook/);
  });

  it('refuses a flag written without a value', () => {
    expect(() => valueOf(['--keys'], '--keys')).toThrow(/wants a value/);
    expect(() => valueOf(['--keys', '--jobs'], '--keys')).toThrow(
      /wants a value/,
    );
    expect(valueOf(['--keys', 'serfTarget'], '--keys')).toBe('serfTarget');
    expect(valueOf(['--jobs', '4'], '--keys')).toBeNull();
  });

  describe('--keys', () => {
    const valid = ['serfTarget', 'houseLimit', 'researchReserve'];

    it('trims, because a space after a comma is not another knob', () => {
      expect([...parseKeys('serfTarget, houseLimit', valid)]).toEqual([
        'serfTarget',
        'houseLimit',
      ]);
    });

    it('refuses a knob it does not know', () => {
      // A typo narrows advice to nothing, so every candidate becomes the
      // identity and the whole run prints a clean-looking 50%.
      expect(() => parseKeys('serfTarge', valid)).toThrow(/does not know/);
    });

    it('refuses a list that selects nothing', () => {
      expect(() => parseKeys(' , ', valid)).toThrow(/selected nothing/);
    });
  });

  describe('--sweep', () => {
    it('reads a knob and its doses', () => {
      expect(parseSweep('serfTarget:11, 16', MUTABLE_RANGES)).toEqual({
        knob: 'serfTarget',
        values: [11, 16],
      });
    });

    it('refuses a knob no advice can name', () => {
      expect(() => parseSweep('serfTargets:11', MUTABLE_RANGES)).toThrow(
        /does not know/,
      );
    });

    it('refuses values that would vanish rather than sweep', () => {
      // `Number('')` is 0 and a NaN serializes to JSON null, which
      // parseAdvice drops — either way the "sweep" plays the parent
      // against itself and reports it as a dose.
      expect(() => parseSweep('serfTarget:', MUTABLE_RANGES)).toThrow(
        /empty value/,
      );
      expect(() => parseSweep('serfTarget:11,x', MUTABLE_RANGES)).toThrow(
        /integers/,
      );
      expect(() => parseSweep('serfTarget:11,,16', MUTABLE_RANGES)).toThrow(
        /empty value/,
      );
    });

    it('refuses a dose the knob would silently clamp', () => {
      // serfTarget is 6-20. A run asked for 25 plays 20 and prints 25.
      expect(() => parseSweep('serfTarget:25', MUTABLE_RANGES)).toThrow(
        /outside/,
      );
      expect(() => parseSweep('serfTarget:1', MUTABLE_RANGES)).toThrow(
        /outside/,
      );
    });

    it('wants the colon', () => {
      expect(() => parseSweep('serfTarget', MUTABLE_RANGES)).toThrow(
        /wants <knob>/,
      );
    });
  });
});

describe('--parent and --vs', () => {
  it('reads a playbook by the key the reports print', () => {
    expect(byKey('steward')).toBe(AiStrategyId.steward);
    expect(byKey('mason')).toBe(AiStrategyId.mason);
  });

  it('refuses a playbook it does not have', () => {
    // Silently falling back to the steward would run a completely
    // different experiment than the one asked for, and print the name
    // that was asked for at the top of it.
    expect(() => byKey('stewart')).toThrow(/unknown playbook/);
    expect(() => byKey('')).toThrow(/unknown playbook/);
  });
});

describe('numeric flags', () => {
  // The lab already had this rule and a file arguing for it (args.ts, used
  // by balance.ts and tiers.ts): a mistyped argument must stop the run,
  // not answer it. probe and evolve were coercing instead, so `--seeds x`
  // quietly played the default and printed a table nobody could tell from
  // the one they asked for.
  it('refuses a value that is not a whole number', () => {
    expect(intArg('x', 24, 1)).toBeNull();
    expect(intArg('1.5', 24, 1)).toBeNull();
    expect(intArg('0', 24, 1)).toBeNull();
    expect(intArg('80', 24, 1)).toBe(80);
    expect(intArg(undefined, 24, 1)).toBe(24);
  });

  it('allows zero where zero is meaningful', () => {
    // --mutants 0 is how a pure --sweep run is asked for.
    expect(intArg('0', 8, 0)).toBe(0);
  });
});
