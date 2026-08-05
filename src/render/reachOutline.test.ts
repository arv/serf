import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { TILE_COUNT } from '../shared/grid';
import { HeightField } from './heightField';
import { SelectedReach } from './reachOutline';
import { buildingDef, gatherRecipeOf } from '../sim/defs/buildings';
import type { BuildingSnap } from '../protocol/messages';

function snap(over: Partial<BuildingSnap>): BuildingSnap {
  return {
    id: 7,
    type: 'woodcutter',
    owner: 0,
    x: 10,
    y: 10,
    w: 2,
    h: 2,
    hp: 150,
    maxHp: 150,
    state: 'built',
    stock: {},
    inputs: {},
    inbound: {},
    reservedOut: {},
    ...over,
  };
}

function makeReach(): { reach: SelectedReach; scene: THREE.Scene } {
  const scene = new THREE.Scene();
  return { reach: new SelectedReach(scene, new HeightField(new Float32Array(TILE_COUNT))), scene };
}

/** The outline is the only mesh this class ever adds to the scene. */
function outline(scene: THREE.Scene): THREE.Mesh | undefined {
  return scene.children.find((c): c is THREE.Mesh => c instanceof THREE.Mesh);
}

describe('the reach outline of a selected building', () => {
  it('appears for a gatherer and clears when the selection does', () => {
    const { reach, scene } = makeReach();
    reach.update(snap({ type: 'woodcutter' }));
    expect(outline(scene)?.visible).toBe(true);
    reach.update(null);
    expect(outline(scene)).toBeUndefined();
  });

  it('stays away for buildings that work no land', () => {
    const { reach, scene } = makeReach();
    reach.update(snap({ type: 'brewery' }));
    expect(outline(scene)).toBeUndefined();
  });

  it('follows the selection from one gatherer to the next', () => {
    const { reach, scene } = makeReach();
    reach.update(snap({ id: 1, type: 'woodcutter', x: 10, y: 10 }));
    const woodcutter = outline(scene)!.geometry.getAttribute('position').array.slice();
    reach.update(snap({ id: 2, type: 'ironMine', x: 40, y: 40, w: 2, h: 2 }));
    const mine = outline(scene)!.geometry.getAttribute('position').array;
    expect([...mine]).not.toEqual([...woodcutter]);
    // Different radii too, so the mine's square is the smaller one.
    const woodRadius = gatherRecipeOf(buildingDef('woodcutter'))!.radius;
    const mineRadius = gatherRecipeOf(buildingDef('ironMine'))!.radius;
    expect(mineRadius).toBeLessThan(woodRadius);
    expect(spanX(mine)).toBeCloseTo(spanX(woodcutter) - 2 * (woodRadius - mineRadius));
  });
});

/** Width of the drawn band, corner to corner. */
function spanX(pos: ArrayLike<number>): number {
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < pos.length; i += 3) {
    lo = Math.min(lo, pos[i]!);
    hi = Math.max(hi, pos[i]!);
  }
  return hi - lo;
}
