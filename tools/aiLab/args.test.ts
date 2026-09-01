import {describe, expect, it} from 'vitest';
import {intArg} from './args.ts';
import {splitArgs} from './balance.ts';

/**
 * The balance sweep's command line, which is two positional arguments and
 * one optional flag — and which got that wrong in a way nothing caught.
 *
 * `indexOf` answers -1 for a flag that is not there, and the code that
 * lifted `--difficulty <tier>` out of the positional list subtracted
 * nothing from that: `-1 + 1` is 0, so it dropped argument ZERO whenever
 * the flag was absent. `balance.ts 32 1000` ran a THOUSAND seeds from the
 * default range, which is both the wrong sweep and roughly thirty times
 * the intended bill — and the invocation it broke is the one README.md
 * insists on, the second seed range, so the standing advice to believe a
 * result only after re-running it elsewhere had been quietly re-running
 * the first range twice.
 *
 * Cheap to hold, so it is held: the whole point of a measuring instrument
 * is that you can trust what it says it measured.
 */
describe('the balance sweep’s arguments', () => {
  it('keeps both positionals when no flag is given', () => {
    expect(splitArgs(['32', '1000'])).toEqual({
      positional: ['32', '1000'],
      tierRaw: undefined,
      named: false,
    });
    expect(splitArgs([]).positional).toEqual([]);
    expect(splitArgs(['32']).positional).toEqual(['32']);
  });

  it('lifts the flag and its value out, wherever they sit', () => {
    expect(splitArgs(['32', '1000', '--difficulty', 'hard'])).toEqual({
      positional: ['32', '1000'],
      tierRaw: 'hard',
      named: true,
    });
    // Before the positionals, which is just as legal on a command line.
    expect(splitArgs(['--difficulty', 'easy', '32', '1000'])).toEqual({
      positional: ['32', '1000'],
      tierRaw: 'easy',
      named: true,
    });
    // Between them, which is where it is easiest to get wrong.
    expect(
      splitArgs(['32', '--difficulty', 'easy', '1000']).positional,
    ).toEqual(['32', '1000']);
  });

  it('reports a flag with no value rather than eating a positional', () => {
    // `named` is what tells the caller to reject this; the value is
    // undefined and no argument was silently consumed in its place.
    expect(splitArgs(['32', '--difficulty'])).toEqual({
      positional: ['32'],
      tierRaw: undefined,
      named: true,
    });
  });

  it('drops any other flag from the positionals', () => {
    expect(splitArgs(['32', '--verbose', '1000']).positional).toEqual([
      '32',
      '1000',
    ]);
  });
});

/**
 * And the numbers themselves, which have the same shape of failure one
 * level down: `Number('x')` is NaN, `Array.from({length: NaN})` is empty,
 * and a script handed a typo runs nothing while still printing its table —
 * "NaN seeds", 0.0%, "no result" on every row. A reader cannot tell that
 * from a real negative result, which is the whole problem.
 *
 * `balance.ts` validated from the start; `tiers.ts` did not, and shipped a
 * measuring instrument that answered mistyped questions. They share one
 * check now, and this is it.
 */
describe('whole-number arguments', () => {
  it('takes the fallback only when the argument is absent', () => {
    expect(intArg(undefined, 32, 1)).toBe(32);
    // Present but wrong is NOT the fallback — that would hide the typo.
    expect(intArg('x', 32, 1)).toBeNull();
  });

  it('rejects what Number() would quietly accept', () => {
    expect(intArg('x', 32, 1)).toBeNull();
    expect(intArg('12.5', 32, 1)).toBeNull();
    expect(intArg('Infinity', 32, 1)).toBeNull();
    expect(intArg('', 32, 1)).toBeNull(); // Number('') is 0, below min 1.
  });

  it('holds the floor, which differs by argument', () => {
    // A count of zero duels is a mistake; an offset of zero is a seed.
    expect(intArg('0', 32, 1)).toBeNull();
    expect(intArg('0', 101, 0)).toBe(0);
    expect(intArg('-1', 101, 0)).toBeNull();
  });

  it('accepts a plain count', () => {
    expect(intArg('24', 32, 1)).toBe(24);
    expect(intArg('1000', 101, 0)).toBe(1000);
  });
});
