import {existsSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';
import {ICON_FILES, ICON_SIZES, channelFor, identityFor} from './appIdentity';
import {retitle} from './appIdentityPlugin';
import {decodePng} from './identity/png.ts';

describe('channelFor', () => {
  it('is stable only for the stable branch', () => {
    expect(channelFor('stable')).toBe('stable');
    expect(channelFor('main')).toBe('staging');
    expect(channelFor('claude/some-feature')).toBe('staging');
  });

  it('treats a checkout with no branch as staging', () => {
    expect(channelFor('unknown')).toBe('staging');
    expect(channelFor('')).toBe('staging');
  });
});

describe('identityFor', () => {
  it('names the stable build plainly', () => {
    const id = identityFor('stable');
    expect(id.title).toBe('Serf Valley');
    expect(id.manifest.name).toBe('Serf Valley');
    expect(id.manifest.short_name).toBe('Serf Valley');
  });

  it('marks the staging build in the title and both manifest names', () => {
    const id = identityFor('staging');
    expect(id.title).toContain('Staging');
    expect(id.manifest.name).toContain('Staging');
    expect(id.manifest.short_name).toContain('Staging');
  });

  it('keeps the manifest pointing at the icon files the plugin emits', () => {
    const {manifest} = identityFor('staging');
    const icons = manifest.icons as {src: string}[];
    const emitted = new Set(ICON_FILES.map(f => `/${f}`));
    for (const icon of icons) expect(emitted.has(icon.src)).toBe(true);
  });

  it.each(['stable', 'staging'] as const)(
    'has every icon file on disk for %s',
    channel => {
      const dir = fileURLToPath(
        new URL(`./identity/${channel}/`, import.meta.url),
      );
      for (const file of ICON_FILES)
        expect(existsSync(join(dir, file))).toBe(true);
    },
  );

  // The icons are generated (`pnpm icons`) and committed, so this is the
  // check that a bad bake cannot be committed silently. It catches the
  // failure the renderer is most exposed to: headless Chromium quietly
  // laying out at a size other than the one asked for, which yields a
  // plausible PNG of the wrong edge rather than an error.
  //
  // Not re-rendering in CI and diffing is a choice, not a limitation —
  // ubuntu-latest ships Chrome and the renderer reads CHROME_PATH. But the
  // bake is byte-identical only on one Chromium build, and this drawing is
  // mostly gradients, so a strict diff would fail on a runner rasterising
  // an edge differently rather than on anything being stale. Catching
  // "edited the SVG, forgot to re-bake" wants a tolerance-based image
  // comparison; this catches the wrong-size case without one.
  it.each(['stable', 'staging'] as const)(
    'has each committed %s icon at the size it is declared to be',
    channel => {
      const dir = fileURLToPath(
        new URL(`./identity/${channel}/`, import.meta.url),
      );
      for (const file of ICON_FILES) {
        const {width, height} = decodePng(readFileSync(join(dir, file)));
        expect({file, width, height}).toEqual({
          file,
          width: ICON_SIZES[file],
          height: ICON_SIZES[file],
        });
      }
    },
  );
});

describe('retitle', () => {
  it('replaces the title in place', () => {
    expect(
      retitle('<head><title>Serf Valley</title></head>', 'Serf Valley Staging'),
    ).toBe('<head><title>Serf Valley Staging</title></head>');
  });

  it('refuses a document with no title', () => {
    expect(() => retitle('<head></head>', 'x')).toThrow(/no <title>/);
  });
});
