import {describe, expect, it} from 'vitest';
import {tileIdx} from '../shared/grid';
import type {PlayArea} from '../sim/map';
import {FogOfWar} from './fogOfWar';

/** Grid 8, play square [2, 6) — margin two tiles deep on every side. */
const AREA: PlayArea = {size: 8, play: 4};

/** An explored grid with just these tiles seen. */
function seeded(...tiles: [number, number][]): Uint8Array {
  const out = new Uint8Array(AREA.size * AREA.size);
  for (const [x, z] of tiles) out[tileIdx(x, z, AREA.size)] = 1;
  return out;
}

describe('fog margin', () => {
  it('leaves the scenery ring dark until the border beside it is seen', () => {
    const fog = new FogOfWar(0, AREA);
    // Nothing scouted: the ring is fogged like everything else. It used to
    // be held permanently lit, which framed an unexplored map as a dark
    // island inside bright scenery.
    expect(fog.exploredAt(0.5, 0.5)).toBe(false);
    expect(fog.exploredAt(7.5, 7.5)).toBe(false);
  });

  it('lights the ring outside a border that has been seen', () => {
    const fog = new FogOfWar(0, AREA);
    fog.seedExplored(seeded([2, 2]));
    // Both margin tiles diagonally out from the seen corner mirror it.
    expect(fog.exploredAt(0.5, 0.5)).toBe(true);
    expect(fog.exploredAt(1.5, 1.5)).toBe(true);
    // Straight out from it, too — clamping is per axis.
    expect(fog.exploredAt(0.5, 2.5)).toBe(true);
    expect(fog.exploredAt(2.5, 0.5)).toBe(true);
  });

  it('keeps the ring dark outside a border that has not been seen', () => {
    const fog = new FogOfWar(0, AREA);
    fog.seedExplored(seeded([2, 2]));
    // The far corner mirrors (5, 5), which nobody has scouted.
    expect(fog.exploredAt(7.5, 7.5)).toBe(false);
    expect(fog.exploredAt(6.5, 6.5)).toBe(false);
  });

  it('answers every query true while disabled', () => {
    const fog = new FogOfWar(0, AREA);
    fog.setEnabled(false);
    expect(fog.exploredAt(0.5, 0.5)).toBe(true);
    expect(fog.visibleAt(0.5, 0.5)).toBe(true);
    expect(fog.litAt(0.5, 0.5)).toBe(1);
  });
});
