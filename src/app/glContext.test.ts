import {describe, expect, it} from 'vitest';
import {GL_RETRY_DELAYS, openWithRetry} from './glContext';

/**
 * The retry ladder the match's WebGL context is asked for on. What matters
 * about it is what a phone with a restarting GPU process sees: that a
 * refusal is asked past rather than reported, that the asking stops, and
 * that what comes out at the end is the browser's last word rather than its
 * first.
 *
 * The waits are injected — the real ones are seconds long, and no test
 * should spend them.
 */
describe('openWithRetry', () => {
  /** A wait that records rather than waits. */
  function fakeWait(): {waits: number[]; wait: (ms: number) => Promise<void>} {
    const waits: number[] = [];
    return {
      waits,
      wait: (ms: number) => {
        waits.push(ms);
        return Promise.resolve();
      },
    };
  }

  it('asks once when the first ask is granted', async () => {
    const {waits, wait} = fakeWait();
    const attempts: number[] = [];
    const got = await openWithRetry(
      n => {
        attempts.push(n);
        return 'context';
      },
      {wait},
    );
    expect(got).toBe('context');
    expect(attempts).toEqual([0]);
    expect(waits).toEqual([]);
  });

  it('asks again after a refusal, and gives the caller the attempt number', async () => {
    const {waits, wait} = fakeWait();
    const attempts: number[] = [];
    const got = await openWithRetry(
      n => {
        attempts.push(n);
        if (n < 2) throw new Error('refused');
        return 'context';
      },
      {delays: [10, 20, 30], wait},
    );
    expect(got).toBe('context');
    expect(attempts).toEqual([0, 1, 2]);
    // Waited before each further ask, and not after the one that worked.
    expect(waits).toEqual([10, 20]);
  });

  it('stops at the end of the ladder and throws the last refusal', async () => {
    const {waits, wait} = fakeWait();
    let asks = 0;
    await expect(
      openWithRetry(
        () => {
          asks++;
          throw new Error(`refused ${asks}`);
        },
        {delays: [10, 20], wait},
      ),
    ).rejects.toThrow('refused 3');
    // One ask, then one per delay.
    expect(asks).toBe(3);
    expect(waits).toEqual([10, 20]);
  });

  it('asks past a promise that rejects, not only a throw', async () => {
    const {waits, wait} = fakeWait();
    const attempts: number[] = [];
    const got = await openWithRetry(
      async n => {
        attempts.push(n);
        if (n < 1) throw new Error('refused');
        return 'context';
      },
      {delays: [10, 20], wait},
    );
    // Unwrapped, too: the value comes back rather than a promise of one.
    expect(got).toBe('context');
    expect(attempts).toEqual([0, 1]);
    expect(waits).toEqual([10]);
  });

  it('waits a few seconds in total — long enough for a GPU process to come back, short enough to sit through', () => {
    const total = GL_RETRY_DELAYS.reduce((a, b) => a + b, 0);
    expect(GL_RETRY_DELAYS.length).toBeGreaterThan(0);
    expect(total).toBeGreaterThanOrEqual(2000);
    expect(total).toBeLessThanOrEqual(4000);
  });
});
