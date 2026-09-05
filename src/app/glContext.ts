/**
 * Asking for a WebGL context, and asking again a moment later.
 *
 * A refused context is not usually a verdict. Android Chrome kills the GPU
 * process under memory pressure and takes a second or two to stand a new
 * one up; iOS drops contexts when another tab wants one; and the handover
 * out of the menu asks for a fresh context in the same breath as the
 * backdrop gives its own back, which is the least patient moment in the
 * page's life. In every one of those cases the ask that failed would have
 * been granted a heartbeat later.
 *
 * The match used to answer this with a page reload — the error card went
 * up and the document came back a second and a half later to try again.
 * That works, and it is the most expensive way to wait: the bundle is
 * re-parsed, the models re-fetched, the worker rebuilt, and all of it on
 * the phone that has just told us it is short of memory. Asking again in
 * place costs nothing but the wait.
 *
 * Kept in its own module, away from the DOM, so the ladder can be tested
 * without a browser: what the caller does to get a context is its own
 * business (matchScreen.ts swaps in a clean canvas each time), and what is
 * here is only how long to wait and when to stop.
 */

/**
 * How long to wait before each further ask, in milliseconds — and, by its
 * length, how many further asks there are.
 *
 * The first is short because the common case is the handover above, where
 * the driver is a moment behind us rather than gone. The rest lengthen
 * because a GPU process that has actually died takes a second or two to
 * come back. Two point seven five seconds in total: long enough to cover
 * a restart, short enough that a player looking at a black screen has not
 * yet decided the game is broken.
 */
export const GL_RETRY_DELAYS: readonly number[] = [250, 750, 1750];

const sleep = (ms: number): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, ms));

/**
 * Call `open` until it returns without throwing, waiting between tries.
 *
 * `open` is handed the attempt number, zero-based: the first ask is the one
 * the caller would have made anyway, and everything after it is a retry
 * that may want to set itself up differently. The error that ends the last
 * attempt is the one that comes out, so the caller reports what the browser
 * actually said last rather than what it said first.
 *
 * An `open` that answers with a promise is awaited here, so a refusal it
 * rejects with is asked past like a thrown one. The match's own ask is
 * synchronous — three.js takes the context in its constructor — but a
 * helper that retried only half the ways a caller can fail is a trap laid
 * for the next one.
 *
 * `wait` is here for the tests; nothing else passes it.
 */
export async function openWithRetry<T>(
  open: (attempt: number) => T | Promise<T>,
  opts: {delays?: readonly number[]; wait?: (ms: number) => Promise<void>} = {},
): Promise<T> {
  const delays = opts.delays ?? GL_RETRY_DELAYS;
  const wait = opts.wait ?? sleep;
  for (let attempt = 0; ; attempt++) {
    try {
      // Awaited inside the try, not returned out of it: a promise handed
      // straight back is settled after this frame has gone, where the catch
      // below can no longer see it refuse.
      return await open(attempt);
    } catch (err) {
      const pause = delays[attempt];
      if (pause === undefined) throw err;
      await wait(pause);
    }
  }
}
