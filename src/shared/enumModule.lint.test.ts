import {describe, expect, it} from 'vitest';

/**
 * A JS enum module only pays for itself if the bundler can inline its
 * members, and exactly one thing stops it: re-exporting the module as a
 * namespace.
 *
 * `export * as GoodId from './goodIdEnum.ts'` forces esbuild to
 * materialise a real namespace object — every member name kept as a
 * string, every value behind a getter — and every `GoodId.wood` in the
 * codebase becomes a property load on it rather than the literal 3.
 * Importing the enum module directly instead:
 *
 *     import * as GoodId from '../defs/goodIdEnum.ts';
 *     import type { Enum } from '../../shared/enum.ts';
 *     type GoodId = Enum<typeof GoodId>;
 *
 * ...leaves nothing at runtime at all. The difference measured 11 KB of
 * minified sim, and it is invisible in review, so it is a test.
 *
 * The home module still exports the *type* — that is erased and costs
 * nothing. It is only the value re-export that is banned.
 */
const SOURCES = import.meta.glob(['/src/**/*.ts', '/src/**/*.tsx'], {
  query: '?raw',
  import: 'default',
  eager: true,
});

function reExports(): string[] {
  const out: string[] = [];
  for (const [path, raw] of Object.entries(SOURCES)) {
    for (const m of (raw as string).matchAll(
      /^export \* as (\w+) from '([^']+)';$/gm,
    )) {
      if (/Enum(\.ts)?$/.test(m[2]!))
        out.push(`${path}: export * as ${m[1]} from '${m[2]}'`);
    }
  }
  return out;
}

describe('JS enum modules', () => {
  it('are never re-exported as a namespace — that defeats inlining', () => {
    expect(
      reExports(),
      'Import the enum module directly and declare `type X = Enum<typeof X>` locally',
    ).toEqual([]);
  });

  it('are imported directly, and there are plenty of them to get wrong', () => {
    const direct = Object.values(SOURCES).filter(raw =>
      /^import \* as \w+ from '[^']*Enum\.ts';$/m.test(raw as string),
    );
    expect(direct.length).toBeGreaterThan(50);
  });
});
