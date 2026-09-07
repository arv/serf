import {spawn} from 'node:child_process';
import type {MatchRecord} from './match.ts';

/**
 * Run one match in a child process, and settle exactly once whatever the
 * process does.
 *
 * Both the probe and the search fan out over a pool of these, and a lane
 * that never settles is a sweep that never ends. The first draft listened
 * for `close` alone, which is wrong in a way worth writing down, because
 * the obvious reading of it is wrong too:
 *
 * A failed spawn is NOT a hang. Node emits `error` and then `close` (code
 * -2 on ENOENT), so a close-only handler does resolve. What it does first
 * is *crash the whole run*: `error` on an EventEmitter with no listener is
 * an uncaught exception, so one bad worker path took the sweep down rather
 * than costing it one trial. Same for the stdin pipe — writing the task to
 * a child that never started emits EPIPE on a stream nobody is listening
 * to.
 *
 * So: an `error` handler, a swallowed stdin error, a kill that cannot
 * throw, and a timeout that settles on its own rather than trusting the
 * kill to produce a `close`. A trial that dies any of those deaths comes
 * back null and is scored as crashed, which is what the reports already
 * expect.
 */
export function runMatchChild(
  worker: string,
  task: unknown,
  timeoutMs: number,
): Promise<MatchRecord | null> {
  return new Promise<MatchRecord | null>(resolve => {
    const child = spawn(
      process.execPath,
      ['--experimental-strip-types', worker],
      {stdio: ['pipe', 'pipe', 'inherit']},
    );
    const chunks: Buffer[] = [];
    let settled = false;
    const settle = (record: MatchRecord | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(record);
    };
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // Already gone, or unkillable. Either way the lane is not waiting
        // on it any longer.
      }
      settle(null);
    }, timeoutMs);

    child.on('error', () => settle(null));
    // A dead child's pipe is a lost trial, never a crashed sweep.
    child.stdin.on('error', () => {});
    child.stdout.on('data', (c: Buffer) => chunks.push(c));
    child.on('close', code => {
      if (code !== 0) return settle(null);
      try {
        settle(
          JSON.parse(Buffer.concat(chunks).toString('utf8')) as MatchRecord,
        );
      } catch {
        settle(null);
      }
    });
    child.stdin.end(JSON.stringify(task));
  });
}
