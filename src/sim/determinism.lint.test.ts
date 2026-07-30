import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
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
const EXEMPT = new Set(['map.ts']);

function tsFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...tsFilesUnder(p));
    else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) out.push(p);
  }
  return out;
}

describe('determinism lint', () => {
  it('the runtime sim contains no engine-approximated math', () => {
    const simDir = join(import.meta.dirname, '.');
    const offenders: string[] = [];
    for (const file of tsFilesUnder(simDir)) {
      const base = file.split('/').pop()!;
      if (EXEMPT.has(base)) continue;
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (BANNED.test(line) && !line.trimStart().startsWith('*') && !line.trimStart().startsWith('//')) {
          offenders.push(`${file}:${i + 1}: ${line.trim()}`);
        }
      });
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });
});
