import { describe, expect, it } from 'vitest';

/**
 * The runtime sim uses only bit-exact math. Math.hypot/pow/sin/cos/... are
 * implementation-approximated per ECMA-262, so two engines can disagree in
 * the last ulp.
 *
 * That used to be a hard requirement: under lockstep every client simulated,
 * and one ulp of disagreement desynced the match. One machine simulates now,
 * so it is no longer load-bearing for multiplayer — it is kept because it is
 * free and it still buys same-build reproducibility, which save/load
 * (save.test.ts resumes a run and expects the same world) and the AI
 * regression tests both lean on. Relax it if it ever blocks something real.
 *
 * Worldgen (map.ts) is exempt: it runs once, before any of that matters.
 */
const BANNED =
  /Math\.(hypot|pow|sin|cos|tan|atan2?|asin|acos|exp|log2?|log10|log1p|cbrt|sinh|cosh|tanh|random)\b|Date\.now|performance\.now/;
const EXEMPT = ['/map.ts'];

const SOURCES = import.meta.glob('./**/*.ts', { query: '?raw', import: 'default', eager: true });

describe('determinism lint', () => {
  it('the runtime sim contains no engine-approximated math', () => {
    const offenders: string[] = [];
    for (const [path, raw] of Object.entries(SOURCES)) {
      if (path.endsWith('.test.ts') || EXEMPT.some((e) => path.endsWith(e))) continue;
      (raw as string).split('\n').forEach((line, i) => {
        const t = line.trimStart();
        if (BANNED.test(line) && !t.startsWith('*') && !t.startsWith('//')) {
          offenders.push(`${path}:${i + 1}: ${line.trim()}`);
        }
      });
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });
});
