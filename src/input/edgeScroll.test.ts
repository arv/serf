import { describe, expect, it } from 'vitest';
import { EdgeScroll, edgePush, EDGE_BAND_PX, EDGE_FULL_PX, EDGE_LATCH_S } from './edgeScroll';

/** A comfortable desktop window: both axes wide enough to have edges. */
const W = 1600;
const H = 900;

describe('edgePush', () => {
  it('says nothing about a pointer in the middle', () => {
    expect(edgePush(W / 2, H / 2, W, H)).toBeNull();
  });

  it('pushes toward the edge the pointer is nearing', () => {
    expect(edgePush(2, H / 2, W, H)).toEqual({ x: -1, z: 0 });
    expect(edgePush(W - 3, H / 2, W, H)).toEqual({ x: 1, z: 0 });
    expect(edgePush(W / 2, 2, W, H)).toEqual({ x: 0, z: -1 });
    expect(edgePush(W / 2, H - 3, W, H)).toEqual({ x: 0, z: 1 });
  });

  it('runs at full speed well before the screen edge', () => {
    // The whole point: nothing is gained by going the last few pixels, so
    // nobody does, so the macOS menu bar stays up where it belongs.
    expect(edgePush(EDGE_FULL_PX, H / 2, W, H)?.x).toBe(-1);
    expect(edgePush(0, H / 2, W, H)?.x).toBe(-1);
  });

  it('ramps in between, and is silent outside the band', () => {
    const mid = (EDGE_FULL_PX + EDGE_BAND_PX) / 2;
    expect(edgePush(mid, H / 2, W, H)?.x).toBeCloseTo(-0.5, 5);
    expect(edgePush(EDGE_BAND_PX, H / 2, W, H)).toBeNull();
    expect(edgePush(EDGE_BAND_PX + 1, H / 2, W, H)).toBeNull();
  });

  it('pushes both ways at once in a corner', () => {
    expect(edgePush(1, 1, W, H)).toEqual({ x: -1, z: -1 });
  });

  it('goes quiet on an axis with no room for two bands and a middle', () => {
    // Otherwise every position sits in both bands and the camera creeps on
    // whatever the two sides fail to cancel.
    const narrow = 2 * EDGE_BAND_PX;
    expect(edgePush(narrow / 2, H / 2, narrow, H)).toBeNull();
    expect(edgePush(1, H / 2, narrow, H)).toBeNull();
    // The other axis still works: only the cramped one goes quiet.
    expect(edgePush(narrow / 2, 1, narrow, H)).toEqual({ x: 0, z: -1 });
  });
});

describe('EdgeScroll', () => {
  it('keeps pushing while the pointer rests in the band', () => {
    const edge = new EdgeScroll();
    edge.moved(1, H / 2, W, H);
    // A parked cursor sends no further moves. Several seconds of frames —
    // far past the latch — must not quietly stop scrolling under a player
    // who is still asking for it.
    for (let t = 0; t < 5; t += 0.1) expect(edge.tick(0.1)).toEqual({ x: -1, z: 0 });
  });

  it('drops the push as soon as the pointer moves off the band', () => {
    const edge = new EdgeScroll();
    edge.moved(1, H / 2, W, H);
    edge.moved(W / 2, H / 2, W, H);
    expect(edge.tick(0.016)).toBeNull();
  });

  it('carries a push past the pointer that left through it', () => {
    const edge = new EdgeScroll();
    edge.moved(1, H / 2, W, H);
    edge.left(); // the menu bar slid down and took the cursor with it
    expect(edge.tick(EDGE_LATCH_S / 2)).toEqual({ x: -1, z: 0 });
    expect(edge.tick(EDGE_LATCH_S / 2)).toBeNull();
  });

  it('lets a returning pointer cancel the latch', () => {
    const edge = new EdgeScroll();
    edge.moved(1, H / 2, W, H);
    edge.left();
    edge.tick(EDGE_LATCH_S * 0.9);
    edge.moved(1, H / 2, W, H); // back on the page, still in the band
    // The clock is off again, not merely reset: the pointer is present.
    for (let t = 0; t < 3; t += 0.5) expect(edge.tick(0.5)).toEqual({ x: -1, z: 0 });
  });

  it('does not invent a direction for a pointer that was not pushing', () => {
    const edge = new EdgeScroll();
    edge.moved(W / 2, H / 2, W, H);
    edge.left();
    expect(edge.tick(0.016)).toBeNull();
  });

  it('stops dead when something else takes the camera', () => {
    const edge = new EdgeScroll();
    edge.moved(1, H / 2, W, H);
    edge.clear(); // focus lost, tab hidden, the switch turned off
    expect(edge.tick(0.016)).toBeNull();
  });

  it('stays out of the way while blocked', () => {
    const edge = new EdgeScroll();
    edge.moved(1, H / 2, W, H, true);
    expect(edge.tick(0.016)).toBeNull();
    // And a blocked pointer at the edge has no push to latch on the way out.
    edge.left();
    expect(edge.tick(0.016)).toBeNull();
  });
});
