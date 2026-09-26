import {describe, expect, it} from 'vitest';
import {INK_RING, chunkyButton} from './woodStyle';

describe('the ink ring', () => {
  const shadows = INK_RING.split(',\n');

  it('is 24 shadows, a quarter turn every six', () => {
    expect(shadows).toHaveLength(24);
    expect(shadows[0]?.trim()).toBe(
      'calc(var(--ring) * 1) calc(var(--ring) * 0) 0 var(--ink)',
    );
    expect(shadows[6]?.trim()).toBe(
      'calc(var(--ring) * 0) calc(var(--ring) * 1) 0 var(--ink)',
    );
  });

  it('never writes a -0 or a long float', () => {
    for (const s of shadows) {
      expect(s).not.toMatch(/\* -0[ )]/);
      expect(s).not.toMatch(/\d\.\d{4}/);
    }
  });
});

describe('a chunky button', () => {
  const css = chunkyButton('#a .go, #a .back');

  it('writes every state for every selector in the list', () => {
    expect(css).toContain('#a .go, #a .back {');
    for (const state of [
      ':hover:not(:disabled)',
      ':active:not(:disabled)',
      ':disabled',
    ]) {
      expect(css).toContain(`#a .go${state}, #a .back${state}`);
    }
  });

  it('leaves no selector to forgiving :is() parsing', () => {
    expect(css).not.toContain(':is(');
  });

  it('stills its press for reduced motion', () => {
    expect(css).toMatch(
      /prefers-reduced-motion: reduce\) \{\s*#a \.go, #a \.back \{ transition: none; \}/,
    );
  });
});
