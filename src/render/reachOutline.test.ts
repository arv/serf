import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { DEFAULT_MAP_SIZE, tileCount, tileIdx } from '../shared/grid';
import { HeightField } from './heightField';
import { SelectedReach } from './reachOutline';
import { buildingDef, gatherOrigin, gatherRecipeOf } from '../sim/defs/buildings';
import type { MapView, TileResourceKind } from '../sim/map';
import { verdictBad, verdictGood } from './palette';
import type { BuildingSnap } from '../protocol/messages';
import * as BuildingTypeId from '../sim/defs/buildingTypeIdEnum.ts';
import * as TileResource from '../sim/tileResourceEnum.ts';
import * as BuildingState from '../sim/buildingStateEnum.ts';

const SIZE = DEFAULT_MAP_SIZE;

/** A bare grid, playable edge to edge, with nothing standing on it. */
function emptyMap(): MapView {
  const n = tileCount(SIZE);
  return {
    size: SIZE,
    play: SIZE,
    terrain: new Uint8Array(n),
    resource: new Uint8Array(n),
    blocked: new Uint8Array(n),
    buildingAt: new Int16Array(n).fill(-1),
    pathLevel: new Uint8Array(n),
    height: new Float32Array(n),
  };
}

/** Put one workable tile just outside the building's footprint. */
function seed(map: MapView, b: BuildingSnap, resource: TileResourceKind): void {
  const origin = gatherOrigin(buildingDef(b.type), b.x, b.y);
  map.resource[tileIdx(origin.x + 2, origin.y + 2, SIZE)] = resource;
}

/** The band's current color, as a hex. */
function color(scene: THREE.Scene): number {
  return (outline(scene)!.material as THREE.MeshBasicMaterial).color.getHex();
}

function snap(over: Partial<BuildingSnap>): BuildingSnap {
  return {
    id: 7,
    type: BuildingTypeId.woodcutter,
    owner: 0,
    x: 10,
    y: 10,
    w: 2,
    h: 2,
    hp: 150,
    maxHp: 150,
    state: BuildingState.built,
    stock: {},
    inputs: {},
    inbound: {},
    reservedOut: {},
    ...over,
  };
}

function makeReach(): { reach: SelectedReach; scene: THREE.Scene; map: MapView } {
  const scene = new THREE.Scene();
  return {
    reach: new SelectedReach(scene, new HeightField(new Float32Array(tileCount(SIZE)), SIZE)),
    scene,
    map: emptyMap(),
  };
}

/** The outline is the only mesh this class ever adds to the scene. */
function outline(scene: THREE.Scene): THREE.Mesh | undefined {
  return scene.children.find((c): c is THREE.Mesh => c instanceof THREE.Mesh);
}

describe('the reach outline of a selected building', () => {
  it('appears for a gatherer and clears when the selection does', () => {
    const { reach, scene, map } = makeReach();
    reach.update(snap({ type: BuildingTypeId.woodcutter }), map);
    expect(outline(scene)?.visible).toBe(true);
    reach.update(null, map);
    expect(outline(scene)).toBeUndefined();
  });

  it('stays away for buildings that work no land', () => {
    const { reach, scene, map } = makeReach();
    reach.update(snap({ type: BuildingTypeId.brewery }), map);
    expect(outline(scene)).toBeUndefined();
  });

  it('clears when the selection moves on to a building that works none', () => {
    const { reach, scene, map } = makeReach();
    reach.update(snap({ id: 1, type: BuildingTypeId.woodcutter }), map);
    reach.update(snap({ id: 2, type: BuildingTypeId.brewery }), map);
    expect(outline(scene)).toBeUndefined();
  });

  it('reads green over ground that still holds something to work', () => {
    const { reach, scene, map } = makeReach();
    const hut = snap({ type: BuildingTypeId.woodcutter });
    seed(map, hut, TileResource.Wood);
    reach.update(hut, map);
    expect(color(scene)).toBe(verdictGood);
  });

  it('reads red when nothing in reach is left', () => {
    const { reach, scene, map } = makeReach();
    reach.update(snap({ type: BuildingTypeId.woodcutter }), map);
    expect(color(scene)).toBe(verdictBad);
  });

  it('ignores a resource the building does not work', () => {
    const { reach, scene, map } = makeReach();
    const mine = snap({ type: BuildingTypeId.ironMine });
    seed(map, mine, TileResource.Wood);
    reach.update(mine, map);
    expect(color(scene)).toBe(verdictBad);
  });

  it('turns red under a standing selection as the last tile runs out', () => {
    const { reach, scene, map } = makeReach();
    const hut = snap({ type: BuildingTypeId.woodcutter });
    seed(map, hut, TileResource.Wood);
    reach.update(hut, map);
    expect(color(scene)).toBe(verdictGood);
    // The worker fells the last tree in reach: the sim clears the tile's
    // resource code, and the same selection must go red without being
    // re-clicked.
    map.resource.fill(0);
    reach.update(hut, map);
    expect(color(scene)).toBe(verdictBad);
  });

  it('follows the selection from one gatherer to the next', () => {
    const { reach, scene, map } = makeReach();
    reach.update(snap({ id: 1, type: BuildingTypeId.woodcutter, x: 10, y: 10 }), map);
    const woodcutter = outline(scene)!.geometry.getAttribute('position').array.slice();
    reach.update(snap({ id: 2, type: BuildingTypeId.ironMine, x: 40, y: 40, w: 2, h: 2 }), map);
    const mine = outline(scene)!.geometry.getAttribute('position').array;
    expect([...mine]).not.toEqual([...woodcutter]);
    // Different radii too, so the mine's square is the smaller one.
    const woodRadius = gatherRecipeOf(buildingDef(BuildingTypeId.woodcutter))!.radius;
    const mineRadius = gatherRecipeOf(buildingDef(BuildingTypeId.ironMine))!.radius;
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
