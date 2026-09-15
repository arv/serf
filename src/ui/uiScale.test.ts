import {describe, expect, it} from 'vitest';
import {NARROW, SHORT} from './breakpoints';

/**
 * The interface scale lives in index.html as a ladder of media queries,
 * because the division it needs — min(width / 1440, height / 900) — is one
 * CSS cannot do. This reads the ladder back out of the stylesheet and holds
 * it to what it promises: the HUD takes the same share of the screen on
 * every window a desktop comes in.
 */
const HTML = Object.values(
  import.meta.glob('/index.html', {
    query: '?raw',
    import: 'default',
    eager: true,
  }),
)[0] as string;

interface Rung {
  w: number;
  h: number;
  scale: number;
}

const RUNGS: Rung[] = [
  ...HTML.matchAll(
    /@media \(min-width: (\d+)px\) and \(min-height: (\d+)px\) \{\s*:root \{\s*--ui-scale: ([\d.]+);/g,
  ),
].map(m => ({w: Number(m[1]), h: Number(m[2]), scale: Number(m[3])}));

/** What the browser does with the ladder: the last rung that matches. */
function scaleFor(w: number, h: number): number {
  let s = 1;
  for (const r of RUNGS) if (w >= r.w && h >= r.h) s = r.scale;
  return s;
}

describe('the interface scale ladder', () => {
  it('is there to be read', () => {
    expect(RUNGS.length).toBeGreaterThan(10);
  });

  it('draws every rung at the design window times its scale', () => {
    // A rung is the question "does the 1440x900 design fit s times over?"
    // asked in the one form a media query can answer.
    for (const r of RUNGS) {
      expect(r.w, `rung ${r.scale}`).toBe(Math.round(1440 * r.scale));
      expect(r.h, `rung ${r.scale}`).toBe(Math.round(900 * r.scale));
    }
  });

  it('climbs, so the last match is the largest that fits', () => {
    for (let i = 1; i < RUNGS.length; i++)
      expect(RUNGS[i]!.scale).toBeGreaterThan(RUNGS[i - 1]!.scale);
  });

  it('gives the common desktops their exact share', () => {
    // At 100% system scaling, where a CSS pixel is a device pixel.
    expect(scaleFor(1440, 900)).toBe(1);
    expect(scaleFor(1920, 1080)).toBe(1.2);
    expect(scaleFor(2560, 1440)).toBe(1.6);
    expect(scaleFor(3840, 2160)).toBe(2.4);
    expect(scaleFor(5120, 2880)).toBe(3.2);
    expect(scaleFor(7680, 4320)).toBe(4.8);
  });

  it('never rounds a desktop down by more than a tenth of its share', () => {
    // The floor between rungs is the only error in the scheme. Sweep the
    // heights from the first rung to 8K (width is never the tighter side
    // here) and hold the gap between wanted and given to under 10%.
    for (let h = 990; h <= 4320; h += 7) {
      const wanted = h / 900;
      const given = scaleFor(1e5, h);
      expect(given, `${h}px tall`).toBeLessThanOrEqual(wanted + 1e-9);
      expect((wanted - given) / wanted, `${h}px tall`).toBeLessThan(0.1);
    }
  });

  it('leaves every phone at its drawn size', () => {
    // The phone layouts are pixels written for 1:1. A window either phone
    // breakpoint can match must never reach the first rung.
    const narrow = Number(/(\d+)px/.exec(NARROW)![1]);
    const short = Number(/(\d+)px/.exec(SHORT)![1]);
    expect(scaleFor(narrow, 1e5)).toBe(1);
    expect(scaleFor(1e5, short)).toBe(1);
  });
});
