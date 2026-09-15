import {describe, expect, it} from 'vitest';
import {NARROW, ROOMY, SHORT} from './breakpoints';

/** The one pixel figure in a single-condition query. */
function px(query: string, feature: string): number {
  const m = new RegExp(`${feature}[^\\d]*(\\d+(?:\\.\\d+)?)px`).exec(query);
  expect(m, `${feature} in ${query}`).not.toBeNull();
  return Number(m![1]);
}

/**
 * A stand-in for the browser's evaluation of exactly the query forms this
 * file uses: max-width / max-height (inclusive) and range syntax with a
 * strict `>`. Any other form fails loudly, so a breakpoint rewritten into
 * something this does not understand cannot pass by being misread.
 */
function matches(query: string, w: number, h: number): boolean {
  return query.split(/\s*,\s*/).some(one =>
    one.split(/\s+and\s+/).every(cond => {
      const c = cond.replace(/[()]/g, '').trim();
      let m = /^max-width:\s*([\d.]+)px$/.exec(c);
      if (m) return w <= Number(m[1]);
      m = /^max-height:\s*([\d.]+)px$/.exec(c);
      if (m) return h <= Number(m[1]);
      m = /^width\s*>\s*([\d.]+)px$/.exec(c);
      if (m) return w > Number(m[1]);
      m = /^height\s*>\s*([\d.]+)px$/.exec(c);
      if (m) return h > Number(m[1]);
      throw new Error(`unrecognised media condition: ${cond}`);
    }),
  );
}

describe('ROOMY', () => {
  it('is drawn on the same two lines as the phone breakpoints', () => {
    // One line per edge, stated once: a second number drawing the same
    // line is where the crack between them comes from.
    expect(px(ROOMY, 'width')).toBe(px(NARROW, 'max-width'));
    expect(px(ROOMY, 'height')).toBe(px(SHORT, 'max-height'));
  });

  it('leaves no window that is neither a phone nor roomy', () => {
    // A browser zoom makes CSS pixels fractional. Walk every edge case in
    // hundredths either side of both lines: each window must be exactly
    // one of the two, never both and never neither.
    const W = px(NARROW, 'max-width');
    const H = px(SHORT, 'max-height');
    const compact = `${NARROW}, ${SHORT}`;
    for (let dw = -1; dw <= 1; dw += 0.01) {
      for (let dh = -1; dh <= 1; dh += 0.25) {
        const w = W + dw;
        const h = H + dh;
        expect(
          matches(compact, w, h) !== matches(ROOMY, w, h),
          `${w.toFixed(2)}x${h.toFixed(2)}`,
        ).toBe(true);
      }
    }
    for (let dh = -1; dh <= 1; dh += 0.01) {
      const h = H + dh;
      expect(
        matches(compact, 1440, h) !== matches(ROOMY, 1440, h),
        `1440x${h.toFixed(2)}`,
      ).toBe(true);
    }
  });

  it('is true of a desktop and false of both phones', () => {
    expect(matches(ROOMY, 1440, 900)).toBe(true);
    expect(matches(ROOMY, 390, 844)).toBe(false); // upright
    expect(matches(ROOMY, 844, 390)).toBe(false); // sideways
  });
});
