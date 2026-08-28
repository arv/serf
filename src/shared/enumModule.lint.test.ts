import { describe, expect, it } from 'vitest';

/**
 * The one mistake a JS enum module lets you make that the type checker does
 * not catch.
 *
 * A home module publishes its enum with `export * as X from './xEnum.ts'`.
 * That is an export and nothing else: it puts no binding named `X` in the
 * module's own scope. TypeScript resolves `X.member` inside that file
 * anyway — it reads the export map — so the file compiles clean and then
 * throws `ReferenceError: X is not defined` the moment it is loaded. It
 * cost a full test suite once; this is the guard, since tsc will not be.
 *
 * The rule: inside the home module, reach the members through the local
 * `import * as XNs` (or a short alias of it), never through the exported
 * name.
 */
const SOURCES = import.meta.glob(['/src/**/*.ts', '/src/**/*.tsx'], {
  query: '?raw',
  import: 'default',
  eager: true,
});

interface Offence {
  file: string;
  name: string;
  line: number;
  text: string;
}

function offences(): Offence[] {
  const out: Offence[] = [];
  for (const [path, raw] of Object.entries(SOURCES)) {
    const src = raw as string;
    const exported = [...src.matchAll(/^export \* as (\w+) from /gm)].map((m) => m[1]!);
    if (exported.length === 0) continue;
    const lines = src.split('\n');
    for (const name of exported) {
      // A local binding of the same name would make it legal again.
      if (new RegExp(`^import \\* as ${name} from `, 'm').test(src)) continue;
      const use = new RegExp(`(^|[^\\w.'"\`])${name}\\.\\w`);
      lines.forEach((line, i) => {
        if (line.startsWith('export * as ') || line.startsWith('import ')) return;
        if (use.test(line)) out.push({ file: path, name, line: i + 1, text: line.trim() });
      });
    }
  }
  return out;
}

describe('JS enum modules', () => {
  it('never reach their own members through the name they export', () => {
    expect(
      offences().map((o) => `${o.file}:${o.line} (${o.name}) ${o.text}`),
      'An `export * as X` binds nothing locally — use the `import * as XNs` alias inside the file',
    ).toEqual([]);
  });

  it('is watching real enum modules (the glob still finds them)', () => {
    const homes = Object.entries(SOURCES).filter(([, raw]) =>
      /^export \* as \w+ from '\.\/\w+Enum\.ts';$/m.test(raw as string),
    );
    expect(homes.length).toBeGreaterThan(2);
  });
});
