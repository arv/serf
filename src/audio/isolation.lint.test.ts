import {describe, expect, it} from 'vitest';

/**
 * The audio layer's two structural rules, made executable:
 *
 *  - src/audio never imports three or the sim. Type-only imports are fine
 *    (they erase), which is how animCues borrows AnimKey without dragging
 *    a renderer module — and three itself — into the node test env.
 *  - src/sim never imports audio. The sim is a deterministic machine in a
 *    worker; presentation flows *from* it, never into it. The determinism
 *    lint already bans the maths; this bans the dependency.
 */

const AUDIO = import.meta.glob('./**/*.ts', {
  query: '?raw',
  import: 'default',
  eager: true,
});
const SIM = import.meta.glob('../sim/**/*.ts', {
  query: '?raw',
  import: 'default',
  eager: true,
});

/** Value imports only: `import type { … } from` is erased at runtime. */
const IMPORT = /^\s*import\s+(?!type\s)[^;]*?from\s+['"]([^'"]+)['"]/gm;

function valueImports(raw: string): string[] {
  return [...raw.matchAll(IMPORT)].map(m => m[1]!);
}

describe('audio isolation lint', () => {
  it('src/audio imports neither three nor the sim', () => {
    const offenders: string[] = [];
    for (const [path, raw] of Object.entries(AUDIO)) {
      if (path.endsWith('.test.ts')) continue;
      for (const spec of valueImports(raw as string)) {
        if (
          spec === 'three' ||
          spec.startsWith('three/') ||
          spec.includes('/sim/')
        ) {
          offenders.push(`${path}: ${spec}`);
        }
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('src/sim does not know audio exists', () => {
    const offenders: string[] = [];
    for (const [path, raw] of Object.entries(SIM)) {
      for (const spec of valueImports(raw as string)) {
        if (spec.includes('/audio/')) offenders.push(`${path}: ${spec}`);
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });
});
