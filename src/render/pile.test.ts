import * as THREE from 'three';
import {describe, expect, it, vi} from 'vitest';
import * as GoodId from '../sim/defs/goodIdEnum.ts';
import {laneCap, makeTieredPile, pileChunks} from './models';

// The pack's models stood in for by boxes of their real proportions (model
// units, as the Resource Bits files measure), each named by its prop so a
// pile can be read back as the bundles it was laid from.
const SIZES: Record<string, [number, number, number]> = {
  Wood_Plank_A: [0.4, 0.15, 1.5],
  Wood_Planks_Stack_Small: [0.85, 0.32, 1.6],
  Wood_Planks_Stack_Medium: [1.67, 0.62, 1.62],
  Wood_Planks_Stack_Large: [1.67, 1.22, 1.62],
  Gold_Bar: [0.4, 0.25, 0.8],
  Gold_Bars: [1.27, 0.79, 0.91],
  Gold_Bars_Stack_Medium: [0.8, 1.5, 0.8],
  Gold_Bars_Stack_Large: [1.66, 1.5, 1.68],
};

vi.mock('./assets', () => ({
  glbCarryProp: () => null,
  hasGlbProp: (prop: string) => prop.replace('resources/', '') in SIZES,
  glbPropAtScale: (prop: string, scale: number) => {
    const name = prop.replace('resources/', '');
    const size = SIZES[name];
    if (!size) return null;
    const box = new THREE.Mesh(new THREE.BoxGeometry(...size));
    box.position.y = size[1] / 2;
    const g = new THREE.Group();
    g.name = name;
    g.scale.setScalar(scale);
    g.add(box);
    return g;
  },
  makeGlbBuilding: () => null,
}));

/** A pile read back as how many of each prop it was laid from. */
function census(pile: THREE.Group): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of pile.children) out[c.name] = (out[c.name] ?? 0) + 1;
  return out;
}

describe('a counted pile', () => {
  it('is loose boards until there are enough to band', () => {
    expect(census(makeTieredPile(GoodId.wood, 3)!)).toEqual({
      Wood_Plank_A: 3,
    });
    expect(census(makeTieredPile(GoodId.wood, 4)!)).toEqual({
      Wood_Planks_Stack_Small: 1,
    });
  });

  it('is the fewest bundles that hold the count, and the rest loose', () => {
    // 5 = a banded four and one board; 20 = sixteen and four; 37 = thirty-
    // two, a banded four and one board.
    expect(census(makeTieredPile(GoodId.wood, 5)!)).toEqual({
      Wood_Planks_Stack_Small: 1,
      Wood_Plank_A: 1,
    });
    expect(census(makeTieredPile(GoodId.wood, 20)!)).toEqual({
      Wood_Planks_Stack_Medium: 1,
      Wood_Planks_Stack_Small: 1,
    });
    expect(census(makeTieredPile(GoodId.wood, 37)!)).toEqual({
      Wood_Planks_Stack_Large: 1,
      Wood_Planks_Stack_Small: 1,
      Wood_Plank_A: 1,
    });
    // Bars run bar, roped six, tower of twelve, block of forty-eight.
    expect(census(makeTieredPile(GoodId.gold, 47)!)).toEqual({
      Gold_Bars_Stack_Medium: 3,
      Gold_Bars: 1,
      Gold_Bar: 5,
    });
  });

  it('sets a repeat bundle on the one before, unless it rests nothing', () => {
    // Two 32-stacks: the second sits on the first.
    const wood = makeTieredPile(GoodId.wood, 64)!;
    const [a, b] = wood.children;
    expect(b!.position.x).toBeCloseTo(a!.position.x);
    expect(b!.position.z).toBeCloseTo(a!.position.z);
    expect(b!.position.y).toBeGreaterThan(0.2);
    // Three towers of bars: two side by side, the third in a row of its own
    // out from the wall, all on the ground.
    const towers = makeTieredPile(GoodId.gold, 36)!.children;
    expect(towers.map(t => t.position.y)).toEqual([0, 0, 0]);
    expect(towers[0]!.position.z).toBeCloseTo(towers[1]!.position.z);
    expect(towers[0]!.position.x).toBeLessThan(towers[1]!.position.x);
    expect(towers[2]!.position.z).toBeGreaterThan(towers[0]!.position.z);
    expect(towers[2]!.position.x).toBeCloseTo(0);
  });

  it('keeps every unit, splitting into piles a lane each', () => {
    expect(laneCap(GoodId.gold)).toBe(48);
    expect(pileChunks(GoodId.gold, 100)).toEqual([48, 48, 4]);
    expect(pileChunks(GoodId.wood, 64)).toEqual([64]);
    // Heaped goods: three layers of three to a pile.
    expect(pileChunks(GoodId.wheat, 20)).toEqual([9, 9, 2]);
    expect(pileChunks(GoodId.wheat, 0)).toEqual([]);
  });
});
