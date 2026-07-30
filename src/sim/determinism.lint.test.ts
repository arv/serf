import { describe, expect, it } from 'vitest';

/**
 * Lockstep guard rail: the runtime sim must use only bit-exact math.
 * Math.hypot/pow/sin/cos/... are implementation-approximated per ECMA-262 —
 * two engines can disagree in the last ulp and a lockstep match desyncs.
 * Worldgen (map.ts) is exempt: in multiplayer the host generates the world
 * once and ships the blob, so its transcendentals never run mid-match.
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
