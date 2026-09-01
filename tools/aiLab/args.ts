/**
 * Whole-number command-line arguments for the lab's scripts, validated
 * rather than coerced.
 *
 * `Number('x')` is NaN and nothing downstream complains: `Array.from({length:
 * NaN})` is an empty array, so a typo'd count runs ZERO campaigns and the
 * script still prints its table — headed "NaN seeds", every rate 0.0%, every
 * verdict "no result". That reads like a measurement that came back
 * negative, which is the one failure mode a measuring instrument must not
 * have. A mistyped argument should stop the run, not answer it.
 *
 * Split in two so the rule can be tested: `intArg` decides and returns,
 * `intArgOrExit` is what a script calls and is the only half that touches
 * `process`.
 */

/**
 * The argument as a whole number at or above `min`, `fallback` when it was
 * not given at all, and `null` when it was given and is not one.
 *
 * Rejects NaN, decimals, Infinity and anything below `min`. Note that
 * `Number('')` is 0 and `Number(' 7 ')` is 7 — both are accepted, which is
 * the shell's own reading of them.
 */
export function intArg(
  raw: string | undefined,
  fallback: number,
  min: number,
): number | null {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n >= min ? n : null;
}

/** `intArg`, but a bad argument ends the process with the usage line. */
export function intArgOrExit(
  raw: string | undefined,
  fallback: number,
  name: string,
  min: number,
  usage: string,
): number {
  const n = intArg(raw, fallback, min);
  if (n === null) {
    console.error(
      `${name} must be a whole number >= ${min} (got ${JSON.stringify(raw)})\n` +
        `usage: ${usage}`,
    );
    process.exit(2);
  }
  return n;
}
