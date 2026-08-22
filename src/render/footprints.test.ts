import { describe, expect, it } from 'vitest';
import { FootprintPlanner, MAX_PRINTS_PER_STEP, STRIDE } from './footprints';

interface Print {
  x: number;
  y: number;
  yaw: number;
  side: number;
}

/** Feed one publish worth of positions and collect what got stamped. */
function pass(
  planner: FootprintPlanner,
  units: readonly (readonly [number, number, number])[],
): Print[] {
  const out: Print[] = [];
  planner.begin();
  for (const [id, x, y] of units) {
    planner.advance(id, x, y, (x2, y2, yaw, side) => out.push({ x: x2, y: y2, yaw, side }));
  }
  planner.sweep();
  return out;
}

describe('footprint planner', () => {
  it('treats first sighting as a position, not a footfall', () => {
    const planner = new FootprintPlanner();
    expect(pass(planner, [[1, 10, 10]])).toHaveLength(0);
  });

  it('stamps one print per stride, feet alternating across the line', () => {
    const planner = new FootprintPlanner();
    pass(planner, [[1, 10, 10]]);
    // March east far enough for exactly three strides.
    const prints = pass(planner, [[1, 10 + STRIDE * 3.2, 10]]);
    expect(prints).toHaveLength(3);
    for (const [k, p] of prints.entries()) expect(p.x).toBeCloseTo(10 + STRIDE * (k + 1));
    expect(prints.map((p) => p.side)).toEqual([1, -1, 1]);
    // Heading east: the same yaw convention the unit models turn by.
    for (const p of prints) expect(p.yaw).toBeCloseTo(Math.atan2(1, 0));
  });

  it('lets a fighter shuffle in place without stamping', () => {
    const planner = new FootprintPlanner();
    pass(planner, [[1, 10, 10]]);
    for (let k = 0; k < 20; k++) {
      expect(pass(planner, [[1, 10 + (k % 2) * 0.1, 10]])).toHaveLength(0);
    }
  });

  it('goes sparse on a long hop instead of carpeting it', () => {
    const planner = new FootprintPlanner();
    pass(planner, [[1, 10, 10]]);
    // Fast game speed: many strides of ground in a single publish.
    const prints = pass(planner, [[1, 10, 10 + STRIDE * 20]]);
    expect(prints).toHaveLength(MAX_PRINTS_PER_STEP);
    // The prints that do land trail right up to where the unit now stands.
    expect(prints.at(-1)!.y).toBeCloseTo(10 + STRIDE * 20);
  });

  it('shadows fogged marchers: no prints, and strides restart from there', () => {
    const planner = new FootprintPlanner();
    pass(planner, [[1, 10, 10]]);
    // Crosses the dark without a mark...
    planner.begin();
    planner.shadow(1, 20, 10);
    planner.sweep();
    // ...and emerging a half-stride later still isn't a footfall.
    expect(pass(planner, [[1, 20 + STRIDE / 2, 10]])).toHaveLength(0);
    expect(pass(planner, [[1, 20 + STRIDE * 1.5, 10]])).toHaveLength(1);
  });

  it('forgets a unit that vanishes, so reappearing is a fresh sighting', () => {
    const planner = new FootprintPlanner();
    pass(planner, [[1, 10, 10]]);
    pass(planner, []); // died, despawned, or filtered out
    expect(pass(planner, [[1, 30, 30]])).toHaveLength(0);
  });
});
