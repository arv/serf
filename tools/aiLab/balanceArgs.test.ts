import {describe, expect, it} from 'vitest';
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
